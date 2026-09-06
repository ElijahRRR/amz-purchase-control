"""回填时的 ASIN 断言:三态,以及「整体失效」必须是可数的。

断言本身的取舍不变:**没采到不阻断回填**(制造噪音会让人学会忽略它)。
变的是「没采到」不再和「对上了」渲染成同一个结果 ——

    if not observed:
        return True          # ← 与「比对通过」返回同一个值

调用方只有 `if not asins_match(...)` 一个分支,于是这两件事在事件流里、在库里、
在任何统计里都长得一模一样。Amazon 某次改版把订单卡的商品链接换个类名,
`observedAsins` 恒为 `[]`,断言就整体退化成厂商那套「盲取第一张卡」——
而这件事没有任何地方看得见,直到某天有人发现一批任务挂着别人的订单号。

现在:三态(match / mismatch / not_observed),`not_observed` 照旧继续,
但落一条 `assert_skipped` 事件,并在错误码分布页上报近 7 日的计数。
某天这个数接近当天的回填总数,就是选择器已经坏了。
"""

import pytest

from services.order_backfill import asins_match

UID = "inst-A"


# ── 纯函数:三态 ────────────────────────────────────────────────────────

def test_three_states_are_three_values():
    assert asins_match(["B01"], ["B01"]) == "match"
    assert asins_match(["B01"], ["B02"]) == "mismatch"
    assert asins_match(["B01"], []) == "not_observed"


def test_match_is_by_set_and_case_insensitive():
    """同一 ASIN 多件在卡片上可能只出现一次;大小写与空白不算差异。"""
    assert asins_match(["B01", "B02"], ["b02", " B01 ", "B01"]) == "match"


def test_a_missing_one_is_a_mismatch_not_a_skip():
    """采到了一部分不是「没采到」—— 那是实打实的不符,必须拦。"""
    assert asins_match(["B01", "B02"], ["B01"]) == "mismatch"


def test_the_return_value_is_not_a_bool_in_disguise():
    """**三态不许是「真值/假值」两态换个皮。**

    `"not_observed"` 与 `"match"` 都是非空字符串,调用方要是照旧写
    `if not asins_match(...)`,两者仍然走同一条路,这次改动就等于没做 ——
    这正是本项目最防的那种「看起来改了、实际没改」。
    """
    assert asins_match(["B01"], []) != asins_match(["B01"], ["B01"])
    # 三个值互不相同,而且都不是 bool
    got = {asins_match(["B01"], ["B01"]), asins_match(["B01"], ["B02"]),
           asins_match(["B01"], [])}
    assert len(got) == 3
    assert not any(isinstance(v, bool) for v in got)


# ── 走完整回填链路 ──────────────────────────────────────────────────────

def _claim(client, conn, task_id):
    conn.execute("UPDATE procure.tasks SET status='ready' WHERE id = %s", (task_id,))
    conn.commit()
    got = client.post("/v1/tasks/claim", json={"instance_uid": UID}).json()["data"]
    assert got["task_id"] == task_id


def _events(conn, task_id, kind):
    return [dict(r) for r in conn.execute(
        "SELECT kind, payload FROM procure.task_events "
        " WHERE task_id = %s AND kind = %s ORDER BY id", (task_id, kind)).fetchall()]


def test_backfill_still_goes_through_when_nothing_was_observed(client, conn, seed):
    """既定取舍不推翻:没采到照旧回填、照旧返回成功。"""
    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    r = client.post(f"/v1/tasks/{tasks[0]}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-2223334-4445556",
        "observed_asins": []})
    assert r.json()["data"]["status"] == "purchased"


def test_but_it_leaves_a_countable_trace(client, conn, seed):
    """断言什么时候整体失效,在 task_events 里必须是可数的。"""
    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    client.post(f"/v1/tasks/{tasks[0]}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-2223334-4445556",
        "observed_asins": []})

    rows = _events(conn, tasks[0], "assert_skipped")
    assert len(rows) == 1
    p = rows[0]["payload"]
    assert p["reason"] == "no_asin_observed"
    # 期望值与单号都要留下:事后回看这条事件时,「当时该比的是什么、
    # 最后写进去的是哪个单号」不能还要去别处拼。
    assert p["expected"] == ["B0FB3VS68J"]
    assert p["amazon_order_no"] == "111-2223334-4445556"


