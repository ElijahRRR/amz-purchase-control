"""外部下单:订单不经本系统采购,但要由本系统同步物流(所有者定稿 ④)。

这条路存在的理由:物流同步只要三样东西 —— 上游单号、买家号、AMZ 单号
(`services/shipment.PENDING_SQL` 只认 `status='purchased'` 且单号非空)。
上游在别处买了、把单号填进那张表,我们就该能接着同步物流;而在此之前
这种单**根本进不了库**:`price_cap` 必填、且必须大于 0,而它对这种单毫无意义。

这一整件事最容易写坏的地方是**渲染**:外部单的 `price_cap` 是个占位的 0,
拿它去比就会得出「0 ≥ 0,未超」——一句护栏从没做过的结论,配一个绿点。
所以「不适用」必须是单独一档,与「未核」也要分开(后者是「本该核、这次没核成」)。
"""

import json
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from services import (feishu_writeback, instance, ops_query, shipment, task_admin,
                      task_intake, task_query, task_queue)


def _row(**over):
    row = {
        "upstream_order_no": "UP-EXT-1",
        "buyer_env_code": "env-172",
        "ship_name": "Name", "ship_phone": "5550001", "ship_line1": "1 Main St",
        "ship_city": "Santa Ana", "ship_state": "CA", "ship_postcode": "92707",
        "price_cap": "12.50",
        "products": [{"asin": "B0FB3VS68J", "quantity": 1}],
    }
    row.update(over)
    return row


def _task(conn, upstream="UP-EXT-1"):
    return conn.execute(
        "SELECT * FROM procure.tasks WHERE upstream_order_no = %s", (upstream,)
    ).fetchone()


def _kinds(conn, task_id):
    return [r["kind"] for r in conn.execute(
        "SELECT kind FROM procure.task_events WHERE task_id = %s ORDER BY id", (task_id,)
    ).fetchall()]


# ── 落库 ────────────────────────────────────────────────────────────────

def test_a_row_with_an_amz_order_no_lands_as_an_external_purchase(conn, seed):
    got = task_intake.ingest(conn, [_row(amazon_order_no="111-2223334-5556667",
                                         price_cap=None)])
    assert got["inserted"] == 1
    t = _task(conn)
    assert t["status"] == "purchased"
    assert t["purchase_source"] == "external"
    assert t["amazon_order_no"] == "111-2223334-5556667"
    # 采购时间不给就用库里的 now() —— 留空的话这张单在「按采购时间」的筛选
    # 与统计里整个消失。
    assert t["purchased_at"] is not None
    # 限价那一列 NOT NULL,外部单落一个占位的 0。**它不是「限价 0」**。
    assert t["price_cap"] == Decimal("0.00")
    assert _kinds(conn, t["id"]) == ["purchased"]


def test_an_external_row_goes_straight_into_the_shipment_queue(conn, seed):
    """这条链存在的全部理由:上游在别处买的单,我们接着同步物流。"""
    env_id, _, _ = seed
    task_intake.ingest(conn, [_row(amazon_order_no="111-2223334-5556667",
                                   price_cap=None)])
    pend = shipment.pending(conn, env_id=env_id, resync_minutes=360, limit=10)
    assert [p["amazon_order_no"] for p in pend] == ["111-2223334-5556667"]


def test_price_cap_is_only_required_when_we_are_the_ones_buying(conn, seed):
    """外部单可以没有限价;插件要拍的单**必须**有,而且大于 0。

    这两条不能合成一条:放开了插件那一侧,一张 price_cap=0 的单会让
    「货款 ≤ 限价」永远不成立,整批卡在待人工;而逼上游为一张已经买完的单
    编一个限价,只会换来一列没人敢信的数。
    """
    got = task_intake.ingest(conn, [
        _row(upstream_order_no="UP-A", price_cap=None,
             amazon_order_no="111-1111111-1111111"),
        _row(upstream_order_no="UP-B", price_cap=None),
        _row(upstream_order_no="UP-C", price_cap="0"),
        # 上游把那一格填成 0(而不是留空)照样收:它是占位,不是「限价 0」。
        _row(upstream_order_no="UP-D", price_cap="0",
             amazon_order_no="111-4444444-4444444"),
        # 负数不是占位,那是填错了 —— 外部单也拒。
        _row(upstream_order_no="UP-E", price_cap="-1",
             amazon_order_no="111-5555555-5555555"),
    ])
    by = {d["upstream_order_no"]: d for d in got["details"]}
    assert by["UP-A"]["result"] == "inserted"
    assert by["UP-B"]["result"] == "rejected" and "price_cap" in by["UP-B"]["reason"]
    assert by["UP-C"]["result"] == "rejected" and "大于 0" in by["UP-C"]["reason"]
    assert by["UP-D"]["result"] == "inserted"
    assert by["UP-E"]["result"] == "rejected" and "负数" in by["UP-E"]["reason"]


