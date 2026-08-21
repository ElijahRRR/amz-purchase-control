"""任务落库:上游采购行 → procure.tasks。

这是整套系统的入口 —— 没有它库里一条任务都不会有。
"""

import pytest


def _row(**over):
    row = {
        "upstream_order_no": "UP-30001",
        "buyer_env_code": "env-172",
        "ship_name": "Garcia Isabel", "ship_phone": "+1 714-555-2081",
        "ship_line1": "2510 S Shelton St", "ship_city": "Santa Ana",
        "ship_state": "CA", "ship_postcode": "92707",
        "price_cap": "12.50",
        "products": [{"asin": "B0FB3VS68J", "quantity": 1}],
    }
    row.update(over)
    return row


def test_ingest_inserts_and_defaults_to_pending(client, conn, seed):
    r = client.post("/v1/admin/tasks/import", json={"rows": [_row()]})
    data = r.json()["data"]
    assert data["inserted"] == 1
    task_id = data["details"][0]["task_id"]

    row = conn.execute("SELECT status, marketplace, max_delivery_days FROM procure.tasks "
                       "WHERE id = %s", (task_id,)).fetchone()
    # 落库与放行分开:中间这一格里护栏参数还能改,改完再放出去
    assert row["status"] == "pending"
    assert row["marketplace"] == "US" and row["max_delivery_days"] == 7


def test_ingest_release_lands_ready(client, seed):
    r = client.post("/v1/admin/tasks/import", json={"rows": [_row()], "release": True})
    assert r.json()["data"]["inserted"] == 1
    s = client.post("/v1/admin/tasks/search", json={"status": "ready"}).json()["data"]
    assert any(i["upstream_order_no"] == "UP-30001" for i in s["items"])


def test_release_endpoint_moves_pending_to_ready(client, seed):
    tid = client.post("/v1/admin/tasks/import",
                      json={"rows": [_row()]}).json()["data"]["details"][0]["task_id"]
    assert client.post(f"/v1/admin/tasks/{tid}/release", json={}).json()["data"]["status"] == "ready"
    # 放过一次之后不能再放
    again = client.post(f"/v1/admin/tasks/{tid}/release", json={})
    assert again.status_code == 409 and again.json()["error"]["code"] == "BAD_STATUS"


def test_line_key_covers_the_whole_product_set(client, seed):
    """一条 task = 一张上游订单 = 一次 Amazon 下单,里面可以有多个商品。

    键只拿其中一个 ASIN 的话,同一张上游订单换个商品组合就会被当成新单重复落库。
    """
    from services.task_intake import line_key

    a = line_key("UP-1", [{"asin": "B0A", "quantity": 1}, {"asin": "B0B", "quantity": 2}])
    # 顺序不影响
    b = line_key("UP-1", [{"asin": "B0B", "quantity": 2}, {"asin": "B0A", "quantity": 1}])
    assert a == b
    # 数量变了就是另一单
    c = line_key("UP-1", [{"asin": "B0A", "quantity": 1}, {"asin": "B0B", "quantity": 3}])
    assert c != a
    # 少一个商品也是另一单 —— 这正是「只拿第一个 asin」会漏掉的那种
    d = line_key("UP-1", [{"asin": "B0A", "quantity": 1}])
    assert d != a


def test_ingest_reports_duplicates_instead_of_silently_dropping(client, seed):
    """厂商那套导入回一句「导入成功」就完了,少了几行没人知道。"""
    client.post("/v1/admin/tasks/import", json={"rows": [_row()]})
    r = client.post("/v1/admin/tasks/import", json={"rows": [_row()]})
    data = r.json()["data"]
    assert data["inserted"] == 0 and data["duplicated"] == 1
    assert data["details"][0]["result"] == "duplicated"


def test_ingest_rejects_nonpositive_price_cap(client, seed):
    """限价是护栏的输入。0 会让「实付 ≤ 限价」永远不成立,整批单全卡在待人工。

    这种错要在入口拦下,不能等到插件跑到结算页才发现。
    """
    r = client.post("/v1/admin/tasks/import", json={"rows": [_row(price_cap="0")]})
    data = r.json()["data"]
    assert data["rejected"] == 1
    assert "price_cap" in data["details"][0]["reason"]


def test_ingest_rejects_unknown_buyer_env(client, seed):
    r = client.post("/v1/admin/tasks/import", json={"rows": [_row(buyer_env_code="env-999")]})
    d = r.json()["data"]
    assert d["rejected"] == 1 and "env-999" in d["details"][0]["reason"]


