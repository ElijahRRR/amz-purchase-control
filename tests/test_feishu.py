"""飞书多维表格拉单。

全部用假 transport 跑,**不联网** —— 一个必须联网才能跑的测试等于没有测试:
CI 上一断网就红,人就会开始忽略它。
"""

import json

import pytest

from api import feishu
from services import feishu_intake


# ── 假 transport ────────────────────────────────────────────────────────

def fake(pages: dict[str, dict], *, log: list | None = None):
    """输入:{URL 片段: 响应体} → 输出:一个可以塞进 Client 的 transport。"""
    def transport(url, *, method, headers, body, timeout):
        if log is not None:
            log.append((method, url, json.loads(body) if body else None, headers))
        for frag, resp in pages.items():
            if frag in url:
                payload = resp() if callable(resp) else resp
                return payload.get("_http", 200), json.dumps(payload).encode()
        raise AssertionError(f"假 transport 没准备这个 URL:{url}")
    return transport


TOKEN_OK = {"code": 0, "msg": "ok", "tenant_access_token": "t-abc", "expire": 7200}


def client(pages, **kw):
    return feishu.Client(app_id="cli_x", app_secret="s", transport=fake(pages, **kw))


# ── 值形状 ──────────────────────────────────────────────────────────────

def test_flatten_keeps_multi_select_a_list_but_joins_rich_text():
    """摊平不能把多选拼成一个词。

    多选 `["加急","补发"]` 拼成 `"加急补发"` 会得到一个既不是「加急」
    也不是「补发」的值,而且看起来完全正常 —— 这种错不会报,只会一直错下去。
    判据是「每一项都是带 text 键的 dict」,那是富文本片段独有的形状。
    """
    assert feishu.flatten([{"type": "text", "text": "UP-"},
                           {"type": "text", "text": "20841"}]) == "UP-20841"
    assert feishu.flatten(["加急", "补发"]) == ["加急", "补发"]
    assert feishu.flatten([{"id": "ou_x", "name": "张三"}]) == ["张三"]
    assert feishu.flatten({"text": "点我", "link": "https://x"}) == "点我"
    assert feishu.flatten(92707.0) == 92707.0


def test_number_columns_do_not_become_floats_in_the_address():
    """飞书数字列一律回 float。邮编 92707 变成 "92707.0" 会让地址填错。"""
    assert feishu_intake._text(92707.0) == "92707"
    assert feishu_intake._text(12.5) == "12.5"


def test_a_two_person_cell_does_not_become_one_glued_name():
    """「收件人」那一格里两个名字,拼起来会真的按这个名字寄出去。"""
    assert feishu_intake._text(["张三", "李四"]) == "张三"


# ── 客户端 ──────────────────────────────────────────────────────────────

def test_token_is_fetched_once_and_reused():
    log: list = []
    c = client({"tenant_access_token": TOKEN_OK,
                "/records": {"code": 0, "data": {"items": [], "has_more": False}}},
               log=log)
    list(c.iter_records("bas", "tbl"))
    list(c.iter_records("bas", "tbl"))
    assert sum(1 for m in log if "tenant_access_token" in m[1]) == 1


def test_a_config_error_is_not_retried_but_rate_limiting_is():
    """「配错了」和「暂时不通」必须分开 —— 前者重试一万次也一样。"""
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] <= 2:
            return {"code": 99991400, "msg": "too many request", "_http": 429}
        return {"code": 0, "data": {"items": [], "has_more": False}}

    c = feishu.Client(app_id="a", app_secret="b", timeout=1,
                      transport=fake({"tenant_access_token": TOKEN_OK, "/records": flaky}))
    import time as _t
    _sleep, _t.sleep = _t.sleep, lambda *_: None       # 别在测试里真等 1+2 秒
    try:
        assert list(c.iter_records("bas", "tbl")) == []
        assert calls["n"] == 3
    finally:
        _t.sleep = _sleep

    c2 = client({"tenant_access_token": TOKEN_OK,
                 "/records": {"code": 91402, "msg": "NOTEXIST", "_http": 404}})
    with pytest.raises(feishu.FeishuError) as exc:
        list(c2.iter_records("bas", "tbl"))
    assert exc.value.code == 91402 and exc.value.retryable is False


