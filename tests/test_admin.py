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


def _fail(conn, task_id, code, *, hours_ago=0):
    """按真实路径造一次失败:落 task_events 那一行。

    直接 UPDATE tasks.error_code 是造不出这一页要的数据的 ——
    这一页统计的是**失败事件**,而事件才是带着「什么时候失败的」那个时间戳的东西。
    """
    conn.execute(
        """INSERT INTO procure.task_events (task_id, kind, code, payload, created_at)
           VALUES (%s, 'error', %s, '{}'::jsonb, now() - make_interval(hours => %s))""",
        (task_id, code, hours_ago))
    conn.execute("UPDATE procure.tasks SET status='exception', error_code=%s WHERE id=%s",
                 (code, task_id))


def test_error_stats_splits_by_env_and_by_day(client, conn, seed):
    """分买家号是为了看出「是不是某一台机器的问题」(比如某个买家号被风控了)。"""
    _env, _inst, tasks = seed
    _fail(conn, tasks[0], "ORDER_NO_AMBIGUOUS")
    _fail(conn, tasks[1], "PRICE_CAP_EXCEEDED")
    _fail(conn, tasks[2], "PRICE_CAP_EXCEEDED")
    conn.commit()

    data = client.get("/v1/admin/error-stats").json()["data"]
    assert data["total"] == 3
    top = data["items"][0]
    assert top["code"] == "PRICE_CAP_EXCEEDED" and top["n"] == 2
    assert top["by_env"] == {"env-172": 2}
    assert sum(p["n"] for p in data["trend"]) == 3


def test_error_stats_ignores_tasks_that_never_failed(client, conn, seed):
    """没出过错的行不该进分布图 —— 那张图是用来找卡点的,不是统计总量的。"""
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="purchased", amazon_order_no="111-0000001-0000001")
    conn.commit()
    assert client.get("/v1/admin/error-stats").json()["data"]["total"] == 0


def test_error_stats_windows_by_when_it_failed_not_when_it_was_created(client, conn, seed):
    """20 天前下发的单今天失败,必须出现在默认 14 天窗口里。

    原先两个 SQL 都拿 `tasks.created_at` 筛窗口 —— 这条**整个看不见**。
    而这一页的问题是「最近在哪儿卡住」,不是「最近下发的单里有多少卡住」。
    """
    _env, _inst, tasks = seed
    conn.execute("UPDATE procure.tasks SET created_at = now() - interval '20 days' "
                 " WHERE id = %s", (tasks[0],))
    _fail(conn, tasks[0], "CAPTCHA_ENCOUNTERED")      # 今天失败的
    conn.commit()

    data = client.get("/v1/admin/error-stats").json()["data"]
    assert data["total"] == 1, "20 天前下发、今天才失败的单被窗口筛掉了"


def test_error_stats_buckets_on_the_day_it_failed(client, conn, seed):
    """5 天前下发、今天失败的单,要记在**今天**那根柱子上。

    按创建时间分天的话,趋势图会把今天的故障画在 5 天前 ——
    而这张图的标题就是「是一直这样,还是昨天开始的」。
    """
    from datetime import date

    _env, _inst, tasks = seed
    conn.execute("UPDATE procure.tasks SET created_at = now() - interval '5 days' "
                 " WHERE id = %s", (tasks[0],))
    _fail(conn, tasks[0], "CHECKOUT_TIMEOUT")
    conn.commit()

    trend = client.get("/v1/admin/error-stats").json()["data"]["trend"]
    assert len(trend) == 1
    assert trend[0]["day"] == date.today().isoformat(), \
        f"记在了 {trend[0]['day']},应该是今天"