def test_a_misshapen_order_no_is_rejected_row_by_row_not_batch_by_batch(conn, seed):
    """形状不对的单号只废掉它自己那一行,别的照落。

    这一格是人手填进上游那张表的,填错是常态。回 422 把整批拦在门外的话,
    一行填错等于今天一张单都进不来。
    """
    got = task_intake.ingest(conn, [
        _row(upstream_order_no="UP-BAD", amazon_order_no="111-22-33", price_cap=None),
        _row(upstream_order_no="UP-OK", amazon_order_no="111-2223334-5556667",
             price_cap=None),
    ])
    by = {d["upstream_order_no"]: d for d in got["details"]}
    assert by["UP-BAD"]["result"] == "rejected" and "形状" in by["UP-BAD"]["reason"]
    assert by["UP-OK"]["result"] == "inserted"


def test_the_same_amz_order_no_cannot_land_on_two_tasks(conn, seed):
    """同一张亚马逊订单挂到两条任务上,后面对账、物流、退款全跟着错。

    库层的唯一索引仍在,但先查一次是为了**只废掉这一行**:让唯一索引去拦的话,
    pg_conn 遇异常 rollback,连同前面已经写进去的几十行一起没了。
    """
    task_intake.ingest(conn, [_row(upstream_order_no="UP-1", price_cap=None,
                                   amazon_order_no="111-2223334-5556667")])
    got = task_intake.ingest(conn, [
        _row(upstream_order_no="UP-2", price_cap=None,
             amazon_order_no="111-2223334-5556667"),
        _row(upstream_order_no="UP-3", price_cap=None,
             amazon_order_no="111-9998887-7776665"),
    ])
    by = {d["upstream_order_no"]: d for d in got["details"]}
    assert by["UP-2"]["result"] == "rejected" and "已经挂在任务" in by["UP-2"]["reason"]
    assert by["UP-3"]["result"] == "inserted"


# ── 状态迁移表(docs/01 §10)────────────────────────────────────────────

def _land(conn, status, *, error_code=None, may_have_ordered=False):
    """先落一张普通任务,再把它摆成想要的状态。"""
    task_intake.ingest(conn, [_row()])
    t = _task(conn)
    conn.execute("UPDATE procure.tasks SET status=%s, error_code=%s, may_have_ordered=%s"
                 " WHERE id=%s", (status, error_code, may_have_ordered, t["id"]))
    return t["id"]


@pytest.mark.parametrize("status,error_code", [
    ("pending", None), ("ready", None),
    ("exception", "CHECKOUT_TIMEOUT"), ("manual", "CLAIM_TIMEOUT"),
])
def test_upstream_filling_in_the_order_no_turns_the_task_into_an_external_purchase(
        conn, seed, status, error_code):
    """这四种状态下,上游后来填了单号 → 转成外部下单。

    上游既然已经在别处买了,我们这边那张单就不该再被拍一次 ——
    留在 ready 里的话它迟早会被认领,那就是买第二次。
    """
    task_id = _land(conn, status, error_code=error_code)
    got = task_intake.ingest(conn, [_row(amazon_order_no="111-2223334-5556667",
                                         price_cap=None)])
    assert got["migrated"] == 1 and got["inserted"] == 0
    t = _task(conn)
    assert (t["status"], t["purchase_source"]) == ("purchased", "external")
    assert t["amazon_order_no"] == "111-2223334-5556667"
    # 转成外部单之后,原来的失败原因是过去时了 —— 留着的话运营台会一边写
    # 「已拍单」一边挂着一个红色错误码。
    assert t["error_code"] is None
    assert "purchased" in _kinds(conn, task_id)
    ev = conn.execute(
        "SELECT payload FROM procure.task_events WHERE task_id=%s AND kind='purchased'",
        (task_id,)).fetchone()["payload"]
    assert ev["purchase_source"] == "external"
    assert ev["from_status"] == status
    assert ev["note"] == "上游给了 AMZ 单号,按外部下单处理"


