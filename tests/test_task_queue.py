"""task_queue 的状态流转与边界。"""

import pytest

from services import task_queue


def _status(conn, task_id):
    return conn.execute(
        "SELECT status, claimed_by, claimed_at, error_code FROM procure.tasks WHERE id=%s",
        (task_id,),
    ).fetchone()


def test_claim_returns_oldest_ready_with_products(conn, seed):
    env_id, inst_id, task_ids = seed
    task = task_queue.claim(conn, env_id, inst_id)
    assert task is not None
    assert task["id"] == task_ids[0], "应认领最早的一条 ready 任务"
    assert task["status"] == "claimed"
    assert task["claimed_by"] == inst_id
    assert task["products"] == [{"asin": "B0FB3VS68J", "quantity": 1}]


def test_claim_records_event(conn, seed):
    env_id, inst_id, _ = seed
    task = task_queue.claim(conn, env_id, inst_id)
    kinds = conn.execute(
        "SELECT kind FROM procure.task_events WHERE task_id=%s", (task["id"],)
    ).fetchall()
    assert [k["kind"] for k in kinds] == ["claimed"]


def test_claim_returns_none_when_no_ready(conn, seed):
    env_id, inst_id, _ = seed
    conn.execute("UPDATE procure.tasks SET status='pending'")
    assert task_queue.claim(conn, env_id, inst_id) is None


def test_claim_skips_other_env(conn, seed):
    env_id, inst_id, _ = seed
    other = conn.execute(
        "INSERT INTO procure.buyer_envs (code) VALUES ('env-999') RETURNING id"
    ).fetchone()
    assert task_queue.claim(conn, other["id"], inst_id) is None, "不应跨环境认领"


def test_release_returns_task_to_ready(conn, seed):
    env_id, inst_id, _ = seed
    task = task_queue.claim(conn, env_id, inst_id)
    assert task_queue.release(conn, task["id"], inst_id) is True
    row = _status(conn, task["id"])
    assert row["status"] == "ready"
    assert row["claimed_by"] is None and row["claimed_at"] is None


def test_release_is_noop_on_terminal_task(conn, seed):
    """迟到的 release 不能把已经完成的任务拉回队列 —— 那会导致重复下单。"""
    env_id, inst_id, _ = seed
    task = task_queue.claim(conn, env_id, inst_id)
    task_queue.complete(conn, task["id"], amazon_order_no="111-0000000-0000001")
    assert task_queue.release(conn, task["id"], inst_id) is False
    assert _status(conn, task["id"])["status"] == "purchased"


def test_fail_writes_structured_code(conn, seed):
    env_id, inst_id, _ = seed
    task = task_queue.claim(conn, env_id, inst_id)
    assert task_queue.fail(conn, task["id"], "OUT_OF_STOCK", instance_id=inst_id) is True
    row = _status(conn, task["id"])
    assert row["status"] == "exception"
    assert row["error_code"] == "OUT_OF_STOCK"
    ev = conn.execute(
        "SELECT kind, code FROM procure.task_events WHERE task_id=%s ORDER BY id",
        (task["id"],),
    ).fetchall()
    assert ev[-1] == {"kind": "error", "code": "OUT_OF_STOCK"}


def test_fail_to_manual(conn, seed):
    """可能已下单的失败必须转人工,不能自动重试。"""
    env_id, inst_id, _ = seed
    task = task_queue.claim(conn, env_id, inst_id)
    task_queue.fail(conn, task["id"], "ORDER_CONFIRM_TIMEOUT", to_manual=True)
    assert _status(conn, task["id"])["status"] == "manual"


def test_complete_backfills_order(conn, seed):
    env_id, inst_id, _ = seed
    task = task_queue.claim(conn, env_id, inst_id)
    ok = task_queue.complete(
        conn, task["id"], amazon_order_no="111-2223334-4445556",
        instance_id=inst_id,
        totals={"actual_total": "10.79", "actual_tax": "0.80", "payment_last4": "7883"},
    )
    assert ok is True
    row = conn.execute(
        "SELECT status, amazon_order_no, actual_total, payment_last4, purchased_at"
        "  FROM procure.tasks WHERE id=%s", (task["id"],),
    ).fetchone()
    assert row["status"] == "purchased"
    assert row["amazon_order_no"] == "111-2223334-4445556"
    assert str(row["actual_total"]) == "10.79"
    assert row["purchased_at"] is not None


