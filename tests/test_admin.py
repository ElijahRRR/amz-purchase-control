"""运营台接口:列表查询、批量单号、四个人工动作、实例判活。

这些是设计画布上标着「画了但还没落到代码里」的那一批(docs/03 §5)。
"""

import pytest


def _set(conn, task_id, **cols):
    sets = ", ".join(f"{k} = %({k})s" for k in cols)
    conn.execute(f"UPDATE procure.tasks SET {sets} WHERE id = %(id)s", {**cols, "id": task_id})


# ── 列表查询 ────────────────────────────────────────────────────────────

def test_search_by_status(client, conn, seed):
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="manual", error_code="PRICE_CAP_EXCEEDED")
    conn.commit()

    r = client.post("/v1/admin/tasks/search", json={"status": "manual"})
    data = r.json()["data"]
    assert data["total"] == 1
    assert data["items"][0]["status"] == "manual"
    # 商品一并带出来,列表里 ASIN 左边那张图要用 image_url
    assert data["items"][0]["products"][0]["asin"] == "B0FB3VS68J"


def test_search_by_purchased_date_drops_unpurchased(client, conn, seed):
    """按采购时间筛,本来就是在问「哪些单已经买了」。没下过单的行不在这个维度上。"""
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="purchased", amazon_order_no="111-0000001-0000001",
         purchased_at="now()")
    conn.execute("UPDATE procure.tasks SET purchased_at = now() WHERE id = %s", (tasks[0],))
    conn.commit()

    r = client.post("/v1/admin/tasks/search", json={"date_field": "purchased"})
    data = r.json()["data"]
    assert data["total"] == 1
    assert data["items"][0]["id"] == tasks[0]


def test_search_by_order_numbers_mixes_both_kinds_and_reports_misses(client, conn, seed):
    """两种号混着粘会自动分流;一个都没匹配上的号必须原样报回去。

    厂商面板在这里是静默的 —— 粘 100 个号回来 87 条,运营不会知道少了哪 13 个。
    """
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="purchased", amazon_order_no="111-4820193-7736514")
    conn.commit()

    r = client.post("/v1/admin/tasks/search", json={
        "order_numbers": ["111-4820193-7736514", "UP-1", "111-9999999-9999999", "UP-NOPE"],
        # 状态与时间都给上,验证单号确实盖过它们
        "status": "ready", "date_field": "purchased",
    })
    data = r.json()["data"]
    assert data["by_order_number"] is True
    got = sorted(i["upstream_order_no"] for i in data["items"])
    assert got == ["UP-0", "UP-1"]          # 一个按 AMZ 号命中,一个按上游号命中
    assert sorted(data["missing_order_numbers"]) == ["111-9999999-9999999", "UP-NOPE"]


def test_search_pagination(client, conn, seed):
    r = client.post("/v1/admin/tasks/search", json={"page": 1, "page_size": 2})
    data = r.json()["data"]
    assert data["total"] == 3 and len(data["items"]) == 2
    r2 = client.post("/v1/admin/tasks/search", json={"page": 2, "page_size": 2})
    assert len(r2.json()["data"]["items"]) == 1


def test_search_page_size_is_capped(client, seed):
    """厂商面板给了 1000~5000 条每页的选项,那不是给人看的。"""
    r = client.post("/v1/admin/tasks/search", json={"page_size": 100000})
    assert r.json()["data"]["page_size"] == 200


def test_detail_has_products_events_and_shipment_slot(client, conn, seed):
    _env, _inst, tasks = seed
    from services import task_event
    task_event.record(conn, tasks[0], "step", payload={"step": "清空购物车"})
    conn.commit()

    d = client.get(f"/v1/admin/tasks/{tasks[0]}").json()["data"]
    assert d["env_code"] == "env-172"
    assert d["products"][0]["asin"] == "B0FB3VS68J"
    assert d["events"][-1]["payload"]["step"] == "清空购物车"
    assert d["shipment"] is None


def test_detail_404(client, seed):
    r = client.get("/v1/admin/tasks/999999")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "TASK_NOT_FOUND"


# ── 重置回队列 ──────────────────────────────────────────────────────────

def test_reset_exception_goes_straight_back(client, conn, seed):
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="exception", error_code="OUT_OF_STOCK")
    conn.commit()

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/reset", json={})
    assert r.json()["data"]["status"] == "ready"


def test_reset_refuses_possibly_ordered_without_ack(client, conn, seed):
    """CLAIM_TIMEOUT 意味着这一单可能已经真下成了。

    直接重置就是让下一个实例把同一单再买一遍 —— 必须先有人去买家号里确认过。
    """
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="manual", error_code="CLAIM_TIMEOUT")
    conn.commit()

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/reset", json={})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "NEEDS_ACK"
    # 拒绝之后状态不能被动过
    row = conn.execute("SELECT status FROM procure.tasks WHERE id = %s", (tasks[0],)).fetchone()
    assert row["status"] == "manual"