def test_missing_credentials_says_where_to_put_them():
    c = feishu.Client(app_id="", app_secret="", transport=fake({}))
    with pytest.raises(feishu.FeishuError) as exc:
        list(c.iter_records("bas", "tbl"))
    assert ".env" in str(exc.value)


def test_pagination_walks_every_page():
    pages = iter([
        {"code": 0, "data": {"items": [{"record_id": "r1", "fields": {"a": "1"}}],
                             "has_more": True, "page_token": "p2"}},
        {"code": 0, "data": {"items": [{"record_id": "r2", "fields": {"a": "2"}}],
                             "has_more": False}},
    ])
    c = client({"tenant_access_token": TOKEN_OK, "/records": lambda: next(pages)})
    got = list(c.iter_records("bas", "tbl"))
    assert [r["record_id"] for r in got] == ["r1", "r2"]


def test_has_more_without_a_page_token_raises_instead_of_stopping_quietly():
    """飞书说还有下一页却不给 token —— 再翻是死循环,静默停下是假装拉全了。"""
    c = client({"tenant_access_token": TOKEN_OK,
                "/records": {"code": 0, "data": {"items": [], "has_more": True}}})
    with pytest.raises(feishu.FeishuError, match="page_token"):
        list(c.iter_records("bas", "tbl"))


def test_hitting_the_record_cap_raises_instead_of_truncating():
    """到上限要报错,**不能静默截断** —— 静默截断会让上游以为单子都同步了。"""
    many = [{"record_id": f"r{i}", "fields": {}} for i in range(10)]
    c = client({"tenant_access_token": TOKEN_OK,
                "/records": {"code": 0, "data": {"items": many, "has_more": False}}})
    with pytest.raises(feishu.FeishuError, match="上限"):
        list(c.iter_records("bas", "tbl", max_records=5))


# ── 映射与合并 ──────────────────────────────────────────────────────────

MAP = {
    "fields": {
        "upstream_order_no": "上游单号", "buyer_env_code": "买家号",
        "asin": "ASIN", "quantity": "数量", "price_cap": "限价",
        "max_delivery_days": "最迟送达天数",
        "ship_name": "收件人", "ship_phone": "电话", "ship_line1": "地址",
        "ship_city": "城市", "ship_state": "州", "ship_postcode": "邮编",
        "marketplace": "站点",
    },
    "row_is": "product", "take_column": "", "take_equals": [],
}


def _rec(rid, **over):
    fields = {"上游单号": "UP-1", "买家号": "env-172", "ASIN": "B0AAAAAAAA", "数量": 1.0,
              "限价": 19.99, "收件人": "Chen Wei", "电话": "5551234",
              "地址": "1 Main St", "城市": "Santa Ana", "州": "CA", "邮编": 92707.0}
    fields.update(over)
    return {"record_id": rid, "fields": fields}


def test_rows_of_the_same_order_become_one_task_not_three():
    """**这是整条链上最要紧的一条。**

    飞书里通常一行一个商品,同一张上游订单占好几行。照单全收地一行落一条任务,
    同一张订单就变成 N 条任务,插件会在 Amazon 上**买 N 次**。
    line_key 拦不住 —— 它是 sha256(上游单号|商品集合),每行的商品集合都不一样,
    算出来就是 N 个不同的键,每一个都是「新行」。合并不是优化,是正确性。
    """
    got = feishu_intake.to_rows([
        _rec("r1", ASIN="B0AAAAAAAA", 数量=1.0),
        _rec("r2", ASIN="B0BBBBBBBB", 数量=2.0),
        _rec("r3", ASIN="B0CCCCCCCC", 数量=1.0),
    ], MAP)

    assert len(got["rows"]) == 1, "同一个上游单号的三行没有合并 —— 会在 Amazon 上买三次"
    row = got["rows"][0]
    assert row["upstream_order_no"] == "UP-1"
    assert sorted(p["asin"] for p in row["products"]) == \
        ["B0AAAAAAAA", "B0BBBBBBBB", "B0CCCCCCCC"]
    assert [p["quantity"] for p in row["products"]] == ["1", "2", "1"]


