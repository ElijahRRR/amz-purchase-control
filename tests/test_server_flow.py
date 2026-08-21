"""P1 验收:不碰 Amazon,跑通 注册 → 认领 → 上报 → 完成/失败 → 状态流转。"""

import pytest

UID = "inst-mock-A"


def _register(client, env_code="env-172"):
    r = client.post("/v1/instances/register",
                    json={"env_code": env_code, "instance_uid": UID,
                          "plugin_version": "0.1.0"})
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _claim(client):
    r = client.post("/v1/tasks/claim", json={"instance_uid": UID})
    assert r.status_code == 200, r.text
    return r.json()["data"]


def test_health(client):
    assert client.get("/health").json()["ok"] is True


def test_register_unknown_env_404(client, seed):
    r = client.post("/v1/instances/register",
                    json={"env_code": "nope", "instance_uid": UID})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "ENV_NOT_FOUND"


def test_register_is_idempotent(client, seed):
    a = _register(client)
    b = _register(client)
    assert a["instance_id"] == b["instance_id"]


def test_heartbeat_requires_registration(client, seed):
    r = client.post("/v1/instances/heartbeat", json={"instance_uid": "ghost"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "INSTANCE_NOT_REGISTERED"


def test_claim_returns_full_task_payload(client, seed):
    _register(client)
    data = _claim(client)
    assert data["marketplace"] == "US"
    assert data["shipping"]["postcode"] == "92707"
    assert data["products"] == [{"asin": "B0FB3VS68J", "quantity": 1}]
    assert data["guards"]["price_cap"] == "12.50"
    assert data["guards"]["max_delivery_days"] == 7


def test_claim_returns_null_when_env_paused(client, conn, seed):
    _register(client)
    conn.execute("UPDATE procure.buyer_envs SET status='paused'")
    assert _claim(client) is None


def test_claim_returns_null_when_nothing_ready(client, conn, seed):
    _register(client)
    conn.execute("UPDATE procure.tasks SET status='pending'")
    assert _claim(client) is None


# ── 护栏 ────────────────────────────────────────────────────────────────

def test_guard_allows_within_cap(client, seed):
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "10.79",
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    assert r.json()["data"]["allow"] is True


def test_guard_blocks_over_price_cap(client, seed):
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "99.00",
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    d = r.json()["data"]
    assert d["allow"] is False and d["error_code"] == "PRICE_CAP_EXCEEDED"


def test_guard_blocks_non_fba(client, seed):
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "1.00",
        "delivery_raw": "Tomorrow", "is_fba": False,
    })
    assert r.json()["data"]["error_code"] == "NOT_FBA"


def test_guard_blocks_unparseable_delivery(client, seed):
    """解析不出来不放行 —— 厂商那边是弹窗让操作员选『继续下单』。"""
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "1.00",
        "delivery_raw": "Arriving after Christmas", "is_fba": True,
    })
    assert r.json()["data"]["error_code"] == "DELIVERY_UNPARSEABLE"


def test_guard_block_is_recorded_as_event(client, conn, seed):
    _register(client)
    t = _claim(client)
    client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "99.00",
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    row = conn.execute(
        "SELECT kind, code FROM procure.task_events WHERE task_id=%s ORDER BY id DESC LIMIT 1",
        (t["task_id"],),
    ).fetchone()
    assert row == {"kind": "guard_block", "code": "PRICE_CAP_EXCEEDED"}


# ── 完成与断言 ──────────────────────────────────────────────────────────

def test_complete_backfills(client, conn, seed):
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-2223334-4445556",
        "actual_total": "10.79", "payment_last4": "7883",
        "delivery_raw": "August 27", "observed_asins": ["B0FB3VS68J"],
    })
    assert r.status_code == 200, r.text
    row = conn.execute("SELECT status, amazon_order_no, delivery_date FROM procure.tasks "
                       "WHERE id=%s", (t["task_id"],)).fetchone()
    assert row["status"] == "purchased"
    assert row["amazon_order_no"] == "111-2223334-4445556"
    assert row["delivery_date"] is not None