def test_reset_with_ack_allowed_and_leaves_a_trace(client, conn, seed):
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="manual", error_code="ORDER_NO_AMBIGUOUS")
    conn.commit()

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/reset",
                    json={"acknowledged": True, "operator": "ops-wang"})
    assert r.json()["data"]["status"] == "ready"

    ev = conn.execute(
        "SELECT kind, payload FROM procure.task_events WHERE task_id = %s ORDER BY id DESC LIMIT 1",
        (tasks[0],)).fetchone()
    assert ev["kind"] == "admin"
    assert ev["payload"]["action"] == "reset_to_queue"
    assert ev["payload"]["acknowledged"] is True
    assert ev["payload"]["operator"] == "ops-wang"


def test_reset_refuses_from_ready(client, seed):
    _env, _inst, tasks = seed
    r = client.post(f"/v1/admin/tasks/{tasks[0]}/reset", json={})
    assert r.status_code == 409 and r.json()["error"]["code"] == "BAD_STATUS"


# ── 强制回填单号 ────────────────────────────────────────────────────────

def test_force_backfill_needs_a_note(client, conn, seed):
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="manual", error_code="ORDER_NO_AMBIGUOUS")
    conn.commit()

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/force-backfill",
                    json={"amazon_order_no": "111-4820193-7736514", "note": "  "})
    assert r.status_code == 409 and r.json()["error"]["code"] == "NOTE_REQUIRED"


def test_force_backfill_writes_and_records_that_assertion_was_skipped(client, conn, seed):
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="manual", error_code="ORDER_NO_AMBIGUOUS")
    conn.commit()

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/force-backfill", json={
        "amazon_order_no": "111-4820193-7736514",
        "note": "已在 env-172 订单历史里核对过,就是这一单", "operator": "ops-wang"})
    assert r.json()["data"]["status"] == "purchased"

    row = conn.execute(
        "SELECT status, amazon_order_no, purchased_at, error_code FROM procure.tasks WHERE id = %s",
        (tasks[0],)).fetchone()
    assert row["amazon_order_no"] == "111-4820193-7736514"
    assert row["purchased_at"] is not None
    assert row["error_code"] is None

    ev = conn.execute(
        "SELECT payload FROM procure.task_events WHERE task_id = %s ORDER BY id DESC LIMIT 1",
        (tasks[0],)).fetchone()
    assert ev["payload"]["assertion_skipped"] is True
    assert "核对过" in ev["payload"]["note"]