def test_different_orders_stay_separate():
    got = feishu_intake.to_rows([_rec("r1"), _rec("r2", 上游单号="UP-2")], MAP)
    assert sorted(r["upstream_order_no"] for r in got["rows"]) == ["UP-1", "UP-2"]


def test_conflicting_address_across_rows_of_one_order_is_reported_not_swallowed():
    """同一个单号的两行给了不同地址 —— 上游多半把两张单填成了同一个号。

    静默取第一行了事的话,包裹会按第一行那个地址寄出去,而没有任何人知道
    第二行写的是别的地方。
    """
    got = feishu_intake.to_rows([
        _rec("r1", 城市="Santa Ana"),
        _rec("r2", ASIN="B0BBBBBBBB", 城市="Boston"),
    ], MAP)
    assert len(got["rows"]) == 1
    assert got["rows"][0]["ship_city"] == "Santa Ana"        # 按先出现的落库
    assert [c["field"] for c in got["conflicts"]] == ["ship_city"]
    assert got["conflicts"][0]["later"] == "Boston"


def test_a_row_without_an_order_number_is_not_dropped_silently():
    """没单号的行照样往下走,让 ingest 拒收并逐条报出来。

    在映射这一层静默丢掉的话,上游会以为这一行同步了。
    """
    got = feishu_intake.to_rows([_rec("r1", 上游单号="")], MAP)
    assert len(got["rows"]) == 1
    assert "无单号" in got["rows"][0]["upstream_order_no"]


def test_take_when_filters_are_reported_separately_from_rejections():
    """「没轮到它」和「它有问题」是两回事,混在一起会让人去查一批没毛病的行。"""
    m = {**MAP, "take_column": "状态", "take_equals": ["待采购"]}
    got = feishu_intake.to_rows([
        _rec("r1", 状态="待采购"),
        _rec("r2", 上游单号="UP-2", 状态="已完成"),
        _rec("r3", 上游单号="UP-3", 状态=["待采购"]),      # 单选被存成多选
    ], m)
    assert sorted(r["upstream_order_no"] for r in got["rows"]) == ["UP-1", "UP-3"]
    assert [s["value"] for s in got["skipped"]] == ["已完成"]


def test_order_mode_splits_the_comma_separated_columns():
    """「一行一整单」模式:ASIN 与数量列里是逗号分隔的多个值。"""
    m = {**MAP, "row_is": "order"}
    got = feishu_intake.to_rows(
        [_rec("r1", ASIN="B0AAAAAAAA, B0BBBBBBBB;B0CCCCCCCC", 数量="1,2,3")], m)
    row = got["rows"][0]
    assert [p["asin"] for p in row["products"]] == \
        ["B0AAAAAAAA", "B0BBBBBBBB", "B0CCCCCCCC"]
    assert [p["quantity"] for p in row["products"]] == ["1", "2", "3"]


def test_order_mode_applies_a_single_quantity_to_every_asin():
    m = {**MAP, "row_is": "order"}
    got = feishu_intake.to_rows([_rec("r1", ASIN="B0AAAAAAAA,B0BBBBBBBB", 数量=2.0)], m)
    assert [p["quantity"] for p in got["rows"][0]["products"]] == ["2", "2"]


def test_optional_columns_fall_back_to_defaults():
    got = feishu_intake.to_rows([_rec("r1")], MAP)     # 表里没有「最迟送达天数」「站点」
    assert got["rows"][0]["max_delivery_days"] == "7"
    assert got["rows"][0]["marketplace"] == "US"