def test_error_stats_still_sees_a_failure_that_was_later_reset(client, conn, seed):
    """重置过的单 `error_code` 被清空了,但它确实失败过 —— 分布图不该忘了它。

    事件是只追加的,重置不会抹掉历史。按 tasks.error_code 统计的话,
    「这周被重置掉的那 30 次超时」会从图上整个消失,
    而那 30 次正是最该被看见的东西。
    """
    _env, _inst, tasks = seed
    _fail(conn, tasks[0], "CHECKOUT_TIMEOUT")
    conn.commit()
    assert client.get("/v1/admin/error-stats").json()["data"]["total"] == 1

    client.post(f"/v1/admin/tasks/{tasks[0]}/reset", json={"acknowledged": False})
    assert conn.execute("SELECT error_code FROM procure.tasks WHERE id=%s",
                        (tasks[0],)).fetchone()["error_code"] is None
    assert client.get("/v1/admin/error-stats").json()["data"]["total"] == 1, \
        "重置把它从分布图上抹掉了"


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


def test_a_busy_workflow_does_not_push_another_out_of_the_freshness_window(client, conn):
    """一条跑得频繁的工作流,不能把另一条挤成「从没跑过」。

    task_intake 一小时跑 60 次,把 task_sweep 一小时前那次挤出了「最近 N 次」——
    界面于是报「从没跑过 + 逾期」,而它其实好好的。
    **在监控页上误报比不报还坏**:红旗一旦会自己冒出来,就没人再信红旗。
    """
    conn.execute("""INSERT INTO ops.runs (workflow, params, started_at, finished_at,
                                          status, summary, operator)
                    VALUES ('task_sweep','{}'::jsonb, now() - interval '60 minutes',
                            now() - interval '59 minutes','success','清扫完成:0 条','cron')""")
    for i in range(60):
        conn.execute("""INSERT INTO ops.runs (workflow, params, started_at, finished_at,
                                              status, summary, operator)
                        VALUES ('task_intake','{}'::jsonb,
                                now() - make_interval(secs => %s), now(),
                                'success','ok','cron')""", (i * 30,))
    conn.commit()

    by = {r["workflow"]: r
          for r in client.get("/v1/admin/runs").json()["data"]["by_workflow"]}
    assert by["task_sweep"]["last"] is not None
    assert by["task_sweep"]["overdue"] is False, "1 小时前刚跑过,阈值是 2 小时"


def test_a_dry_run_does_not_reset_the_overdue_clock(client, conn):
    """空跑不算跑过。

    空跑什么都没清扫。定时器停了、有人手工 --dry-run 试了一下,那一格就从红变绿,
    而 claimed 的任务照样堆着 —— 这正是「看起来有护栏、实际防不住」。
    """
    conn.execute("""INSERT INTO ops.runs (workflow, params, started_at, finished_at,
                                          status, summary, operator)
                    VALUES ('task_sweep','{}'::jsonb, now() - interval '3 hours',
                            now() - interval '3 hours','success','清扫完成:0 条','cron')""")
    conn.commit()
    before = {r["workflow"]: r
              for r in client.get("/v1/admin/runs").json()["data"]["by_workflow"]}
    assert before["task_sweep"]["overdue"] is True

    # 一次空跑
    conn.execute("""INSERT INTO ops.runs (workflow, params, started_at, finished_at,
                                          status, summary, operator)
                    VALUES ('task_sweep','{"dry_run": true}'::jsonb, now(), now(),
                            'success','dry-run:0 条任务超过 15 分钟未回传','manual')""")
    conn.commit()

    after = {r["workflow"]: r
             for r in client.get("/v1/admin/runs").json()["data"]["by_workflow"]}
    assert after["task_sweep"]["overdue"] is True, "一次空跑把「该清扫却没清扫」这面红旗抹掉了"
    # 流水里照样看得见那次空跑 —— 只是不算数,不是不记
    assert any(r["params"].get("dry_run") is True
               for r in client.get("/v1/admin/runs").json()["data"]["items"])


def test_runs_limit_is_clamped_instead_of_blowing_up(client, conn):
    """负数 LIMIT 会让 SQL 直接报错。夹住就好,不必为此 400 —— 这是个内部只读接口。"""
    assert client.get("/v1/admin/runs", params={"limit": -1}).status_code == 200
    assert client.get("/v1/admin/runs", params={"limit": 10**9}).status_code == 200