def test_force_backfill_refuses_duplicate_order_no(client, conn, seed):
    """同一个 AMZ 单号不可能落到两条任务上。库层有部分唯一索引,这里先给人话。"""
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="purchased", amazon_order_no="111-4820193-7736514")
    _set(conn, tasks[1], status="manual", error_code="ORDER_NO_AMBIGUOUS")
    conn.commit()

    r = client.post(f"/v1/admin/tasks/{tasks[1]}/force-backfill", json={
        "amazon_order_no": "111-4820193-7736514", "note": "手滑填了同一个号"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "ORDER_NO_TAKEN"


def test_force_backfill_refuses_from_exception(client, conn, seed):
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="exception", error_code="OUT_OF_STOCK")
    conn.commit()
    r = client.post(f"/v1/admin/tasks/{tasks[0]}/force-backfill",
                    json={"amazon_order_no": "111-0000002-0000002", "note": "x"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "BAD_STATUS"


# ── 改地址 / 改 ASIN ────────────────────────────────────────────────────

def test_update_address_records_before_and_after(client, conn, seed):
    _env, _inst, tasks = seed
    r = client.post(f"/v1/admin/tasks/{tasks[0]}/address",
                    json={"ship_city": "Irvine", "ship_postcode": "92602"})
    assert sorted(r.json()["data"]["changed"]) == ["ship_city", "ship_postcode"]

    ev = conn.execute(
        "SELECT payload FROM procure.task_events WHERE task_id = %s ORDER BY id DESC LIMIT 1",
        (tasks[0],)).fetchone()
    assert ev["payload"]["before"]["ship_city"] == "Santa Ana"
    assert ev["payload"]["after"]["ship_city"] == "Irvine"


def test_update_address_refused_after_purchase(client, conn, seed):
    """货已经在路上了,改库里的地址只会让库和现实对不上。"""
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="purchased", amazon_order_no="111-0000003-0000003")
    conn.commit()
    r = client.post(f"/v1/admin/tasks/{tasks[0]}/address", json={"ship_city": "Irvine"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "BAD_STATUS"


def test_update_asin_keeps_line_key(client, conn, seed):
    """line_key 是导入期的去重键,不是内容摘要 —— 改 ASIN 不重算它。"""
    _env, _inst, tasks = seed
    before = conn.execute("SELECT line_key FROM procure.tasks WHERE id = %s",
                          (tasks[0],)).fetchone()["line_key"]

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/asin",
                    json={"old_asin": "B0FB3VS68J", "new_asin": "B0NEWASIN1"})
    assert r.json()["data"]["asin"] == "B0NEWASIN1"

    after = conn.execute("SELECT line_key FROM procure.tasks WHERE id = %s",
                         (tasks[0],)).fetchone()["line_key"]
    assert after == before


def test_update_asin_unknown(client, seed):
    _env, _inst, tasks = seed
    r = client.post(f"/v1/admin/tasks/{tasks[0]}/asin",
                    json={"old_asin": "B0NOTHERE1", "new_asin": "B0NEWASIN1"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "ASIN_NOT_FOUND"


# ── 实例判活 ────────────────────────────────────────────────────────────

def test_instances_liveness(client, conn, seed):
    """never / online / stale / paused 四态是算出来的,库里没有这一列。"""
    env_id, inst_id, _tasks = seed

    # 从来没心跳过 → never
    rows = client.get("/v1/admin/instances").json()["data"]["items"]
    assert rows[0]["liveness"] == "never"
    assert rows[0]["dispatchable"] is False

    # 刚心跳过 → online
    conn.execute("UPDATE procure.plugin_instances SET last_seen_at = now() WHERE id = %s",
                 (inst_id,))
    conn.commit()
    rows = client.get("/v1/admin/instances").json()["data"]["items"]
    assert rows[0]["liveness"] == "online" and rows[0]["dispatchable"] is True
    assert rows[0]["queue_depth"] == 3

    # 心跳老了 → stale(不是「坏了」,只是没消息)
    conn.execute("UPDATE procure.plugin_instances SET last_seen_at = now() - interval '10 minutes'"
                 " WHERE id = %s", (inst_id,))
    conn.commit()
    rows = client.get("/v1/admin/instances").json()["data"]["items"]
    assert rows[0]["liveness"] == "stale" and rows[0]["dispatchable"] is False

    # 运营手动停 → paused,盖过心跳
    conn.execute("UPDATE procure.plugin_instances SET last_seen_at = now() WHERE id = %s", (inst_id,))
    conn.execute("UPDATE procure.buyer_envs SET status = 'paused' WHERE id = %s", (env_id,))
    conn.commit()
    rows = client.get("/v1/admin/instances").json()["data"]["items"]
    assert rows[0]["liveness"] == "paused" and rows[0]["dispatchable"] is False


def test_detail_says_which_instance_executed_it_after_completion(client, conn, seed):
    """tasks.claimed_by 是**在途指针**,任务一落终态就清空。

    「此刻谁拿着」和「当初谁执行的」是两回事。设计画布上「买家号信息 · 认领实例」
    那一格要的是后者 —— 只看 claimed_by 的话,所有已完成的单那一格永远是空的,
    而已完成恰恰是最需要追「这单是哪台机器跑的」的时候。
    """
    from services import task_queue

    env_id, inst_id, _tasks = seed
    task = task_queue.claim(conn, env_id, inst_id)
    task_queue.complete(conn, task["id"], amazon_order_no="111-0000007-0000007",
                        instance_id=inst_id, totals={})
    conn.commit()

    d = client.get(f"/v1/admin/tasks/{task['id']}").json()["data"]
    assert d["status"] == "purchased"
    assert d["claimed_by_uid"] is None          # 在途指针已清空,这是对的
    assert d["executed_by_uid"] == "inst-A"     # 但历史还在
    assert any(e["kind"] == "claimed" and e["instance_uid"] == "inst-A" for e in d["events"])


def test_executed_by_takes_the_last_claim(client, conn, seed):
    """重置回队列后被另一个实例领走的话,最后那次才算数。"""
    from services import task_queue

    env_id, inst_id, _tasks = seed
    other = conn.execute(
        """INSERT INTO procure.plugin_instances (buyer_env_id, instance_uid)
           VALUES (%s,'inst-B') RETURNING id""", (env_id,)).fetchone()["id"]

    task = task_queue.claim(conn, env_id, inst_id)
    task_queue.fail(conn, task["id"], "OUT_OF_STOCK", instance_id=inst_id)
    conn.execute("UPDATE procure.tasks SET status='ready' WHERE id=%s", (task["id"],))
    again = task_queue.claim(conn, env_id, other)
    conn.commit()

    d = client.get(f"/v1/admin/tasks/{again['id']}").json()["data"]
    assert d["executed_by_uid"] == "inst-B"


def test_missing_order_numbers_looks_at_all_pages(client, conn, seed):
    """命中但落在页外的号不能被报成「没匹配上」。

    这个字段存在的意义是「别让运营以为都查到了」;反过来指着一张确实存在的单
    说查不到,比不报更坏 —— 人会去上游翻一遍,翻完发现单就在库里。
    """
    env_id, _inst, _tasks = seed
    nos = [f"PG-{i}" for i in range(60)]
    for i, no in enumerate(nos):
        conn.execute("""INSERT INTO procure.tasks
                          (line_key, upstream_order_no, buyer_env_id, ship_name, ship_phone,
                           ship_line1, ship_city, ship_state, ship_postcode, price_cap, status)
                        VALUES (%s,%s,%s,'N','1','1 A St','Santa Ana','CA','92707',10,'ready')""",
                     (f"pg-key-{i}", no, env_id))
    conn.commit()

    d = client.post("/v1/admin/tasks/search",
                    json={"order_numbers": nos, "page_size": 50}).json()["data"]
    assert d["total"] == 60
    assert len(d["items"]) == 50           # 这一页只有 50 条
    assert d["missing_order_numbers"] == []  # 但一个都不缺


def test_meta_serves_the_closed_sets_so_the_web_needs_no_copy(client):
    d = client.get("/v1/admin/meta").json()["data"]
    from services import error_codes, vocab

    assert d["task_status"]["labels"] == vocab.STATUS_LABELS
    assert set(d["task_status"]["labels"]) == set(vocab.STATUS_TONE)
    assert d["error_code"]["labels"] == error_codes.LABELS
    assert set(d["error_code"]["labels"]) == set(error_codes.ERROR_CODES)


def test_status_labels_cover_every_status_in_the_schema():
    """schema.sql 里注释着的 7 个状态,vocab 必须一个不落。

    少一个的话界面上会直接显示英文枚举值 —— 而运营看不懂 `exception`,
    他们看得懂「拍单异常」。
    """
    import re

    from registry import paths
    from services import vocab

    sql = (paths.repo_root() / "refdata" / "schema.sql").read_text(encoding="utf-8")
    block = sql[sql.index("status            text NOT NULL DEFAULT 'pending'"):]
    block = block[:block.index("(封闭集)")]
    in_sql = set(re.findall(r"^\s+--\s+(\w+)\s", block, re.M))
    assert in_sql == set(vocab.STATUS_LABELS), (
        f"只在 schema:{sorted(in_sql - set(vocab.STATUS_LABELS))};"
        f"只在 vocab:{sorted(set(vocab.STATUS_LABELS) - in_sql)}")


# ── 状态桶计数与错误码分布 ────────────────────────────────────────────────

def test_summary_reports_every_status_including_the_empty_ones(client, conn, seed):
    """空桶要给 0,不能不出现。

    SQL 的 GROUP BY 只吐有行的状态,照直用会让「拍单异常」在清零时从界面上消失 ——
    而「异常 0」正是运营最想看到的那句话,让它消失等于把好消息也藏了。
    """
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="manual", error_code="ORDER_NO_AMBIGUOUS")
    conn.commit()

    data = client.get("/v1/admin/summary").json()["data"]
    by = data["by_status"]

    from services import vocab
    assert set(by) == set(vocab.STATUS_LABELS), "七个状态一个都不能少"
    assert by["manual"] == 1
    assert by["ready"] == 2
    assert by["exception"] == 0          # ← 这一条正是本用例存在的理由


def test_summary_counts_follow_the_same_filters_as_the_list(client, conn, seed):
    """筛了买家号之后那排数字不能还是全局的 —— 点进去数量对不上,像是界面丢了单。"""
    _env, _inst, _tasks = seed
    other = conn.execute(
        "INSERT INTO procure.buyer_envs (code) VALUES ('env-999') RETURNING id").fetchone()
    conn.execute(
        """INSERT INTO procure.tasks
             (line_key, upstream_order_no, buyer_env_id, ship_name, ship_phone,
              ship_line1, ship_city, ship_state, ship_postcode, price_cap, status)
           VALUES ('key-x','UP-X',%s,'N','1','1 St','SA','CA','92707',9.99,'ready')""",
        (other["id"],))
    conn.commit()

    everything = client.get("/v1/admin/summary").json()["data"]
    scoped = client.get("/v1/admin/summary", params={"env_code": "env-172"}).json()["data"]
    assert everything["by_status"]["ready"] == 4
    assert scoped["by_status"]["ready"] == 3

    # 与列表口径一致:同样的条件,列表数出来的总数要对得上
    listed = client.post("/v1/admin/tasks/search",
                         json={"status": "ready", "env_code": "env-172"}).json()["data"]
    assert listed["total"] == scoped["by_status"]["ready"]


def test_summary_top_bar_numbers_stay_global(client, conn, seed):
    """顶栏那两个数字回答的是「今天整体怎么样」,筛掉一半再报数就不是那个问题的答案。"""
    _env, _inst, _tasks = seed
    other = conn.execute(
        "INSERT INTO procure.buyer_envs (code) VALUES ('env-888') RETURNING id").fetchone()
    conn.execute(
        """INSERT INTO procure.tasks
             (line_key, upstream_order_no, buyer_env_id, ship_name, ship_phone,
              ship_line1, ship_city, ship_state, ship_postcode, price_cap, status)
           VALUES ('key-y','UP-Y',%s,'N','1','1 St','SA','CA','92707',9.99,'ready')""",
        (other["id"],))
    conn.commit()

    scoped = client.get("/v1/admin/summary", params={"env_code": "env-172"}).json()["data"]
    assert scoped["by_status"]["ready"] == 3     # 桶跟着筛
    assert scoped["queue_depth"] == 4            # 顶栏不跟


def test_error_stats_splits_by_env_and_by_day(client, conn, seed):
    """分买家号是为了看出「是不是某一台机器的问题」(比如某个买家号被风控了)。"""
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="manual", error_code="ORDER_NO_AMBIGUOUS")
    _set(conn, tasks[1], status="exception", error_code="PRICE_CAP_EXCEEDED")
    _set(conn, tasks[2], status="exception", error_code="PRICE_CAP_EXCEEDED")
    conn.commit()

    data = client.get("/v1/admin/error-stats").json()["data"]
    assert data["total"] == 3
    top = data["items"][0]
    assert top["code"] == "PRICE_CAP_EXCEEDED" and top["n"] == 2
    assert top["by_env"] == {"env-172": 2}
    assert sum(p["n"] for p in data["trend"]) == 3


def test_error_stats_ignores_rows_without_a_code(client, conn, seed):
    """没出过错的行不该进分布图 —— 那张图是用来找卡点的,不是统计总量的。"""
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="purchased", amazon_order_no="111-0000001-0000001")
    conn.commit()
    assert client.get("/v1/admin/error-stats").json()["data"]["total"] == 0


def test_list_does_not_duplicate_a_task_that_synced_twice(client, conn, seed):
    """一单同步过两次轨迹,列表里还是一行。

    列表为了「详细」密度要带物流列,拿的是 LEFT JOIN LATERAL 的最后一条。
    换成普通 JOIN 的话,这条任务会裂成两行,`total` 也跟着虚高 ——
    运营看到的「待处理 41」就不再是 41 张单。
    """
    _env, _inst, tasks = seed
    for tracking in ("1Z-OLD", "1Z-NEW"):
        conn.execute(
            "INSERT INTO logistics.shipments (task_id, carrier, tracking_no, status)"
            " VALUES (%s,'UPS',%s,'in_transit')", (tasks[0], tracking))
    conn.commit()

    data = client.post("/v1/admin/tasks/search", json={}).json()["data"]
    assert data["total"] == 3
    rows = [i for i in data["items"] if i["id"] == tasks[0]]
    assert len(rows) == 1
    assert rows[0]["tracking_no"] == "1Z-NEW"      # 取最后一条,不是第一条


# ── 工作流运行记录 ──────────────────────────────────────────────────────

def test_runs_lists_every_workflow_including_the_ones_never_run(client, conn):
    """从没跑过的工作流也要出现。

    一条从没跑过的 task_sweep 在「最近运行」列表里是看不见的(它没有行),
    而那恰恰是最该报警的情况 —— claimed 的任务会一直堆着没人清扫。
    """
    conn.execute("""INSERT INTO ops.runs (workflow, params, started_at, finished_at,
                                          status, summary, operator)
                    VALUES ('task_intake','{}'::jsonb, now() - interval '5 minutes',
                            now(), 'success','落库 3 行','manual')""")
    conn.commit()

    data = client.get("/v1/admin/runs").json()["data"]
    names = {r["workflow"] for r in data["by_workflow"]}
    assert "task_sweep" in names and "task_intake" in names and "db_init" in names

    swept = next(r for r in data["by_workflow"] if r["workflow"] == "task_sweep")
    assert swept["last"] is None and swept["age_seconds"] is None

    intook = next(r for r in data["by_workflow"] if r["workflow"] == "task_intake")
    assert intook["last"]["status"] == "success"
    assert intook["age_seconds"] >= 280           # 5 分钟前跑的


def test_runs_marks_a_run_that_started_and_never_reported_back(client, conn):
    """停在 running 又超时的,不是「在跑」,是「开跑后再没消息」。

    这两种在界面上必须分开:一个是等它,一个是去查它。
    进程被杀(容器回收、OOM)就是这个样子 —— 早先 ops.runs 是跑完才写的,
    那种运行在库里跟「从来没跑过」一模一样。
    """
    conn.execute("""INSERT INTO ops.runs (workflow, params, started_at, status, operator)
                    VALUES ('task_sweep','{}'::jsonb, now() - interval '3 hours',
                            'running','cron')""")
    conn.execute("""INSERT INTO ops.runs (workflow, params, started_at, status, operator)
                    VALUES ('task_intake','{}'::jsonb, now() - interval '10 seconds',
                            'running','manual')""")
    conn.commit()

    items = {r["workflow"]: r for r in client.get("/v1/admin/runs").json()["data"]["items"]}
    assert items["task_sweep"]["stuck"] is True     # 3 小时前开跑,没了下文
    assert items["task_intake"]["stuck"] is False   # 10 秒前开跑,还在跑


def test_cli_writes_a_running_row_before_the_workflow_finishes(conn, monkeypatch, tmp_path):
    """开跑就写一行,不是等跑完再补。

    早先是跑完才 INSERT,后果是进程中途被杀(容器回收、OOM、机器重启)
    一行都不写 —— 挂死的运行在库里跟「从来没跑过」一模一样。
    schema 里 status 的封闭集本来就写着 running,只是从来没人写过这个值。
    """
    import cli

    seen: dict = {}

    def fake_run(params):
        # 工作流跑到一半时,库里应该已经有一行 running 了
        rows = conn.execute(
            "SELECT workflow, status, finished_at FROM ops.runs ORDER BY id"
        ).fetchall()
        seen["mid"] = [dict(r) for r in rows]
        return "跑完了"

    module = type("M", (), {"run": staticmethod(fake_run)})
    monkeypatch.setattr(cli.importlib, "import_module", lambda name: module)

    ok, summary = cli._run_one("task_sweep", {"dry_run": False})
    assert ok and summary == "跑完了"

    # 跑到一半那一刻:已经有行,状态 running,还没有 finished_at
    assert len(seen["mid"]) == 1
    assert seen["mid"][0]["status"] == "running"
    assert seen["mid"][0]["finished_at"] is None

    # 跑完之后:同一行被改成 success,没有多出第二行
    after = [dict(r) for r in conn.execute(
        "SELECT status, summary, finished_at FROM ops.runs").fetchall()]
    assert len(after) == 1, "跑完应该是 UPDATE 同一行,不是再 INSERT 一行"
    assert after[0]["status"] == "success"
    assert after[0]["summary"] == "跑完了"
    assert after[0]["finished_at"] is not None


def test_every_workflow_declares_whether_it_should_be_scheduled(client, conn):
    """加了工作流却没声明「多久没跑算不正常」,在这里断。

    没有这张声明表,界面只能一视同仁地把「从没跑过」标红,于是 db_init
    (装机时跑一次的引导脚本)会永远红着。**一张永远红着的卡片会把人训练成
    忽略红色** —— 等 task_sweep 真的停了,那一格红得跟旁边那格一模一样。
    """
    from services import ops_query

    real = set(ops_query._workflow_names())
    declared = set(ops_query.EXPECTED_INTERVAL)
    assert real == declared, (
        f"没声明期望的:{sorted(real - declared)};声明了但文件不存在的:{sorted(declared - real)}")


def test_only_the_scheduled_workflow_goes_overdue_when_it_never_ran(client, conn):
    """按需跑的从没跑过 ≠ 异常;该定时的从没跑过 = 异常。"""
    data = client.get("/v1/admin/runs").json()["data"]
    by = {r["workflow"]: r for r in data["by_workflow"]}

    assert by["task_sweep"]["scheduled"] is True
    assert by["task_sweep"]["overdue"] is True      # 一次都没跑过,而它必须定时

    assert by["db_init"]["scheduled"] is False
    assert by["db_init"]["overdue"] is False        # 装机脚本没跑过是正常的
    assert by["task_intake"]["overdue"] is False


def test_a_scheduled_workflow_goes_overdue_when_it_stops_running(client, conn):
    """跑过、但停了太久,照样要红 —— 「跑过一次」不是永久的免死金牌。"""
    conn.execute("""INSERT INTO ops.runs (workflow, params, started_at, finished_at,
                                          status, summary, operator)
                    VALUES ('task_sweep','{}'::jsonb, now() - interval '5 hours',
                            now() - interval '5 hours', 'success','清扫完成:0 条','cron')""")
    conn.commit()
    by = {r["workflow"]: r
          for r in client.get("/v1/admin/runs").json()["data"]["by_workflow"]}
    assert by["task_sweep"]["last"]["status"] == "success"
    assert by["task_sweep"]["overdue"] is True, "5 小时前跑过一次,阈值是 2 小时"


# ── 导出 ────────────────────────────────────────────────────────────────

def test_export_covers_the_whole_filtered_set_not_just_one_page(client, conn, seed,
                                                                monkeypatch):
    """导的必须是整个筛选结果,不是当前这一页。

    只导一页是最阴的那种错:表看着完整、其实少了后面几千行,而且没有任何地方
    提示少了 —— 拿它去对账会得出一个错的结论。
    这里把每页压到 1 条,逼它必须翻页才拿得全。
    """
    from registry import settings

    monkeypatch.setattr(settings, "admin_page_size_max", lambda: 1)
    conn.commit()

    body = client.post("/v1/admin/tasks/export", json={}).text
    lines = [ln for ln in body.splitlines() if ln.strip()]
    assert len(lines) == 4, f"表头 + 3 行,拿到 {len(lines)} 行:{lines}"
    assert all(f"UP-{i}" in body for i in range(3))


def test_export_starts_with_a_bom_so_excel_does_not_mangle_chinese(client, conn, seed):
    """没有 BOM 的话 Excel 会把中文当 GBK,一表格乱码。

    这一个字节省下来没有任何好处,而少了它运营第一次打开就会来问。
    """
    body = client.post("/v1/admin/tasks/export", json={}).text
    assert body.startswith("﻿")
    assert "上游单号" in body and "整单限价" in body


def test_export_flattens_multi_product_orders_into_one_row_each(client, conn, seed):
    """一单多商品展开成多行 —— 表格软件里按 ASIN 筛的人要的就是这个。"""
    _env, _inst, tasks = seed
    conn.execute("INSERT INTO procure.task_products (task_id, asin, quantity)"
                 " VALUES (%s, 'B0SECOND01', 2)", (tasks[0],))
    conn.commit()

    body = client.post("/v1/admin/tasks/export", json={}).text
    lines = [ln for ln in body.splitlines() if ln.strip()]
    assert len(lines) == 5, "3 单,其中一单两个商品 → 4 行 + 表头"
    assert "B0SECOND01" in body


def test_export_marks_the_rows_that_went_over_the_cap(client, conn, seed):
    """超限价那一列比对着两个数字自己算要靠得住 —— 而且和界面上红色那条是同一个判据。"""
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="purchased", amazon_order_no="111-0000009-0000009",
         actual_total="99.99")          # price_cap 是 12.50
    conn.commit()

    body = client.post("/v1/admin/tasks/export", json={}).text
    over = [ln for ln in body.splitlines() if "111-0000009-0000009" in ln]
    assert len(over) == 1 and "是" in over[0]


# ── 批量重置 ────────────────────────────────────────────────────────────

def test_batch_reset_refuses_to_acknowledge_on_everyones_behalf(client, conn, seed):
    """批量重置**不接受 acknowledged,永远不接受**。

    单条那道 NEEDS_ACK 闸拦的是「这一单可能已经在 Amazon 上真下成了」,
    而回执的含义是有人去那个买家号的订单页看过了。一批 30 单给一个总的
    「已确认」,那句话就是假的 —— 没人一单一单看过 30 个订单页。
    真让它接受,这个按钮就从「省点击」变成「一键重复下单 30 次」。
    """
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="exception", error_code="CHECKOUT_TIMEOUT")
    _set(conn, tasks[1], status="manual", error_code="ORDER_NO_AMBIGUOUS")   # 可能已下单
    _set(conn, tasks[2], status="purchased", amazon_order_no="111-0000002-0000002")
    conn.commit()

    r = client.post("/v1/admin/tasks/batch-reset",
                    json={"task_ids": tasks, "acknowledged": True})   # ← 就算传了也没用
    data = r.json()["data"]

    assert data["counts"] == {"done": 1, "skipped": 1, "failed": 1}
    assert data["done"] == [tasks[0]]

    # 可能已下单的那条被原样报回来,带着错误码,让人一眼看出该先去哪儿确认
    assert data["skipped"][0]["task_id"] == tasks[1]
    assert data["skipped"][0]["error_code"] == "ORDER_NO_AMBIGUOUS"
    assert data["skipped"][0]["code"] == "NEEDS_ACK"

    # 已拍单的不能重置,这是「失败」不是「要你去看」——两者在界面上分开说
    assert data["failed"][0]["task_id"] == tasks[2]
    assert data["failed"][0]["code"] == "BAD_STATUS"

    # 库里也确实只动了一条
    got = {r["id"]: r["status"] for r in conn.execute(
        "SELECT id, status FROM procure.tasks").fetchall()}
    assert got[tasks[0]] == "ready"
    assert got[tasks[1]] == "manual"      # 没被顺手重置
    assert got[tasks[2]] == "purchased"