def test_the_shipped_mapping_file_loads_and_covers_every_required_field():
    """仓库里那份默认映射必须是能用的 —— 缺一列会在同步时变成整表拒收。"""
    m = feishu_intake.load_mapping()
    assert m["row_is"] in ("product", "order")
    for f in (*feishu_intake._ROW_FIELDS, "asin", "quantity"):
        if f not in feishu_intake._OPTIONAL:
            assert m["fields"].get(f), f"默认映射缺 {f}"


def test_a_broken_mapping_fails_loudly_before_any_row_is_touched(tmp_path):
    """映射错了要在开跑前就抛。

    拿着一份错映射去跑同步,结果是「全表 300 行全部拒收:缺字段 upstream_order_no」,
    看的人第一反应会是上游把表填坏了,而不是我们的映射写错了。
    """
    bad = tmp_path / "m.json"
    bad.write_text(json.dumps({"fields": {"upstream_order_no": "单号"}}), encoding="utf-8")
    with pytest.raises(feishu_intake.MappingError, match="没给列名"):
        feishu_intake.load_mapping(bad)

    bad.write_text("{ 这不是 json", encoding="utf-8")
    with pytest.raises(feishu_intake.MappingError, match="JSON"):
        feishu_intake.load_mapping(bad)

    bad.write_text(json.dumps({"fields": {f: f for f in
                                          (*feishu_intake._ROW_FIELDS, "asin", "quantity")},
                               "_一行是什么": "whatever"}), encoding="utf-8")
    with pytest.raises(feishu_intake.MappingError, match="product / order"):
        feishu_intake.load_mapping(bad)


# ── 端到端:假飞书 + 真库 ────────────────────────────────────────────────

def _table(records):
    """输入:记录 → 输出:一份假的飞书响应集。"""
    return {"tenant_access_token": TOKEN_OK,
            "/records": {"code": 0, "data": {"items": records, "has_more": False}}}


@pytest.fixture()
def feishu_table(monkeypatch):
    """输入:记录 → 输出:接好线的假飞书(表标识、Client、映射一起换掉)。

    先把真的 Client 抓在手里再打桩 —— 直接写
    `lambda **kw: feishu.Client(...)` 会在打完桩之后调到桩自己身上,
    无限递归。
    """
    real_client = feishu.Client

    def install(records, mapping=None):
        from registry import settings

        monkeypatch.setattr(settings, "feishu_app_token", lambda: "bas")
        monkeypatch.setattr(settings, "feishu_table_id", lambda: "tbl")
        monkeypatch.setattr(settings, "feishu_view_id", lambda: "")
        monkeypatch.setattr(
            feishu, "Client",
            lambda **kw: real_client(app_id="a", app_secret="b",
                                     transport=fake(_table(records))))
        monkeypatch.setattr(feishu_intake, "load_mapping",
                            lambda *a, **k: mapping or MAP)

    return install


def test_sync_lands_one_task_per_order_and_is_idempotent(conn, feishu_table):
    """跑两遍,库里还是那几张单 —— 这条链每轮全量拉,幂等性全靠 line_key。"""
    from workflows import feishu_sync

    conn.execute("INSERT INTO procure.buyer_envs (code) VALUES ('env-172')")
    conn.commit()

    records = [_rec("r1", ASIN="B0AAAAAAAA", 数量=1.0),
               _rec("r2", ASIN="B0BBBBBBBB", 数量=2.0),        # 同一张单的第二个商品
               _rec("r3", 上游单号="UP-2", ASIN="B0CCCCCCCC", 数量=1.0)]

    feishu_table(records)

    first = feishu_sync.run({"release": True})
    assert "新增 2" in first, first
    assert "3 条记录 → 合并成 2 张订单" in first

    rows = conn.execute(
        "SELECT upstream_order_no, status FROM procure.tasks ORDER BY 1").fetchall()
    assert [r["upstream_order_no"] for r in rows] == ["UP-1", "UP-2"]
    assert all(r["status"] == "ready" for r in rows)

    prods = conn.execute(
        """SELECT p.asin FROM procure.task_products p
             JOIN procure.tasks t ON t.id = p.task_id
            WHERE t.upstream_order_no = 'UP-1' ORDER BY p.asin""").fetchall()
    assert [p["asin"] for p in prods] == ["B0AAAAAAAA", "B0BBBBBBBB"], \
        "两个商品要落在同一张任务下 —— 拆开就是在 Amazon 上买两次"

    second = feishu_sync.run({"release": True})
    assert "新增 0" in second and "重复 2" in second
    assert conn.execute("SELECT count(*) AS n FROM procure.tasks").fetchone()["n"] == 2