def test_export_does_not_drop_a_row_when_the_set_shrinks_mid_export(conn, seed, monkeypatch):
    """导到一半有单离开筛选集,不能让另一行**永远不被导出**。

    OFFSET 翻页在这里会漂:前面少了一行,后面的行整体左移,第二页跳过一条。
    CSV 里没有任何提示 —— 拿它去对账的人不会知道自己少了一行。
    """
    from registry import settings
    from services import task_query

    monkeypatch.setattr(settings, "admin_page_size_max", lambda: 2)
    _env, _inst, tasks = seed
    conn.commit()

    gen = task_query.export_rows(conn, page_size=2, status="ready")
    first = [next(gen), next(gen)]              # 拿完第一页

    # 第一页那两条离开筛选集(被拍掉了)
    conn.execute("UPDATE procure.tasks SET status='purchased' WHERE id = ANY(%s)",
                 ([tasks[2], tasks[1]],))
    conn.commit()

    rest = list(gen)
    got = {r["upstream_order_no"] for r in first} | {r["upstream_order_no"] for r in rest}
    assert "UP-0" in got, f"第一页之后那条被漏掉了:拿到 {sorted(got)}"


def test_export_does_not_emit_the_same_row_twice_when_new_tasks_arrive(conn, seed,
                                                                      monkeypatch):
    """反过来:导到一半有新单落库,同一行不能导两次。

    OFFSET 下新单排在最前,后面的页整体右移 —— 上一页最后那条会再来一次。
    """
    from registry import settings
    from services import task_query

    monkeypatch.setattr(settings, "admin_page_size_max", lambda: 2)
    env_id = conn.execute("SELECT id FROM procure.buyer_envs LIMIT 1").fetchone()["id"]
    conn.commit()

    gen = task_query.export_rows(conn, page_size=2, status="ready")
    first = [next(gen), next(gen)]

    for i in range(3):                          # 导到一半灌进来三条新的
        conn.execute(
            """INSERT INTO procure.tasks
                 (line_key, upstream_order_no, buyer_env_id, ship_name, ship_phone,
                  ship_line1, ship_city, ship_state, ship_postcode, price_cap, status)
               VALUES (%s,%s,%s,'N','1','1 St','SA','CA','92707',9.99,'ready')""",
            (f"key-new-{i}", f"UP-NEW{i}", env_id))
    conn.commit()

    all_rows = first + list(gen)
    numbers = [r["upstream_order_no"] for r in all_rows]
    assert len(numbers) == len(set(numbers)), f"有行被导了两次:{numbers}"


def test_summary_survives_a_status_outside_the_closed_set(client, conn, seed):
    """库里出现集合外的状态,状态桶接口不能 500。

    `tasks.status` 是 text、没有 CHECK,封闭集只写在注释和 vocab 里。
    手工 UPDATE 过、或者以后加了状态没同步 vocab,整个接口 500 的话
    运营台首屏直接打不开 —— 为了一个陌生的枚举值,整页挂掉。
    """
    _env, _inst, tasks = seed
    conn.execute("UPDATE procure.tasks SET status='frobnicated' WHERE id=%s", (tasks[0],))
    conn.commit()

    r = client.get("/v1/admin/summary")
    assert r.status_code == 200
    by = r.json()["data"]["by_status"]
    assert by["frobnicated"] == 1, "陌生的值要原样带上,界面会把它显示成英文"
    assert by["ready"] == 2


def test_a_bad_date_field_is_a_422_not_a_500(client, conn, seed):
    """传错字段名不是「服务坏了」。

    原先 `date_field=updated` 会一路走到 task_query 里 raise ValueError → 500。
    500 会让人去查服务端日志,而实际情况是调用方传错了。
    """
    r = client.get("/v1/admin/summary", params={"date_field": "updated"})
    assert r.status_code == 422
    assert "date_field" in r.text