def test_duplicate_amazon_order_no_is_rejected(conn, seed):
    """同一个 Amazon 单号不可能属于两条任务 —— 回填写错时库层直接拒绝。"""
    import psycopg

    env_id, inst_id, _ = seed
    t1 = task_queue.claim(conn, env_id, inst_id)
    task_queue.complete(conn, t1["id"], amazon_order_no="111-9999999-9999999")
    t2 = task_queue.claim(conn, env_id, inst_id)
    with pytest.raises(psycopg.errors.UniqueViolation):
        task_queue.complete(conn, t2["id"], amazon_order_no="111-9999999-9999999")


def test_complete_only_from_claimed(conn, seed):
    env_id, inst_id, task_ids = seed
    # 没认领就完成 → 不应生效
    assert task_queue.complete(conn, task_ids[0], amazon_order_no="111-1-1") is False
    assert _status(conn, task_ids[0])["status"] == "ready"


def test_sweep_stale_moves_to_manual_not_ready(conn, seed):
    """超时任务转 manual 而不是退回 ready:插件可能已经真下了单。"""
    env_id, inst_id, _ = seed
    task = task_queue.claim(conn, env_id, inst_id)
    conn.execute(
        "UPDATE procure.tasks SET claimed_at = now() - interval '30 min' WHERE id=%s",
        (task["id"],),
    )
    ids = task_queue.sweep_stale(conn, timeout_minutes=15)
    assert ids == [task["id"]]
    row = _status(conn, task["id"])
    assert row["status"] == "manual"
    assert row["error_code"] == "CLAIM_TIMEOUT"


def test_sweep_leaves_fresh_claims_alone(conn, seed):
    env_id, inst_id, _ = seed
    task = task_queue.claim(conn, env_id, inst_id)
    assert task_queue.sweep_stale(conn, timeout_minutes=15) == []
    assert _status(conn, task["id"])["status"] == "claimed"


# ── 日限 ────────────────────────────────────────────────────────────────

def test_daily_cap_stops_dispatch(conn, seed):
    """daily_cap 之前只存不用:建表有这一列、后台展示它、docs/01 §5.3 把它列为一条护栏,
    而 CLAIM_SQL 里一行实现都没有。

    防关联场景下「一个号一天买太多」本身就是风控信号,这是最基本的一条闸。
    """
    from services import task_queue

    env_id, inst_id, task_ids = seed
    conn.execute("UPDATE procure.buyer_envs SET daily_cap = 1 WHERE id = %s", (env_id,))

    first = task_queue.claim(conn, env_id, inst_id)
    assert first is not None
    task_queue.complete(conn, first["id"], amazon_order_no="111-0000041-0000041",
                        instance_id=inst_id, totals={})

    # 今天已经拍成 1 单,额度用完
    assert task_queue.claim(conn, env_id, inst_id) is None


def test_daily_cap_zero_means_unlimited(conn, seed):
    from services import task_queue

    env_id, inst_id, _ = seed
    conn.execute("UPDATE procure.buyer_envs SET daily_cap = 0 WHERE id = %s", (env_id,))
    first = task_queue.claim(conn, env_id, inst_id)
    task_queue.complete(conn, first["id"], amazon_order_no="111-0000042-0000042",
                        instance_id=inst_id, totals={})
    assert task_queue.claim(conn, env_id, inst_id) is not None


def test_daily_cap_counts_only_today(conn, seed):
    """昨天拍的不占今天的额度。"""
    from services import task_queue

    env_id, inst_id, task_ids = seed
    conn.execute("UPDATE procure.buyer_envs SET daily_cap = 1 WHERE id = %s", (env_id,))
    conn.execute("""UPDATE procure.tasks SET status='purchased',
                           amazon_order_no='111-0000043-0000043',
                           purchased_at = now() - interval '1 day' WHERE id = %s""",
                 (task_ids[0],))
    assert task_queue.claim(conn, env_id, inst_id) is not None