def test_sync_dry_run_reads_the_db_and_matches_the_real_run(conn, feishu_table):
    """空跑要与真跑一致 —— 只做字段校验的空跑会少报拒收行数。"""
    from workflows import feishu_sync

    conn.execute("INSERT INTO procure.buyer_envs (code) VALUES ('env-172')")
    conn.commit()

    records = [_rec("r1"), _rec("r2", 上游单号="UP-2", 买家号="env-nope")]
    feishu_table(records)

    preview = feishu_sync.run({"dry_run": True})
    assert "将新增 1" in preview and "拒收 1" in preview
    assert "env-nope" in preview, "拒收理由要点名是哪个买家号不存在"
    assert conn.execute("SELECT count(*) AS n FROM procure.tasks").fetchone()["n"] == 0

    real = feishu_sync.run({})
    assert "新增 1" in real and "拒收 1" in real


def test_sync_reports_a_conflicting_address_in_the_summary(conn, feishu_table):
    """单号冲突要出现在同步摘要里,而不是只在某个字典里躺着。"""
    from workflows import feishu_sync

    conn.execute("INSERT INTO procure.buyer_envs (code) VALUES ('env-172')")
    conn.commit()

    records = [_rec("r1", 城市="Santa Ana"),
               _rec("r2", ASIN="B0BBBBBBBB", 城市="Boston")]
    feishu_table(records)

    got = feishu_sync.run({})
    assert "单号冲突" in got and "Boston" in got


# ── 监控 ────────────────────────────────────────────────────────────────

def test_feishu_sync_is_watched_as_a_scheduled_workflow(client, conn):
    """拉单这条链停了要看得见。

    它停了,新单一张都进不来 —— 而界面上「队列待拍 0」跟「今天上游确实没派单」
    长得一模一样,不会有人觉得不对。
    """
    by = {r["workflow"]: r
          for r in client.get("/v1/admin/runs").json()["data"]["by_workflow"]}
    assert by["feishu_sync"]["scheduled"] is True
    assert by["feishu_sync"]["overdue"] is True, "一次都没跑过,而它是必须定时的"
    assert by["feishu_probe"]["scheduled"] is False, "探针是按需跑的,不该报警"


def test_the_sync_freshness_threshold_follows_the_configured_cadence(client, conn,
                                                                     monkeypatch):
    """阈值可配 —— 写死的话,改成低频跑的人会得到一格**永远红着的卡片**,
    而一格永远红着的卡片会把人训练成忽略红色。"""
    from registry import settings

    conn.execute("""INSERT INTO ops.runs (workflow, params, started_at, finished_at,
                                          status, summary, operator)
                    VALUES ('feishu_sync','{}'::jsonb, now() - interval '90 minutes',
                            now() - interval '90 minutes','success','同步完成','cron')""")
    conn.commit()

    monkeypatch.setattr(settings, "feishu_sync_max_age_minutes", lambda: 120)
    by = {r["workflow"]: r
          for r in client.get("/v1/admin/runs").json()["data"]["by_workflow"]}
    assert by["feishu_sync"]["overdue"] is False, "90 分钟前跑过,阈值 120 分钟"

    monkeypatch.setattr(settings, "feishu_sync_max_age_minutes", lambda: 60)
    by = {r["workflow"]: r
          for r in client.get("/v1/admin/runs").json()["data"]["by_workflow"]}
    assert by["feishu_sync"]["overdue"] is True, "阈值收紧到 60 分钟就该红"