def test_a_task_the_plugin_is_buying_right_now_is_left_alone(conn, seed):
    """**claimed 一动不动**,而且必须报出来。

    插件此刻正拿着这一单在亚马逊上下单。改成「已拍单」的话,它几分钟后回来
    complete 会拿到 409 TASK_NOT_HELD —— 钱花了、货发了,而库里记的是上游那个号。
    这一条同时是「上游可能重复买了一次」的唯一信号,所以不能静默跳过。
    """
    task_id = _land(conn, "claimed")
    got = task_intake.ingest(conn, [_row(amazon_order_no="111-2223334-5556667",
                                         price_cap=None)])
    assert got["conflicted"] == 1 and got["migrated"] == 0
    d = got["details"][0]
    assert d["result"] == "conflicted" and "插件正在拍这单" in d["reason"]
    t = _task(conn)
    assert (t["status"], t["amazon_order_no"]) == ("claimed", None)
    assert "purchased" not in _kinds(conn, task_id)


def test_a_different_order_no_on_an_already_purchased_task_is_reported_not_applied(
        conn, seed):
    """已拍单、而上游填的是另一个号 → 一动不动并报出来。

    两个号不一样只有两种可能:上游填错了,或者这一单真的被买了两次。
    两种都要人去看,而覆盖任何一个都会让另一张订单从此不在任何系统里。
    """
    task_intake.ingest(conn, [_row(amazon_order_no="111-2223334-5556667",
                                   price_cap=None)])
    got = task_intake.ingest(conn, [_row(amazon_order_no="111-0000000-0000000",
                                         price_cap=None)])
    assert got["conflicted"] == 1
    assert "两个号不一样" in got["details"][0]["reason"]
    assert _task(conn)["amazon_order_no"] == "111-2223334-5556667"


def test_the_same_order_no_again_is_silent(conn, seed):
    """每轮全量拉,同一个号会被看见无数次 —— 那是常态,不该每轮报一条。"""
    task_intake.ingest(conn, [_row(amazon_order_no="111-2223334-5556667",
                                   price_cap=None)])
    got = task_intake.ingest(conn, [_row(amazon_order_no="111-2223334-5556667",
                                         price_cap=None)])
    assert (got["duplicated"], got["migrated"], got["conflicted"]) == (1, 0, 0)


def test_dry_run_predicts_the_same_migrations_as_the_real_run(conn, seed):
    """空跑与真跑必须报同一批数字。

    两处判据分叉的话,空跑说「会转 1 条」而真跑转了 2 条 ——
    那种空跑比没有空跑更误导人(模块 docstring 承诺过这件事)。
    """
    _land(conn, "ready")
    rows = [_row(amazon_order_no="111-2223334-5556667", price_cap=None),
            _row(upstream_order_no="UP-NEW", amazon_order_no="111-9998887-7776665",
                 price_cap=None)]
    preview = task_intake.dry_run(conn, rows)
    real = task_intake.ingest(conn, rows)
    for k in ("inserted", "duplicated", "rejected", "migrated", "conflicted"):
        assert preview[k] == real[k], k


@pytest.mark.parametrize("status,error_code", [
    ("manual", "ORDER_CONFIRM_TIMEOUT"),
    ("exception", "PLUGIN_INTERNAL"),
    ("ready", None),
])
def test_a_task_that_crossed_the_order_point_is_left_alone(conn, seed, status, error_code):
    """**越过下单点的单一动不动**,不管它此刻停在哪个状态。

    这是这张迁移表里与 claimed 同源的一格:`may_have_ordered` 记的是插件在点
    下单按钮**之前**自己说过的那句话,意思是「这一单可能已经在亚马逊上真花过钱」。
    转成外部下单会一口气做掉三件不该做的事:把它挪出待人工桶(从此没人再核对)、
    清掉错误码(红色警告消失)、把库里的单号写成上游那一张(插件真下成的那张
    订单从此不在任何系统里)。而 NEEDS_ACK 那道「先去买家号订单页确认过再动」的闸
    一次都没被问过 —— 回队列的四道闸都判这一位,转终态这条路也必须判。
    """
    task_id = _land(conn, status, error_code=error_code, may_have_ordered=True)
    got = task_intake.ingest(conn, [_row(amazon_order_no="111-2223334-5556667",
                                         price_cap=None)])
    assert got["conflicted"] == 1 and got["migrated"] == 0
    d = got["details"][0]
    assert d["result"] == "conflicted"
    # 措辞必须把人指向那件要做的事,而不只是说「没动」。
    assert "越过过下单点" in d["reason"] and "到底买了几次" in d["reason"]
    t = _task(conn)
    assert (t["status"], t["amazon_order_no"]) == (status, None)
    assert t["error_code"] == error_code       # 红色警告不许被这条路清掉
    assert t["purchase_source"] == "plugin"
    assert "purchased" not in _kinds(conn, task_id)