def test_complete_rejects_mismatched_asin(client, conn, seed):
    """订单卡 ASIN 与本单不符 → 不写库,转人工。"""
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-0000000-0000000",
        "observed_asins": ["B0DIFFERENT"],
    })
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "ORDER_NO_AMBIGUOUS"
    row = conn.execute("SELECT status, error_code, amazon_order_no FROM procure.tasks "
                       "WHERE id=%s", (t["task_id"],)).fetchone()
    assert row["status"] == "manual"
    assert row["error_code"] == "ORDER_NO_AMBIGUOUS"
    assert row["amazon_order_no"] is None, "断言失败时绝不能把单号写进去"


def test_complete_allows_empty_observed_asins(client, seed):
    """没采到 ASIN 不算断言失败 —— 断言是抓错配,不是制造噪音。"""
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-1111111-1111111",
        "observed_asins": [],
    })
    assert r.status_code == 200


# ── 失败与释放 ──────────────────────────────────────────────────────────

def test_fail_writes_structured_code(client, conn, seed):
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/fail", json={
        "instance_uid": UID, "error_code": "OUT_OF_STOCK", "cart_cleared": True,
    })
    assert r.json()["data"]["status"] == "exception"
    assert conn.execute("SELECT error_code FROM procure.tasks WHERE id=%s",
                        (t["task_id"],)).fetchone()["error_code"] == "OUT_OF_STOCK"


def test_fail_without_cart_cleared_leaves_warning(client, conn, seed):
    _register(client)
    t = _claim(client)
    client.post(f"/v1/tasks/{t['task_id']}/fail", json={
        "instance_uid": UID, "error_code": "OUT_OF_STOCK", "cart_cleared": False,
    })
    warns = conn.execute(
        "SELECT payload FROM procure.task_events WHERE task_id=%s AND kind='step'",
        (t["task_id"],),
    ).fetchall()
    assert any(w["payload"].get("warning") == "cart_not_cleared" for w in warns)


def test_release_returns_to_ready(client, conn, seed):
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/release", json={"instance_uid": UID})
    assert r.json()["data"]["status"] == "ready"


def test_cannot_report_on_task_not_held(client, seed):
    _register(client)
    t = _claim(client)
    client.post(f"/v1/tasks/{t['task_id']}/release", json={"instance_uid": UID})
    r = client.post(f"/v1/tasks/{t['task_id']}/fail", json={
        "instance_uid": UID, "error_code": "OUT_OF_STOCK"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "TASK_NOT_HELD"


# ── 物流 ────────────────────────────────────────────────────────────────

def test_shipment_sync(client, conn, seed):
    _register(client)
    t = _claim(client)
    client.post(f"/v1/tasks/{t['task_id']}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-5555555-5555555",
        "observed_asins": ["B0FB3VS68J"]})
    r = client.post("/v1/shipments/sync", json={
        "instance_uid": UID, "task_id": t["task_id"], "carrier": "UPS",
        "tracking_no": "1Z999", "status": "in_transit",
        "events": [{"raw_day": "August 28, 2026", "raw_time": "8:42 AM",
                    "description": "Arrived at facility", "city": "Los Angeles",
                    "state_code": "CA"}],
    })
    assert r.json()["data"]["events"] == 1
    ev = conn.execute("SELECT description, seq FROM logistics.shipment_events").fetchall()
    assert ev == [{"description": "Arrived at facility", "seq": 0}]


def test_shipment_sync_replaces_events(client, conn, seed):
    """重复回传是全量快照,整批替换,不做增量合并(否则会产生重复行)。"""
    _register(client)
    t = _claim(client)
    body = {"instance_uid": UID, "task_id": t["task_id"],
            "events": [{"description": "A"}, {"description": "B"}]}
    client.post("/v1/shipments/sync", json=body)
    client.post("/v1/shipments/sync", json=body)
    n = conn.execute("SELECT count(*) AS n FROM logistics.shipment_events").fetchone()["n"]
    assert n == 2