def test_batch_reset_does_not_let_one_bad_row_take_down_the_rest(client, conn, seed):
    """一条失败不牵连其它。

    批量动作里最难查的就是「前 12 条成了、第 13 条炸了、后面 17 条没跑」,
    而界面只说了一句「失败」。
    """
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="exception", error_code="CHECKOUT_TIMEOUT")
    _set(conn, tasks[2], status="exception", error_code="OUT_OF_STOCK")
    conn.commit()

    # 中间夹一个根本不存在的 id
    data = client.post("/v1/admin/tasks/batch-reset",
                       json={"task_ids": [tasks[0], 999999, tasks[2]]}).json()["data"]
    assert data["counts"]["done"] == 2, "不存在的那个不该挡住后面的"
    assert data["failed"][0]["code"] == "TASK_NOT_FOUND"


def test_batch_reset_route_is_not_swallowed_by_the_task_id_route(client, conn, seed):
    """`/tasks/batch-reset` 不能被 `/tasks/{task_id}/...` 吃掉。"""
    r = client.post("/v1/admin/tasks/batch-reset", json={"task_ids": [1]})
    assert r.status_code == 200 and r.json()["ok"] is True


def test_batch_reset_records_who_did_it_on_every_row(client, conn, seed):
    """批量也要逐条留痕 —— 事后查「这一批是谁点的」得答得上来。"""
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="exception", error_code="CHECKOUT_TIMEOUT")
    _set(conn, tasks[1], status="exception", error_code="OUT_OF_STOCK")
    conn.commit()

    client.post("/v1/admin/tasks/batch-reset",
                json={"task_ids": [tasks[0], tasks[1]], "operator": "小李"})
    rows = conn.execute(
        "SELECT payload FROM procure.task_events WHERE kind='admin' ORDER BY id").fetchall()
    assert len(rows) == 2
    assert all(r["payload"]["operator"] == "小李" for r in rows)
    assert all(r["payload"]["acknowledged"] is False for r in rows)