def test_a_reversed_date_range_is_refused_instead_of_returning_zero(client, conn, seed):
    """起止日期反了要明说,别返回一个空结果。

    反着传会让所有查询都返回 0 条,而「0 条」跟「这段时间确实没有单」长得一模一样。
    这个项目最怕的就是这种:界面给了一个看着正常的答案,而它回答的是另一个问题。
    """
    rev = {"date_from": "2026-08-21", "date_to": "2026-08-01"}

    r = client.post("/v1/admin/tasks/search", json=rev)
    assert r.status_code == 422 and r.json()["error"]["code"] == "BAD_DATE_RANGE"

    r = client.get("/v1/admin/summary", params=rev)
    assert r.status_code == 422 and r.json()["error"]["code"] == "BAD_DATE_RANGE"

    r = client.get("/v1/admin/error-stats", params=rev)
    assert r.status_code == 422 and r.json()["error"]["code"] == "BAD_DATE_RANGE"

    # 同一天不算反
    same = {"date_from": "2026-08-21", "date_to": "2026-08-21"}
    assert client.get("/v1/admin/summary", params=same).status_code == 200


def test_dispatchable_respects_the_daily_cap_like_the_claim_sql_does(client, conn, seed):
    """「可派单」必须跟真正那道闸算同一件事。

    真正的闸在 task_queue.CLAIM_SQL:`daily_cap = 0 OR done_today < daily_cap`。
    界面只看在线的话,拍满配额的买家号仍然显示绿色「可派」——
    运营看着一台「可派」的机器一整天不动,只能去猜是不是插件坏了。
    """
    env, inst, tasks = seed
    conn.execute("UPDATE procure.buyer_envs SET daily_cap = 2 WHERE id = %s", (env,))
    conn.execute("UPDATE procure.plugin_instances SET last_seen_at = now() WHERE id = %s",
                 (inst,))
    conn.commit()

    row = client.get("/v1/admin/instances").json()["data"]["items"][0]
    assert row["liveness"] == "online" and row["dispatchable"] is True

    # 今天拍满两单
    for i, tid in enumerate(tasks[:2]):
        conn.execute("UPDATE procure.tasks SET status='purchased', purchased_at=now(),"
                     " amazon_order_no=%s WHERE id=%s",
                     (f"111-000000{i}-000000{i}", tid))
    conn.commit()

    row = client.get("/v1/admin/instances").json()["data"]["items"][0]
    assert row["purchased_today"] == 2
    assert row["at_daily_cap"] is True
    assert row["dispatchable"] is False, "拍满了日上限还说可派"
    assert row["liveness"] == "online", "到上限不等于离线 —— 两件事,界面上要分开说"


def test_daily_cap_zero_still_means_unlimited(client, conn, seed):
    """0 是「不限」,不是「一单都不许拍」。"""
    env, inst, tasks = seed
    conn.execute("UPDATE procure.buyer_envs SET daily_cap = 0 WHERE id = %s", (env,))
    conn.execute("UPDATE procure.plugin_instances SET last_seen_at = now() WHERE id = %s",
                 (inst,))
    conn.execute("UPDATE procure.tasks SET status='purchased', purchased_at=now(),"
                 " amazon_order_no='111-0000009-0000009' WHERE id=%s", (tasks[0],))
    conn.commit()

    row = client.get("/v1/admin/instances").json()["data"]["items"][0]
    assert row["at_daily_cap"] is False and row["dispatchable"] is True


