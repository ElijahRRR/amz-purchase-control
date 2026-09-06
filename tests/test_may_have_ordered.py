"""越过下单点的那道闸:花过钱的那一步必须在库里留痕。

`run.ts` 里 `mayHaveOrdered` 在 `placeOrder()` **之前**置位,置位之后任何失败都
`to_manual` —— 插件那一侧是对的。问题在服务端:重置回队列那道 `NEEDS_ACK` 闸
按 **error_code ∈ POSSIBLY_ORDERED** 判,而越过下单点之后落下来的码**不一定**
在那一组里:

    catch (e) {
      const code = e instanceof Abort || e instanceof DriverError
        ? e.code                                    // ← 驱动认得出原因就直接用它的码
        : (mayHaveOrdered ? "ORDER_CONFIRM_TIMEOUT" : "PLUGIN_INTERNAL");

`readOrderCard()` 在点完下单之后抛一个 `DriverError("PLUGIN_INTERNAL", ...)`
(或 `CAPTCHA_ENCOUNTERED`)时,库里就是 status=manual + error_code=PLUGIN_INTERNAL:
状态说「要人裁决」,错误码说「重一下基本能过」。运营台照着错误码渲染,那道闸放行,
人点一下「重置回待拍单」,同一张单被再买一遍 —— 而这一单**已经花过钱了**。

这正是本项目最防的那种缺陷:看起来有护栏(紫色警告、二次确认条、批量重置的
skipped 清单全都在),实际防不住,因为它们判的都是同一个不足以代表事实的字段。
"""


def _claim_and_cross_the_order_line(client, conn, task_id, *, code="PLUGIN_INTERNAL"):
    """输入:一条 ready 任务 → 输出:无。走一遍真实时序:认领 → 报「点击下单按钮」→ 失败转人工。

    不直接 UPDATE 库,走 HTTP —— 这个洞的关键正在于「插件说过的话有没有落进库里」,
    自己造一行库数据就把要验的东西跳过去了。
    """
    conn.execute("UPDATE procure.tasks SET status='ready' WHERE id = %s", (task_id,))
    conn.commit()
    got = client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"}).json()["data"]
    assert got["task_id"] == task_id

    # C2 在 run.ts 里 placeOrder 之前、mayHaveOrdered 置位之后立刻报的那一条。
    r = client.post(f"/v1/tasks/{task_id}/events", json={
        "instance_uid": "inst-A",
        "events": [{"kind": "step",
                    "payload": {"step": "点击下单按钮", "may_have_ordered": True}}],
    })
    assert r.json()["ok"] is True

    # 下单按钮点过了,读订单卡的时候驱动抛了个自己认得出的错 —— 码不是那三个之一。
    r = client.post(f"/v1/tasks/{task_id}/fail", json={
        "instance_uid": "inst-A", "error_code": code,
        "detail": "读订单卡时抛错", "to_manual": True, "cart_cleared": False,
    })
    assert r.json()["data"]["status"] == "manual"


def test_a_task_past_the_order_button_can_be_reset_without_any_receipt(client, conn, seed):
    """**这条测试现在是绿的,而它绿着就是那个洞。**

    一条已经点过下单按钮、以 PLUGIN_INTERNAL 落到待人工的任务,
    不带 acknowledged 就能被重置回待拍单 —— 等于一键重复下单。
    """
    _env, _inst, tasks = seed
    _claim_and_cross_the_order_line(client, conn, tasks[0])

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/reset", json={"operator": "小王"})
    assert r.json()["ok"] is True, "闸拦住了?那这个洞已经被堵上了,把这条测试翻过来"
    assert r.json()["data"]["status"] == "ready"

    row = conn.execute("SELECT status FROM procure.tasks WHERE id = %s",
                       (tasks[0],)).fetchone()
    assert row["status"] == "ready"


def test_batch_reset_lets_the_same_task_through(client, conn, seed):
    """批量重置那条路同样放行 —— 它调的是同一个 reset_to_queue。"""
    _env, _inst, tasks = seed
    _claim_and_cross_the_order_line(client, conn, tasks[0], code="CART_MISMATCH")

    got = client.post("/v1/admin/tasks/batch-reset",
                      json={"task_ids": [tasks[0]]}).json()["data"]
    assert got["counts"] == {"done": 1, "skipped": 0, "failed": 0}