def test_dry_run_also_leaves_the_crossed_order_point_alone(conn, seed):
    """空跑与真跑判的是同一个 `_can_migrate`,越过下单点那一格也不例外。"""
    _land(conn, "manual", error_code="ORDER_CONFIRM_TIMEOUT", may_have_ordered=True)
    rows = [_row(amazon_order_no="111-2223334-5556667", price_cap=None)]
    preview = task_intake.dry_run(conn, rows)
    real = task_intake.ingest(conn, rows)
    for k in ("inserted", "duplicated", "rejected", "migrated", "conflicted"):
        assert preview[k] == real[k], k
    assert preview["details"][0]["reason"] == real["details"][0]["reason"]


# ── 上游给的采购时间 ────────────────────────────────────────────────────

def test_the_upstreams_own_purchased_at_is_what_lands(conn, seed):
    """上游给了采购时间就用它的,**不能换成同步那一天的 now()**。

    运营把上个月的外部单整理成一个文件灌进来,每行带 `purchased_at`。
    静默丢掉的话,40 张八月的单全部记成同步那一天 —— 「按采购时间」的筛选、
    统计、日限一起失真,而 docs/01 §10.1 写的是「上游给就用它的」。
    """
    task_intake.ingest(conn, [_row(amazon_order_no="111-2223334-5556667",
                                   price_cap=None,
                                   purchased_at="2026-08-12T03:00:00Z")])
    assert _task(conn)["purchased_at"] == datetime(2026, 8, 12, 3, 0,
                                                   tzinfo=timezone.utc)


def test_a_purchased_at_we_cannot_read_is_rejected_with_a_reason(conn, seed):
    """认不出的时间要拒成一条**带理由**的 rejected,不是静默当作没给。

    静默丢掉的代价不是「少一列数据」:那一格是人手填在上游那张表里的,
    填错是常态,而没人会去查一个从没报过错的字段。
    """
    got = task_intake.ingest(conn, [_row(amazon_order_no="111-2223334-5556667",
                                         price_cap=None, purchased_at="上个月")])
    assert got["rejected"] == 1 and got["inserted"] == 0
    assert "不是时间" in got["details"][0]["reason"]
    assert _task(conn) is None


# ── 缺列的外部行不许把整批带下水 ────────────────────────────────────────

def test_an_external_row_without_a_price_cap_key_at_all_lands(conn, seed):
    """README 与飞书字段表都说「外部单的限价可以不填」——那就包括**根本没有这个键**。

    这一格原先是下标取值:一行没有 `price_cap` 键的外部单会在落库时 KeyError,
    `pg_conn` 遇异常回滚**整批** —— 同批前面已经写进去的行连同 task_products
    一起没了,而 details 里一句解释都没有;空跑对同一行还说「将新增」。
    """
    row = _row(upstream_order_no="UP-NO-CAP", amazon_order_no="111-2223334-5556667")
    row.pop("price_cap")
    rows = [_row(), row]
    preview = task_intake.dry_run(conn, rows)
    got = task_intake.ingest(conn, rows)
    assert preview["inserted"] == got["inserted"] == 2
    # 同批那张普通单必须还在 —— 这条断言盯的是「整批回滚」那个后果本身。
    assert _task(conn, "UP-EXT-1") is not None
    t = _task(conn, "UP-NO-CAP")
    assert t["status"] == "purchased" and t["price_cap"] == Decimal("0.00")