def test_a_normal_backfill_leaves_no_such_trace(client, conn, seed):
    """反面:采到了并且对上了,不许也记一条 —— 那个数就没意义了。"""
    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    client.post(f"/v1/tasks/{tasks[0]}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-2223334-4445556",
        "observed_asins": ["B0FB3VS68J"]})
    assert _events(conn, tasks[0], "assert_skipped") == []


def test_mismatch_still_blocks_and_still_records_assert_failed(client, conn, seed):
    """反面之二:采到了但不符,照旧不写单号、照旧转人工。"""
    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    r = client.post(f"/v1/tasks/{tasks[0]}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-2223334-4445556",
        "observed_asins": ["B0DIFFERENT"]})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "ORDER_NO_AMBIGUOUS"
    row = conn.execute("SELECT status, amazon_order_no FROM procure.tasks WHERE id = %s",
                       (tasks[0],)).fetchone()
    assert row["status"] == "manual" and row["amazon_order_no"] is None
    assert len(_events(conn, tasks[0], "assert_failed")) == 1
    assert _events(conn, tasks[0], "assert_skipped") == []


# ── 运营台看得见 ────────────────────────────────────────────────────────

def test_error_stats_reports_the_recent_skip_count(client, conn, seed):
    """错误码分布页要能看见这个数 —— 事件写了没人看等于没写。

    这一页原本只统计 error / guard_block:断言被跳过既不是失败也不是拦截,
    在那两个口径里一条都不会出现,而它恰恰是「护栏整体失效」的信号。
    """
    _env, _inst, tasks = seed
    for i, tid in enumerate(tasks[:2]):
        _claim(client, conn, tid)
        client.post(f"/v1/tasks/{tid}/complete", json={
            "instance_uid": UID, "amazon_order_no": f"111-2223334-444555{i}",
            "observed_asins": []})

    data = client.get("/v1/admin/error-stats").json()["data"]
    got = data["assert_skipped"]
    assert got["count"] == 2
    assert got["days"] == 7
    # 分母必须一起下发 —— 单独一个 count 回答不了「断言还工作吗」
    assert got["backfills"] == 2
    # 文案从 vocab 单一来源下发,前端不写死
    assert got["label"]


def test_the_same_count_means_two_opposite_things_and_must_not_render_the_same(client, conn, seed):
    """**一个 count 说不清任何事。**

    近 7 天回填很多单、其中 1 单没采到(页面没渲染完,无害),与
    近 7 天只回填了 1 单、这 1 单没采到(选择器已坏,断言 100% 失效)——
    两者的 count 都是 1。只发 count,这两件事在界面上渲染成完全一样的结果:
    同一个琥珀边框、同一个数字 1、同一句「去跟同期回填条数比」的说明,
    而那个分母这一页压根没有。

    所以分母、比例、要不要报警都在服务端算好。这条测试盯的就是
    「两种相反的情况不许给出同一个结论」。
    """
    from services import ops_query, task_event

    _env, inst, tasks = seed
    # 场景 A:只回填了 1 单,而它没采到 —— 断言整体失效的样子
    task_event.record(conn, tasks[0], "purchased", instance_id=inst)
    task_event.record(conn, tasks[0], "assert_skipped", instance_id=inst,
                      payload={"reason": "no_asin_observed"})
    a = ops_query.assert_skipped(conn)
    assert (a["count"], a["backfills"], a["alert"]) == (1, 1, True)
    assert a["ratio"] == 1.0

    # 场景 B:同一个 count=1,但同期回填了很多单 —— 零星一次,不该报警
    for _ in range(19):
        task_event.record(conn, tasks[1], "purchased", instance_id=inst)
    b = ops_query.assert_skipped(conn)
    assert b["count"] == 1 and b["backfills"] == 20
    assert b["alert"] is False, "count 没变、结论必须变 —— 否则这两种情况又渲染成同一个结果"


