"""物流同步:待同步队列、订单状态盖过轨迹状态、not_found 只记不改。"""


def _purchase(conn, task_id, no):
    conn.execute("""UPDATE procure.tasks SET status='purchased', amazon_order_no=%s,
                           purchased_at=now() WHERE id=%s""", (no, task_id))


def test_pending_only_returns_this_envs_purchased_tasks(client, conn, seed):
    _env, _inst, tasks = seed
    _purchase(conn, tasks[0], "111-0000001-0000001")
    conn.commit()

    items = client.post("/v1/shipments/pending",
                        json={"instance_uid": "inst-A"}).json()["data"]["items"]
    assert [i["task_id"] for i in items] == [tasks[0]]
    assert items[0]["amazon_order_no"] == "111-0000001-0000001"


def test_pending_drops_delivered_and_cancelled(client, conn, seed):
    """已签收/已取消的不会再变了,不该再占插件的一轮。"""
    _env, _inst, tasks = seed
    for t, no in zip(tasks, ["111-0000001-0000001", "111-0000002-0000002",
                             "111-0000003-0000003"]):
        _purchase(conn, t, no)
    conn.commit()

    client.post("/v1/shipments/sync", json={
        "instance_uid": "inst-A", "task_id": tasks[0], "status": "delivered", "events": []})
    client.post("/v1/shipments/sync", json={
        "instance_uid": "inst-A", "task_id": tasks[1],
        "order_state": "cancelled", "events": []})

    items = client.post("/v1/shipments/pending",
                        json={"instance_uid": "inst-A"}).json()["data"]["items"]
    assert [i["task_id"] for i in items] == [tasks[2]]


def test_pending_holds_off_recently_synced(client, conn, seed):
    """刚同步过的先放放 —— Amazon 的轨迹一天更新不了几次。"""
    _env, _inst, tasks = seed
    _purchase(conn, tasks[0], "111-0000001-0000001")
    conn.commit()

    client.post("/v1/shipments/sync", json={
        "instance_uid": "inst-A", "task_id": tasks[0], "status": "in_transit", "events": []})
    items = client.post("/v1/shipments/pending",
                        json={"instance_uid": "inst-A"}).json()["data"]["items"]
    assert items == []

    # 把上次同步时间推远,它就该回到队列里
    conn.execute("UPDATE logistics.shipments SET updated_at = now() - interval '2 days'"
                 " WHERE task_id = %s", (tasks[0],))
    conn.commit()
    items = client.post("/v1/shipments/pending",
                        json={"instance_uid": "inst-A"}).json()["data"]["items"]
    assert [i["task_id"] for i in items] == [tasks[0]]


def test_order_state_cancelled_overrides_tracking_status(client, conn, seed):
    """页面说 cancelled,轨迹上写什么都不算数。"""
    _env, _inst, tasks = seed
    _purchase(conn, tasks[0], "111-0000001-0000001")
    conn.commit()

    r = client.post("/v1/shipments/sync", json={
        "instance_uid": "inst-A", "task_id": tasks[0],
        "order_state": "cancelled", "status": "in_transit", "events": []})
    assert r.json()["data"]["status"] == "cancelled"

    row = conn.execute("SELECT status FROM logistics.shipments WHERE task_id = %s",
                       (tasks[0],)).fetchone()
    assert row["status"] == "cancelled"


def test_not_found_is_recorded_but_does_not_flip_the_task(client, conn, seed):
    """订单详情页打不开,只记不改。

    一次打不开也可能是页面抽风。自动把 purchased 打回待人工,
    会在 Amazon 抽风的那天把一整批已完成的单全掀翻。
    """
    _env, _inst, tasks = seed
    _purchase(conn, tasks[0], "111-0000001-0000001")
    conn.commit()

    client.post("/v1/shipments/sync", json={
        "instance_uid": "inst-A", "task_id": tasks[0], "order_state": "not_found", "events": []})

    row = conn.execute("SELECT status FROM procure.tasks WHERE id = %s", (tasks[0],)).fetchone()
    assert row["status"] == "purchased"          # 没被掀翻

    kinds = [r["kind"] for r in conn.execute(
        "SELECT kind FROM procure.task_events WHERE task_id = %s", (tasks[0],)).fetchall()]
    assert kinds.count("shipment") == 2          # 一条常规结果 + 一条 not_found 说明


def test_sync_events_are_replaced_not_appended(client, conn, seed):
    """Amazon 侧是全量快照,增量合并只会制造重复行。"""
    _env, _inst, tasks = seed
    _purchase(conn, tasks[0], "111-0000001-0000001")
    conn.commit()

    body = {"instance_uid": "inst-A", "task_id": tasks[0], "status": "in_transit",
            "events": [{"raw_day": "August 22, 2026", "description": "Shipped"}]}
    client.post("/v1/shipments/sync", json=body)
    body["events"] = [
        {"raw_day": "August 23, 2026", "description": "Out for delivery"},
        {"raw_day": "August 22, 2026", "description": "Shipped"},
    ]
    client.post("/v1/shipments/sync", json=body)

    n = conn.execute("""SELECT count(*) c FROM logistics.shipment_events e
                          JOIN logistics.shipments s ON s.id = e.shipment_id
                         WHERE s.task_id = %s""", (tasks[0],)).fetchone()["c"]
    assert n == 2


def test_delivered_on_first_sync_still_gets_delivered_at(client, conn, seed):
    """首次同步时就已经签收的单也要落上签收时间。

    只在 UPDATE 分支填 delivered_at 的话,「一次都没在途过、直接签收」的单
    永远拿不到它 —— 界面上那一栏就是空的,而没人会想到去怀疑一个"已签收"的单。
    """
    _env, _inst, tasks = seed
    _purchase(conn, tasks[0], "111-0000009-0000009")
    conn.commit()

    client.post("/v1/shipments/sync", json={
        "instance_uid": "inst-A", "task_id": tasks[0], "status": "delivered", "events": []})

    row = conn.execute("SELECT status, delivered_at FROM logistics.shipments WHERE task_id = %s",
                       (tasks[0],)).fetchone()
    assert row["status"] == "delivered"
    assert row["delivered_at"] is not None


def test_detail_carries_the_tracking_trail(conn, seed):
    """轨迹明细要能读出来。

    logistics.shipment_events 之前是只写不读的:插件每次同步都把整条轨迹存下来,
    然后没有任何地方拿它给人看。「货到哪了」正是运营被问得最多的那句话,
    答案一直在库里躺着。
    """
    from services import shipment, task_query

    _env, _inst, tasks = seed
    shipment.sync(conn, task_id=tasks[0], carrier="UPS", tracking_no="1Z-A",
                  tracking_url=None, status="in_transit", events=[
                      {"happened_at": None, "raw_day": "August 20, 2026", "raw_time": "9:41 AM",
                       "description": "Out for delivery", "city": "Santa Ana",
                       "state_code": "CA", "seq": 0},
                      {"happened_at": None, "raw_day": "August 19, 2026", "raw_time": "2:04 PM",
                       "description": "Arrived at facility", "city": "Ontario",
                       "state_code": "CA", "seq": 1},
                  ])
    conn.commit()

    got = task_query.detail(conn, tasks[0])
    trail = got["shipment"]["events"]
    assert [e["seq"] for e in trail] == [0, 1], "seq 0 = 最新,照原样给前端,不在服务端翻转"
    assert trail[0]["description"] == "Out for delivery"
    assert trail[0]["city"] == "Santa Ana"
    # 解析不出时间时保留 Amazon 原文,不丢
    assert trail[1]["raw_day"] == "August 19, 2026"