def test_cannot_edit_a_task_while_the_plugin_is_buying_it(client, conn, seed):
    """claimed 的单不许改 —— 插件此刻正拿着旧快照在亚马逊上下单。

    这时候改 ASIN,插件买的还是旧的那个,回填时断言不符:一张真花了钱的订单
    挂不到任何任务上,成了孤儿单;而任务停在待人工,界面还会热情地建议
    「强制回填」或者「重置回队列」—— 后者就是再买一遍。
    """
    _env, inst, tasks = seed
    conn.execute("UPDATE procure.tasks SET status='claimed', claimed_by=%s, claimed_at=now()"
                 " WHERE id=%s", (inst, tasks[0]))
    conn.commit()

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/address", json={"ship_city": "Irvine"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "BAD_STATUS"
    assert "插件" in r.json()["error"]["message"], "拒绝的理由要说人话,不能只甩一个状态名"

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/asin",
                    json={"old_asin": "B0FB3VS68J", "new_asin": "B0NEWASIN1"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "BAD_STATUS"

    assert conn.execute("SELECT ship_city FROM procure.tasks WHERE id=%s",
                        (tasks[0],)).fetchone()["ship_city"] == "Santa Ana"


def test_needs_ack_keys_on_the_error_code_not_the_status(client, conn, seed):
    """「要不要人先去看一眼」不能由插件的一个布尔说了算。

    原先条件是 `status == "manual" and error_code in POSSIBLY_ORDERED`,
    而状态是插件在 /fail 里用自己算的 to_manual 定的。插件漏判一次,
    同一个 ORDER_CONFIRM_TIMEOUT 就落成 exception —— 这道闸整个绕过去,
    而运营台上那条紫色警告照样在喊「可能已经下单」,**喊完了静默重置**。
    """
    _env, _inst, tasks = seed
    # 码是「可能已下单」,状态却是 exception(插件没把 to_manual 置上)
    _set(conn, tasks[0], status="exception", error_code="ORDER_CONFIRM_TIMEOUT")
    conn.commit()

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/reset", json={"acknowledged": False})
    assert r.status_code == 409 and r.json()["error"]["code"] == "NEEDS_ACK"
    assert conn.execute("SELECT status FROM procure.tasks WHERE id=%s",
                        (tasks[0],)).fetchone()["status"] == "exception"

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/reset", json={"acknowledged": True})
    assert r.status_code == 200


def test_summary_follows_the_asin_filter_like_the_list_does(client, conn, seed):
    """漏掉 asin 正好戳中这个接口存在的理由。

    填了 ASIN 之后,桶上写「待拍单 12」、点进去只有 3 条 —— 运营会以为界面丢了单。
    """
    _env, _inst, tasks = seed
    conn.execute("UPDATE procure.task_products SET asin='B0ONLYONE1' WHERE task_id=%s",
                 (tasks[0],))
    conn.commit()

    scoped = client.get("/v1/admin/summary", params={"asin": "B0ONLYONE1"}).json()["data"]
    listed = client.post("/v1/admin/tasks/search",
                         json={"status": "ready", "asin": "B0ONLYONE1"}).json()["data"]
    assert scoped["by_status"]["ready"] == 1
    assert listed["total"] == scoped["by_status"]["ready"], "桶上的数字和点进去的条数要对得上"


def test_missing_order_numbers_is_not_poisoned_by_the_asin_filter(client, conn, seed):
    """一个明明在库里、只是不含这个 ASIN 的号,不能被列进「查不到」。

    这个字段存在的全部意义是「别让运营以为都查到了」。报一个其实存在的号
    「查不到」,会把人支去上游翻一张好好的单 —— 比不报还费时间。
    """
    _env, _inst, _tasks = seed
    data = client.post("/v1/admin/tasks/search",
                       json={"order_numbers": ["UP-0", "UP-NOPE"],
                             "asin": "B0NOTHERE1"}).json()["data"]
    assert data["total"] == 0                       # ASIN 确实筛掉了所有行
    assert data["missing_order_numbers"] == ["UP-NOPE"], \
        f"UP-0 在库里,不该被报成查不到:{data['missing_order_numbers']}"


def test_release_records_who_released_it(client, conn, seed):
    """放行也要留下操作人。

    原先这条路由压根不收请求体,于是「操作人」审计在放行这一个动作上永远是 null ——
    前端每次都把名字送过来了,服务端把它丢在门口。
    一份有一格永远空着的审计,比没有审计更容易让人误判(「哦这条没人操作过」)。
    """
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="pending")
    conn.commit()

    client.post(f"/v1/admin/tasks/{tasks[0]}/release", json={"operator": "小李"})
    row = conn.execute(
        "SELECT payload FROM procure.task_events WHERE task_id=%s AND kind='admin'"
        " ORDER BY id DESC LIMIT 1", (tasks[0],)).fetchone()
    assert row["payload"]["operator"] == "小李"


def test_release_still_works_without_a_body(client, conn, seed):
    """没带请求体也要能放行 —— 别为了加一个可选字段把原来的调用方打死。"""
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="pending")
    conn.commit()
    assert client.post(f"/v1/admin/tasks/{tasks[0]}/release").status_code == 200