def test_no_backfills_at_all_is_not_the_same_as_nothing_wrong(conn, seed):
    """「这几天一次都没回填」与「回填了很多次、一次都没漏」不是同一件事。

    ratio 给 0.0 就把它们抹成同一个数了,而前者的含义是**这个数眼下说明不了任何事**。
    """
    from services import ops_query, task_event

    _env, inst, tasks = seed
    empty = ops_query.assert_skipped(conn)
    assert empty["backfills"] == 0 and empty["ratio"] is None and empty["alert"] is False

    task_event.record(conn, tasks[0], "purchased", instance_id=inst)
    working = ops_query.assert_skipped(conn)
    assert working["backfills"] == 1 and working["ratio"] == 0.0


def test_the_alert_threshold_is_a_ratio_not_count_over_zero(conn, seed):
    """琥珀挂在比例上,不挂在 count > 0。

    挂在 count > 0 的话这张卡片常年琥珀 —— 而一张常年琥珀的卡片会把人训练成
    忽略它,恰恰在它真该报警的那天。阈值只有服务端这一份,前端不判。
    """
    from services import ops_query, task_event

    _env, inst, tasks = seed
    for _ in range(100):
        task_event.record(conn, tasks[0], "purchased", instance_id=inst)
    task_event.record(conn, tasks[0], "assert_skipped", instance_id=inst,
                      payload={"reason": "no_asin_observed"})
    got = ops_query.assert_skipped(conn)
    assert got["count"] == 1 and got["alert"] is False, "1/100 不该报警"
    assert got["alert_ratio"] == ops_query.ASSERT_SKIPPED_ALERT_RATIO

    # 补到刚过线
    need = int(100 * ops_query.ASSERT_SKIPPED_ALERT_RATIO) + 1
    for _ in range(need - 1):
        task_event.record(conn, tasks[0], "assert_skipped", instance_id=inst,
                          payload={"reason": "no_asin_observed"})
    assert ops_query.assert_skipped(conn)["alert"] is True


def test_the_denominator_uses_the_same_window(conn, seed):
    """分子分母同一个窗口 —— 分开查会出现「分子这 7 天、分母上一次那 7 天」的错位。"""
    from services import ops_query, task_event

    _env, inst, tasks = seed
    task_event.record(conn, tasks[0], "purchased", instance_id=inst)
    task_event.record(conn, tasks[1], "purchased", instance_id=inst)
    conn.execute("UPDATE procure.task_events SET created_at = now() - interval '9 days' "
                 " WHERE task_id = %s", (tasks[1],))
    assert ops_query.assert_skipped(conn)["backfills"] == 1


def test_the_skip_count_is_zero_when_the_assertion_is_working(client, conn, seed):
    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    client.post(f"/v1/tasks/{tasks[0]}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-2223334-4445556",
        "observed_asins": ["B0FB3VS68J"]})
    data = client.get("/v1/admin/error-stats").json()["data"]
    assert data["assert_skipped"]["count"] == 0


def test_the_skip_count_only_looks_at_the_last_seven_days(conn, seed):
    """近 7 日,不是「有史以来」。一个只增不减的总数没法回答「现在坏没坏」。"""
    from services import ops_query, task_event

    _env, inst, tasks = seed
    task_event.record(conn, tasks[0], "assert_skipped", instance_id=inst,
                      payload={"reason": "no_asin_observed"})
    task_event.record(conn, tasks[1], "assert_skipped", instance_id=inst,
                      payload={"reason": "no_asin_observed"})
    conn.execute("UPDATE procure.task_events SET created_at = now() - interval '9 days' "
                 " WHERE task_id = %s", (tasks[1],))
    assert ops_query.assert_skipped(conn)["count"] == 1


def test_the_new_kind_is_in_every_copy_of_the_closed_set():
    """assert_skipped 是一个新的 kind,三份副本都得有它。

    (tests/test_task_event.py 那条测试已经在盯这三份对不对得上,
    这里只是把「新加的这一个确实进去了」单独说一遍。)
    """
    from services import task_event, vocab

    assert "assert_skipped" in task_event.KINDS
    assert "assert_skipped" in vocab.EVENT_LABELS
    assert "assert_skipped" in vocab.EVENT_TONE