# ── 前端静态文件 ────────────────────────────────────────────────────────

def test_web_root_says_not_built_instead_of_a_bare_404(client, tmp_path, monkeypatch):
    """没构建过就明说,别静默 404 —— 404 会让人以为服务坏了,其实只是前端没 build。"""
    from server import app as app_mod

    monkeypatch.setattr(app_mod, "_WEB_DIST", tmp_path / "nope")
    r = client.get("/")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "WEB_NOT_BUILT"


def test_web_root_picks_up_a_build_that_appeared_after_startup(client, tmp_path, monkeypatch):
    """先起服务、再 build,刷新就该好 —— 不用重启。

    在 import 时定死的话,提示会让你去做的正是你刚做完的那件事,
    你得先知道要重启服务才想得通。
    """
    from server import app as app_mod

    dist = tmp_path / "dist"
    monkeypatch.setattr(app_mod, "_WEB_DIST", dist)
    assert client.get("/").status_code == 503        # 还没 build

    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<div id=root></div>", encoding="utf-8")
    (dist / "assets" / "index-abc123.js").write_text("console.log(1)", encoding="utf-8")

    r = client.get("/")                              # 没重启,直接好了
    assert r.status_code == 200 and "id=root" in r.text
    assert client.get("/assets/index-abc123.js").status_code == 200


def test_asset_route_refuses_to_walk_out_of_the_assets_dir(client, tmp_path, monkeypatch):
    """照着 URL 拼路径的读文件接口不该靠「只监听 127.0.0.1」来兜底。"""
    from server import app as app_mod

    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("x", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("不该被读到", encoding="utf-8")
    monkeypatch.setattr(app_mod, "_WEB_DIST", dist)

    for path in ("../secret.txt", "../../secret.txt", "..%2fsecret.txt"):
        r = client.get(f"/assets/{path}")
        assert r.status_code == 404, f"{path} 竟然读到了:{r.text[:80]}"

    # 上面那几条走 HTTP,URL 可能在到达路由之前就被规范化掉 ——
    # 那样测的是客户端而不是守卫。所以再直接调一次处理函数。
    from fastapi import HTTPException

    for path in ("../../secret.txt", "../../../etc/passwd", "/etc/passwd"):
        try:
            app_mod._asset(path)
            raise AssertionError(f"{path} 竟然读到了")
        except HTTPException as exc:
            assert exc.status_code == 404