def test_ingest_rejects_non_us_marketplace(client, seed):
    r = client.post("/v1/admin/tasks/import", json={"rows": [_row(marketplace="JP")]})
    assert r.json()["data"]["rejected"] == 1


def test_ingest_rejects_bad_quantity(client, seed):
    r = client.post("/v1/admin/tasks/import",
                    json={"rows": [_row(products=[{"asin": "B0FB3VS68J", "quantity": 0}]) ]})
    assert r.json()["data"]["rejected"] == 1


def test_ingest_mixed_batch_accounts_for_every_row(client, seed):
    """一批里有好有坏时,每一行的去向都必须能对上号。"""
    rows = [
        _row(upstream_order_no="UP-40001"),
        _row(upstream_order_no="UP-40002", price_cap="-1"),
        _row(upstream_order_no="UP-40001"),          # 与第一行同键
        _row(upstream_order_no="UP-40003", buyer_env_code="env-nope"),
    ]
    d = client.post("/v1/admin/tasks/import", json={"rows": rows}).json()["data"]
    assert (d["inserted"], d["duplicated"], d["rejected"]) == (1, 1, 2)
    assert len(d["details"]) == 4
    assert [x["index"] for x in d["details"]] == [0, 1, 2, 3]


def test_ingest_multi_product_task(client, conn, seed):
    r = client.post("/v1/admin/tasks/import", json={"rows": [_row(
        upstream_order_no="UP-50001",
        products=[{"asin": "B0FB3VS68J", "quantity": 1},
                  {"asin": "B0CHXNPXVX", "quantity": 3}])]})
    tid = r.json()["data"]["details"][0]["task_id"]
    got = conn.execute("SELECT asin, quantity FROM procure.task_products "
                       " WHERE task_id = %s ORDER BY asin", (tid,)).fetchall()
    assert [(g["asin"], g["quantity"]) for g in got] == [
        ("B0CHXNPXVX", 3), ("B0FB3VS68J", 1)]


def test_dry_run_agrees_with_the_real_run(conn, seed):
    """空跑的数字必须与真跑一致。

    只做字段校验、不查库的空跑会少报拒收行数(买家号不存在、这一行已经落过,
    都要查过才知道)。「预览与真跑对不上」的空跑比没有空跑更误导人 ——
    人看了空跑说 3 行都能进,真跑只进了 1 行,而他已经不看输出了。
    """
    from services import task_intake

    rows = [
        _row(upstream_order_no="UP-70001"),
        _row(upstream_order_no="UP-70002", price_cap="0"),
        _row(upstream_order_no="UP-70003", buyer_env_code="env-nope"),
        _row(upstream_order_no="UP-70001"),          # 同批内重复
    ]
    preview = task_intake.dry_run(conn, rows)
    real = task_intake.ingest(conn, rows)

    assert (preview["inserted"], preview["duplicated"], preview["rejected"]) == \
           (real["inserted"], real["duplicated"], real["rejected"])
    assert [d["result"] for d in preview["details"]] == [d["result"] for d in real["details"]]


def test_dry_run_writes_nothing(conn, seed):
    from services import task_intake

    before = conn.execute("SELECT count(*) c FROM procure.tasks").fetchone()["c"]
    task_intake.dry_run(conn, [_row(upstream_order_no="UP-80001")])
    after = conn.execute("SELECT count(*) c FROM procure.tasks").fetchone()["c"]
    assert before == after


def test_dry_run_catches_what_would_crash_ingest(conn, seed):
    """dry_run 必须覆盖 ingest 真正做的类型转换。

    少了这两条:dry_run 说「都能进」,ingest 走到那一行时抛 ValueError/AttributeError,
    pg_conn 回滚 —— **连同已经写进去的前几行一起** —— 最终 0 行落库,
    而且 details 里一句解释都没有。人看了空跑以为没问题,真跑一条都没进。
    """
    from services import task_intake

    bad_days = _row(upstream_order_no="UP-BAD1", max_delivery_days="7 天")
    bad_asin = _row(upstream_order_no="UP-BAD2",
                    products=[{"asin": 630509311712, "quantity": 1}])

    preview = task_intake.dry_run(conn, [_row(upstream_order_no="UP-OK1"), bad_days, bad_asin])
    assert preview["inserted"] == 1 and preview["rejected"] == 2
    assert "max_delivery_days" in preview["details"][1]["reason"]
    assert "asin" in preview["details"][2]["reason"]

    real = task_intake.ingest(conn, [_row(upstream_order_no="UP-OK1"), bad_days, bad_asin])
    assert (real["inserted"], real["rejected"]) == (1, 2)