def test_two_rows_in_one_batch_cannot_share_an_amz_order_no(conn, seed):
    """同一批里两行填了同一个 AMZ 单号:空跑与真跑必须报同一批数字。

    人手滑把同一个号填进两行是常事。真跑一直是拒的(第一行落库、第二行撞库),
    而空跑只查库、不记同批已经用掉的号,于是预览说「两行都会新增」——
    而这一批数字正是运营用来判断「这一轮同步对不对」的唯一依据。
    """
    rows = [_row(upstream_order_no="UP-A", amazon_order_no="111-2223334-5556667"),
            _row(upstream_order_no="UP-B", amazon_order_no="111-2223334-5556667",
                 products=[{"asin": "B0FB3VS68K", "quantity": 1}])]
    preview = task_intake.dry_run(conn, rows)
    real = task_intake.ingest(conn, rows)
    for k in ("inserted", "duplicated", "rejected", "migrated", "conflicted"):
        assert preview[k] == real[k], k
    assert preview["rejected"] == 1
    assert "这一批里出现了两次" in preview["details"][1]["reason"]


# ── 外部单不占本系统的额度,也不进本系统的分母 ──────────────────────────

def test_external_orders_do_not_eat_the_buyer_envs_daily_cap(conn, seed):
    """日限数的是**我们今天拍成了多少单**,外部单不算。

    上游把 40 张历史外部单一次填上 AMZ 单号,一轮同步之后这个买家号当天
    一单也派不出去 —— 而那些单根本不是本系统拍的。插件面板会写
    「待命 · 队列里没有本买家号的单」,运营台会写「已到日上限」,
    两句话都是假的。
    """
    env_id, inst_id, _ = seed
    conn.execute("UPDATE procure.buyer_envs SET daily_cap = 2 WHERE id = %s", (env_id,))
    for i in range(2):
        task_intake.ingest(conn, [_row(upstream_order_no=f"UP-EXT-{i}",
                                       amazon_order_no=f"111-222333{i}-5556667",
                                       price_cap=None,
                                       products=[{"asin": f"B0FB3VS6{i}0", "quantity": 1}])])
    assert task_queue.claim(conn, env_id, inst_id) is not None
    # 界面上那两个「今日已拍」必须跟真闸算同一个数 —— 分叉一次的表现是
    # 「可派」绿着而实际派不出,daily_cap 已经栽过一次。
    env = instance.list_with_liveness(conn, stale_seconds=90)[0]
    assert (env["purchased_today"], env["at_daily_cap"]) == (0, False)
    assert task_query.summary(conn)["purchased_today"] == 0


def test_external_orders_do_not_dilute_the_assert_skipped_denominator(conn, seed):
    """外部单不进「回填条数」这个分母 —— 它根本不过 ASIN 断言。

    分母被稀释的后果是这张卡片从此不会响:近 7 天真回填 4 单、1 单没采到 ASIN
    (25%,该报警),同期同步进来 500 张外部单,比例变成 0.2%。而这个指标存在的
    全部理由就是「断言整体失效时库里只剩一批看着完全正常的 purchased」。
    """
    before = ops_query.assert_skipped(conn)["backfills"]
    for i in range(5):
        task_intake.ingest(conn, [_row(upstream_order_no=f"UP-EXT-{i}",
                                       amazon_order_no=f"111-222333{i}-5556667",
                                       price_cap=None,
                                       products=[{"asin": f"B0FB3VS6{i}0", "quantity": 1}])])
    assert ops_query.assert_skipped(conn)["backfills"] == before == 0


def test_dry_run_writes_nothing(conn, seed):
    _land(conn, "ready")
    task_intake.dry_run(conn, [_row(amazon_order_no="111-2223334-5556667",
                                    price_cap=None)])
    assert _task(conn)["status"] == "ready"


# ── 摘要:人看到的那一份必须与 details 说同一件事 ────────────────────────