def test_force_backfill_refuses_an_order_number_with_stray_whitespace(client, conn, seed):
    """首尾一个空格就能绕开唯一索引 —— 而这个动作跳过的正是拦这种事的那道断言。

    `" 111-…"` 与 `"111-…"` 在库里是两个不同的值,同一张亚马逊订单于是能被钉到
    两条任务上,后面对账、物流、退款全跟着错。
    """
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="manual", error_code="ORDER_NO_AMBIGUOUS")
    _set(conn, tasks[1], status="manual", error_code="ORDER_NO_AMBIGUOUS")
    conn.commit()

    ok = client.post(f"/v1/admin/tasks/{tasks[0]}/force-backfill",
                     json={"amazon_order_no": "  111-4820193-7736441  ", "note": "人工核过"})
    assert ok.status_code == 200, "首尾空白应该被去掉而不是拒绝"

    # 同一张订单换个空格再钉到另一条任务上,必须被唯一索引拦住
    dup = client.post(f"/v1/admin/tasks/{tasks[1]}/force-backfill",
                      json={"amazon_order_no": " 111-4820193-7736441", "note": "再来一次"})
    assert dup.status_code != 200, "同一张订单被钉到了两条任务上"


def test_force_backfill_refuses_a_malformed_order_number(client, conn, seed):
    _env, _inst, tasks = seed
    _set(conn, tasks[0], status="manual", error_code="ORDER_NO_AMBIGUOUS")
    conn.commit()
    for bad in ("111-123-456", "not-an-order", "1114820193 7736441", ""):
        r = client.post(f"/v1/admin/tasks/{tasks[0]}/force-backfill",
                        json={"amazon_order_no": bad, "note": "试试"})
        assert r.status_code == 422, f"{bad!r} 被放过去了"


def test_address_cannot_be_blanked_out(client, conn, seed):
    """收货六项在库里都是 NOT NULL 的必填项,空串写进去等于把地址弄残 ——
    而包裹要照着它寄。前端挡的那道是便利,不是保证:curl 一下就绕过去了。"""
    _env, _inst, tasks = seed
    conn.commit()
    for blank in ("", "   "):
        r = client.post(f"/v1/admin/tasks/{tasks[0]}/address", json={"ship_city": blank})
        assert r.status_code == 422, f"{blank!r} 被写进去了"
    assert conn.execute("SELECT ship_city FROM procure.tasks WHERE id=%s",
                        (tasks[0],)).fetchone()["ship_city"] == "Santa Ana"

    # 正常改动照样通过,首尾空白去掉
    r = client.post(f"/v1/admin/tasks/{tasks[0]}/address", json={"ship_city": "  Irvine  "})
    assert r.status_code == 200
    assert conn.execute("SELECT ship_city FROM procure.tasks WHERE id=%s",
                        (tasks[0],)).fetchone()["ship_city"] == "Irvine"


def test_error_stats_hands_the_day_keys_to_the_client(client, conn, seed):
    """窗口里每一天的 key 由服务端给,前端不自己拼日期。

    前端拼的是浏览器本地日期,trend 里的 day 走的是 PostgreSQL 会话时区。
    两者不一致时(库在 UTC、人在东八区)对不上号的点会被前端**静默丢掉** ——
    折线图上那天变成 0,而 0 跟「那天确实一件没出」长得一模一样。
    """
    _env, _inst, tasks = seed
    _fail(conn, tasks[0], "CHECKOUT_TIMEOUT")
    conn.commit()

    data = client.get("/v1/admin/error-stats",
                      params={"date_from": "2026-08-08", "date_to": "2026-08-21"}).json()["data"]
    assert len(data["days"]) == 14, "8-08 到 8-21 是 14 天,含首尾"
    assert data["days"][0] == "2026-08-08" and data["days"][-1] == "2026-08-21"

    # trend 里出现的每一天都必须在 days 里 —— 否则前端就得丢点
    assert {p["day"] for p in data["trend"]} <= set(data["days"])


def test_error_stats_days_covers_a_single_day_window(client, conn, seed):
    """起止同一天要给一格,不是零格。"""
    data = client.get("/v1/admin/error-stats",
                      params={"date_from": "2026-08-21", "date_to": "2026-08-21"}).json()["data"]
    assert data["days"] == ["2026-08-21"]