def test_the_file_entry_summary_says_what_actually_happened(conn, seed, tmp_path):
    """`cli.py task_intake` 那条入口的摘要必须报出「转外部下单」与「没动」。

    原先它只报新增/重复/拒收三个数、只逐条说 rejected:一轮把一张待拍单转成了
    已拍单、又撞上一条插件正在拍的单,终端上打出来的是三个 0 和一片空白,
    而其中那条要人立刻去买家号订单页看一眼的 conflicted 被过滤掉了。
    ingest 承诺「每一行的去向都会出现在 details 里」—— details 里确实有,
    人看的那份摘要里没有,那句承诺就只兑现了一半。
    """
    from workflows import task_intake as wf

    _land(conn, "ready")                                   # 这张会被转成外部下单
    task_intake.ingest(conn, [_row(upstream_order_no="UP-BUSY",
                                   products=[{"asin": "B0FB3VS68K", "quantity": 1}])])
    conn.execute("UPDATE procure.tasks SET status='claimed'"
                 " WHERE upstream_order_no='UP-BUSY'")
    conn.commit()

    rows = [_row(amazon_order_no="111-2223334-5556667", price_cap=None),
            _row(upstream_order_no="UP-BUSY", amazon_order_no="111-9998887-7776665",
                 price_cap=None, products=[{"asin": "B0FB3VS68K", "quantity": 1}])]
    f = tmp_path / "rows.json"
    f.write_text(json.dumps(rows), encoding="utf-8")

    preview = wf.run({"file": str(f), "dry_run": True})
    assert "转外部下单 1" in preview and "外部单号对不上 1" in preview
    # 「什么都不会变」和「会被改成已拍单」不许渲染成同一句话。
    assert "将转成外部下单" in preview and "已在库中" not in preview

    out = wf.run({"file": str(f)})
    assert "转外部下单 1" in out and "外部单号对不上 1" in out
    assert "插件正在拍这单" in out, "要人立刻去看的那一条必须出现在摘要里"


def test_both_entries_share_one_summary(conn, seed):
    """两条工作流的摘要拼装是**同一份**(services/task_intake.summarize)。

    副本的下场刚发生过:加了两个计数之后只改了飞书那一边。这条断言盯的是
    「同一批结果、两条入口报同样的数」,措辞里的量词不同不算分叉。
    """
    got = {"inserted": 1, "duplicated": 2, "rejected": 3, "migrated": 4,
           "conflicted": 5, "details": []}
    a = task_intake.summarize(got, total=15, unit="行", verb="落库完成")
    b = task_intake.summarize(got, total=15, unit="张订单", verb="同步完成")
    for n in ("新增 1", "重复 2", "拒收 3", "转外部下单 4", "外部单号对不上 5"):
        assert n in a and n in b, n


# ── 回写:外部单只写物流三列 ────────────────────────────────────────────

_FIELDS = {"amazon_order_no": "AMZ单号", "purchase_status": "采购状态",
           "purchased_at": "采购时间", "actual_total": "实付总计",
           "shipment_status": "物流状态", "carrier": "物流商", "tracking_no": "运单号"}


def test_writeback_does_not_echo_the_upstreams_own_order_no_back_at_it():
    """外部单只回写物流三列。

    采购状态、AMZ 单号、采购时间、实付**都是上游自己填进那张表的**。
    写回去有两个后果:轻的是把它填的东西抄给它看一遍(编辑历史刷成一片
    「机器人修改了此记录」);重的是我们那几格本来就是空的(外部单没有实付),
    写回去就是**把上游填的单号和时间清掉**。
    """
    row = {"status": "purchased", "purchase_source": "external",
           "amazon_order_no": "111-2223334-5556667", "purchased_at": None,
           "error_code": None, "actual_total": None,
           "shipment_status": "in_transit", "carrier": "UPS", "tracking_no": "1Z999"}
    got = feishu_writeback.build(row, _FIELDS)
    assert got == {"物流状态": "运输中", "物流商": "UPS", "运单号": "1Z999"}


def test_writeback_still_writes_everything_for_a_manual_backfill():
    """人工回填照旧全写:那个单号是**我们这边**的人写进去的,上游还不知道。"""
    row = {"status": "purchased", "purchase_source": "manual_backfill",
           "amazon_order_no": "111-2223334-5556667", "purchased_at": None,
           "error_code": None, "actual_total": None,
           "shipment_status": None, "carrier": None, "tracking_no": None}
    got = feishu_writeback.build(row, _FIELDS)
    assert got["AMZ单号"] == "111-2223334-5556667"
    assert got["采购状态"] == "已拍单"


def test_a_row_with_nothing_left_to_write_is_skipped_not_sent_empty():
    """一格都没得写时**不发空更新** —— 飞书那边一次空 fields 照样算一次修改。"""
    fields = {"amazon_order_no": "AMZ单号", "purchase_status": "采购状态"}
    rows = [{"id": 1, "external_id": "rec1", "upstream_order_no": "UP-1",
             "pushed_hash": None, "status": "purchased", "purchase_source": "external",
             "amazon_order_no": "111-2223334-5556667", "purchased_at": None,
             "error_code": None, "actual_total": None, "shipment_status": None,
             "carrier": None, "tracking_no": None}]
    got = feishu_writeback.plan(rows, fields)
    assert got["updates"] == [] and got["skipped"] == 1


# ── 人工回填也有自己的来源 ──────────────────────────────────────────────

def test_force_backfill_is_its_own_source(conn, seed):
    """强制回填 ≠ 外部下单:一个是我们这边的人写的,一个是上游在别处买的。

    分不开的话,「回头查有没有挂错单号」时看不出该查哪一批 ——
    而**断言被跳过的正是强制回填那一批**。
    """
    task_intake.ingest(conn, [_row()])
    t = _task(conn)
    conn.execute("UPDATE procure.tasks SET status='manual' WHERE id=%s", (t["id"],))
    task_admin.force_backfill(conn, t["id"], "111-2223334-5556667",
                              note="去订单页看过了", operator="李四")
    assert _task(conn)["purchase_source"] == "manual_backfill"


# ── 渲染:「不适用」不是「未超」,也不是「未核」────────────────────────

def test_over_cap_says_not_applicable_for_an_external_order():
    """三种情况三句话。

    「未核」说的是「本该核、这次没核成」(金额没回传、读成了 0),看到它的人会去查;
    外部单**根本没有限价这回事**。渲染成同一句会让人去查一批其实一切正常的单;
    渲染成「否」更糟 —— 那是一句护栏从没做过的结论。
    """
    ext = {"purchase_source": "external", "price_cap": Decimal("0.00"),
           "goods_total": None, "actual_total": None}
    assert task_query.over_cap(ext) == task_query.CAP_NOT_APPLICABLE
    assert task_query.over_cap({**ext, "purchase_source": "plugin"}) == "未核"
    assert task_query.over_cap({"purchase_source": "plugin", "price_cap": Decimal("10"),
                                "goods_total": Decimal("12"), "actual_total": None}) == "是"


def test_export_carries_the_source_column(conn, seed, client):
    task_intake.ingest(conn, [_row(amazon_order_no="111-2223334-5556667",
                                   price_cap=None)])
    conn.commit()
    r = client.post("/v1/admin/tasks/export", json={})
    body = r.content.decode("utf-8-sig")
    assert "来源" in body.splitlines()[0]
    assert "外部下单" in body
    # 「是否超限价」那一列同样不许说「否」
    assert task_query.CAP_NOT_APPLICABLE in body


def test_search_can_filter_by_source(conn, seed, client):
    task_intake.ingest(conn, [
        _row(upstream_order_no="UP-EXT", price_cap=None,
             amazon_order_no="111-2223334-5556667"),
        _row(upstream_order_no="UP-PLUGIN"),
    ])
    conn.commit()
    r = client.post("/v1/admin/tasks/search", json={"purchase_source": "external"})
    items = r.json()["data"]["items"]
    assert [i["upstream_order_no"] for i in items] == ["UP-EXT"]
    r = client.post("/v1/admin/tasks/search", json={})
    assert {i["purchase_source"] for i in r.json()["data"]["items"]} >= {"external", "plugin"}


def test_import_endpoint_accepts_an_amz_order_no(client, seed):
    """admin import 与飞书那条路走的是同一套 —— 契约在 server/schemas.IntakeRow。"""
    r = client.post("/v1/admin/tasks/import", json={"rows": [
        {**_row(amazon_order_no="111-2223334-5556667"), "price_cap": None},
    ]})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["inserted"] == 1


def test_meta_ships_the_purchase_source_vocabulary(client):
    """界面上只出中文,而中文只有一个来源。"""
    from services import vocab

    got = client.get("/v1/admin/meta").json()["data"]["purchase_source"]
    assert got["labels"] == vocab.PURCHASE_SOURCE_LABELS
    assert set(got["labels"]) == task_intake.PURCHASE_SOURCES
    assert set(got["tone"]) == task_intake.PURCHASE_SOURCES
