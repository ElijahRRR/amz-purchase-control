"""越过下单点的那道闸:花过钱的那一步必须在库里留痕。

`run.ts` 里 `mayHaveOrdered` 在 `placeOrder()` **之前**置位,置位之后任何失败都
`to_manual` —— 插件那一侧是对的。问题曾经在服务端:重置回队列那道 `NEEDS_ACK` 闸
只按 **error_code ∈ POSSIBLY_ORDERED** 判,而越过下单点之后落下来的码**不一定**
在那一组里:

    catch (e) {
      const code = e instanceof Abort || e instanceof DriverError
        ? e.code                                    // ← 驱动认得出原因就直接用它的码
        : (mayHaveOrdered ? "ORDER_CONFIRM_TIMEOUT" : "PLUGIN_INTERNAL");

`readOrderCard()` 在点完下单之后抛一个 `DriverError("PLUGIN_INTERNAL", ...)`
(或 `CART_MISMATCH`)时,库里就是 status=manual + error_code=PLUGIN_INTERNAL:
状态说「要人裁决」,错误码说「重一下基本能过」。判码的那道闸放行,人点一下
「重置回待拍单」,同一张单被再买一遍 —— 而这一单**已经花过钱了**。

现在闸判两样:`error_code ∈ POSSIBLY_ORDERED` **或** `tasks.may_have_ordered`。
后者由插件在 placeOrder 之前报的那条 step 事件置位,记的是「越没越过下单点」
这个事实本身,与失败之后落了哪个码无关。人工重置、批量重置、自动重试各判一次。

回到队列的**第四条路是插件自己调的 `/release`**,它也判 —— 前三条至少还要人点一下,
这一条连人都没有:插件版本旧了、那个 `if (!mayHaveOrdered)` 被人改坏、或者另写了
一条清理路径,任务就原地回到 ready 并立刻被再次认领。
"""

import pytest

CROSS_EVENT = {"kind": "step", "payload": {"step": "点击下单按钮", "may_have_ordered": True}}


def _claim(client, conn, task_id):
    conn.execute("UPDATE procure.tasks SET status='ready' WHERE id = %s", (task_id,))
    conn.commit()
    got = client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"}).json()["data"]
    assert got["task_id"] == task_id


def _cross_the_order_line(client, conn, task_id, *, code="PLUGIN_INTERNAL"):
    """输入:一条 ready 任务 → 输出:无。走一遍真实时序:认领 → 报「点击下单按钮」→ 失败转人工。

    不直接 UPDATE 库,走 HTTP —— 这个洞的关键正在于「插件说过的话有没有落进库里」,
    自己造一行库数据就把要验的东西跳过去了。
    """
    _claim(client, conn, task_id)
    r = client.post(f"/v1/tasks/{task_id}/events",
                    json={"instance_uid": "inst-A", "events": [CROSS_EVENT]})
    assert r.json()["ok"] is True

    # 下单按钮点过了,读订单卡的时候驱动抛了个自己认得出的错 —— 码不是那三个之一。
    r = client.post(f"/v1/tasks/{task_id}/fail", json={
        "instance_uid": "inst-A", "error_code": code,
        "detail": "读订单卡时抛错", "to_manual": True, "cart_cleared": False,
    })
    assert r.json()["data"]["status"] == "manual"


def _flag(conn, task_id) -> bool:
    return conn.execute("SELECT may_have_ordered FROM procure.tasks WHERE id = %s",
                        (task_id,)).fetchone()["may_have_ordered"]


# ── 事件 → 库里那一列 ────────────────────────────────────────────────────

def test_the_step_event_sets_the_column_in_the_same_request(client, conn, seed):
    _env, _inst, tasks = seed
    assert _flag(conn, tasks[0]) is False
    _claim(client, conn, tasks[0])

    r = client.post(f"/v1/tasks/{tasks[0]}/events",
                    json={"instance_uid": "inst-A", "events": [CROSS_EVENT]})
    assert r.json()["data"]["may_have_ordered"] is True
    assert _flag(conn, tasks[0]) is True


def test_ordinary_steps_do_not_set_it(client, conn, seed):
    """只有明写 may_have_ordered=true 的那一条算数。

    「清空购物车」「去结算」这些 step 每单都有好几条,它们要是也能把闸推上,
    那这道闸就等于对所有单常开 —— 而一道对所有单常开的闸,人一周之内就会学会
    无脑点「我已确认」,于是它对真正该拦的那一单也不再有效。
    """
    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    r = client.post(f"/v1/tasks/{tasks[0]}/events", json={
        "instance_uid": "inst-A",
        "events": [{"kind": "step", "payload": {"step": "去结算"}},
                   {"kind": "step", "payload": {"step": "填地址", "may_have_ordered": False}}],
    })
    assert r.json()["data"]["may_have_ordered"] is False
    assert _flag(conn, tasks[0]) is False


def test_the_event_row_and_the_column_land_together(client, conn, seed):
    """事件与置位同一事务。

    分开写的话会出现「事件流里写着点过下单按钮、而闸门那一列还是 false」——
    一条留了痕却没人认的痕比不留更坏:看的人以为它管用。
    """
    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    client.post(f"/v1/tasks/{tasks[0]}/events",
                json={"instance_uid": "inst-A", "events": [CROSS_EVENT]})

    payloads = [r["payload"] for r in conn.execute(
        "SELECT payload FROM procure.task_events WHERE task_id = %s AND kind = 'step'",
        (tasks[0],)).fetchall()]
    assert any(p.get("may_have_ordered") is True for p in payloads)
    assert _flag(conn, tasks[0]) is True


# ── 插件自己退回队列那条路(/release) ──────────────────────────────────

def test_release_is_refused_after_the_order_line(client, conn, seed):
    """越过下单点之后 `/release` 必须被服务端拒掉。

    「点下单那一刻起禁止退回队列」在插件里判过一次(run.ts 的 `if (!mayHaveOrdered)`),
    但这次改动全部的立意就是**不再只听插件的**:重置那三条路都加了这条判据,
    而 /release 是最直接的第四条 —— 插件版本旧了、那个 if 被人改坏、或者另写了
    一条清理路径,这一单就原地回到 ready,下一次 claim 立刻把它再派出去,
    全程没有任何人参与。人工重置那道闸至少还要人点一下,这条连人都没有。
    """
    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    client.post(f"/v1/tasks/{tasks[0]}/events",
                json={"instance_uid": "inst-A", "events": [CROSS_EVENT]})

    r = client.post(f"/v1/tasks/{tasks[0]}/release", json={"instance_uid": "inst-A"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "POSSIBLY_ORDERED"

    row = conn.execute("SELECT status, may_have_ordered FROM procure.tasks WHERE id = %s",
                       (tasks[0],)).fetchone()
    # 被拒之后状态不许动:还在 claimed,于是 task_sweep 会把它按 CLAIM_TIMEOUT
    # 转人工(那个码在 POSSIBLY_ORDERED 里),人裁决之前谁也拿不走它。
    assert row["status"] == "claimed" and row["may_have_ordered"] is True


def test_the_refused_release_leaves_a_trace(client, conn, seed):
    """拒之前先留痕:插件试图退回一张越过下单点的单,本身就是插件那侧漏判的证据。

    不留这一行的话,「插件哪个版本开始不判了」只能靠猜 —— 而这条路的后果是
    同一单被自动再买一遍。
    """
    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    client.post(f"/v1/tasks/{tasks[0]}/events",
                json={"instance_uid": "inst-A", "events": [CROSS_EVENT]})
    client.post(f"/v1/tasks/{tasks[0]}/release", json={"instance_uid": "inst-A"})

    rows = [r["payload"] for r in conn.execute(
        "SELECT payload FROM procure.task_events "
        " WHERE task_id = %s AND kind = 'assert_failed' ORDER BY id", (tasks[0],)).fetchall()]
    assert [p["reason"] for p in rows] == ["release_after_order_line"]


def test_the_refusal_says_the_right_reason_not_task_not_held(client, conn, seed):
    """理由不许说成 TASK_NOT_HELD。

    判据要是塞进 task_queue.release 的 WHERE 里,返回 False 会被路由渲染成
    「这一单已经不在你手上」—— 而真相是「它在你手上,但你不许放手」。
    插件日志里留下的那句话说错了,查起来会先去翻认领与清扫,全查错了方向。
    """
    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    client.post(f"/v1/tasks/{tasks[0]}/events",
                json={"instance_uid": "inst-A", "events": [CROSS_EVENT]})
    msg = client.post(f"/v1/tasks/{tasks[0]}/release",
                      json={"instance_uid": "inst-A"}).json()["error"]["message"]
    assert "越过下单点" in msg


def test_an_ordinary_release_still_works(client, conn, seed):
    """反面:没越过下单点的单照旧退得回去 —— 登录态失效那条兜底全靠它。"""
    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    r = client.post(f"/v1/tasks/{tasks[0]}/release", json={"instance_uid": "inst-A"})
    assert r.json()["data"]["status"] == "ready"
    assert conn.execute("SELECT status FROM procure.tasks WHERE id = %s",
                        (tasks[0],)).fetchone()["status"] == "ready"


# ── 人工重置那道闸 ──────────────────────────────────────────────────────

def test_a_task_past_the_order_button_cannot_be_reset_without_a_receipt(client, conn, seed):
    """码是 PLUGIN_INTERNAL(在 RETRYABLE 里),但下单按钮点过了 —— 必须先有人去看。"""
    _env, _inst, tasks = seed
    _cross_the_order_line(client, conn, tasks[0])

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/reset", json={"operator": "小王"})
    body = r.json()
    assert body["ok"] is False and body["error"]["code"] == "NEEDS_ACK"
    # 拦下的理由要说的是**下单按钮点过了**,不是那个人畜无害的码 ——
    # 照着 PLUGIN_INTERNAL 去订单页找,人根本不知道自己在找什么。
    assert "越过下单点" in body["error"]["message"]

    row = conn.execute("SELECT status FROM procure.tasks WHERE id = %s",
                       (tasks[0],)).fetchone()
    assert row["status"] == "manual", "被拒之后状态不许动"


def test_the_receipt_still_lets_it_through(client, conn, seed):
    """闸不是死路:人去买家号确认过之后,带回执照样能重。"""
    _env, _inst, tasks = seed
    _cross_the_order_line(client, conn, tasks[0])

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/reset",
                    json={"acknowledged": True, "operator": "小王"})
    assert r.json()["data"]["status"] == "ready"


def test_the_flag_survives_the_reset(client, conn, seed):
    """重置回队列**不清**这一列。

    清掉的话:重回队列的单再失败一次(这回是个 exception),它就变成一张
    「从没越过下单点」的单 —— 而亚马逊那边可能挂着两张订单了。
    「曾经花过钱」是既成事实,不会因为它又排回队列而变回没花过。
    """
    _env, _inst, tasks = seed
    _cross_the_order_line(client, conn, tasks[0])
    client.post(f"/v1/admin/tasks/{tasks[0]}/reset", json={"acknowledged": True})
    assert _flag(conn, tasks[0]) is True


def test_a_plain_failure_is_still_resettable(client, conn, seed):
    """没越过下单点的单一切照旧 —— 这道闸不许把所有失败都变成要人确认。"""
    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    client.post(f"/v1/tasks/{tasks[0]}/fail", json={
        "instance_uid": "inst-A", "error_code": "CHECKOUT_TIMEOUT",
        "detail": "结算页没等到", "to_manual": False, "cart_cleared": True})

    r = client.post(f"/v1/admin/tasks/{tasks[0]}/reset", json={})
    assert r.json()["data"]["status"] == "ready"


# ── 批量重置 ────────────────────────────────────────────────────────────

def test_batch_reset_skips_it_and_says_why(client, conn, seed):
    """批量那条路调的是同一个 reset_to_queue,所以同样被拦;而且要报清楚原因。"""
    _env, _inst, tasks = seed
    _cross_the_order_line(client, conn, tasks[0], code="CART_MISMATCH")
    # 陪跑的那一条:普通的可重试失败,批量里它该被正常重掉。
    conn.execute("UPDATE procure.tasks SET status='exception', error_code='CHECKOUT_TIMEOUT' "
                 " WHERE id = %s", (tasks[1],))
    conn.commit()

    got = client.post("/v1/admin/tasks/batch-reset",
                      json={"task_ids": [tasks[0], tasks[1]]}).json()["data"]
    assert got["counts"] == {"done": 1, "skipped": 1, "failed": 0}
    assert got["done"] == [tasks[1]]
    item = got["skipped"][0]
    assert item["task_id"] == tasks[0]
    assert item["code"] == "NEEDS_ACK"
    # 只报 error_code 的话,看的人第一反应是「CART_MISMATCH 不就是重一下就过的
    # 那种吗,系统是不是抽了」—— 被跳过的原因必须自己说出来。
    assert item["error_code"] == "CART_MISMATCH"
    assert item["may_have_ordered"] is True


# ── 自动重试 ────────────────────────────────────────────────────────────

@pytest.fixture()
def on(monkeypatch):
    monkeypatch.setenv("AMZ_AUTO_RETRY_MAX", "2")
    monkeypatch.setenv("AMZ_AUTO_RETRY_BACKOFF_MIN", "10")


def _stale_exception(conn, task_id, code="PLUGIN_INTERNAL"):
    """把一条越过下单点的单硬按成 exception —— 插件那侧漏判 to_manual 的样子。

    这不是臆想的场景:status 是**插件**在 /fail 里用自己算的布尔定的
    (`manual = mayHaveOrdered || toManual(code)`)。插件版本旧了、两边分叉、
    或者干脆算错,一张点过下单按钮的单就会落成 exception,而它的码恰恰在
    RETRYABLE 里。那一轮的后果是定时任务**自动重复下单**。
    """
    conn.execute(
        """UPDATE procure.tasks
              SET status='exception', error_code=%s, error_detail='读订单卡时抛错',
                  updated_at = now() - make_interval(mins => 60)
            WHERE id = %s""", (code, task_id))
    conn.commit()


def test_auto_retry_does_not_pick_a_task_that_crossed_the_order_line(client, conn, seed, on):
    from services import task_retry

    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    client.post(f"/v1/tasks/{tasks[0]}/events",
                json={"instance_uid": "inst-A", "events": [CROSS_EVENT]})
    _stale_exception(conn, tasks[0])

    assert [c["id"] for c in task_retry.candidates(conn)] == []


def test_retry_one_refuses_it_even_when_handed_the_id(client, conn, seed, on):
    """选单排除了它,直接把 id 递给 retry_one 也不行 ——
    下一个人给运营台加「立即重试」按钮时照着 docstring 直接调的就是这个函数。"""
    from services import task_admin, task_retry

    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    client.post(f"/v1/tasks/{tasks[0]}/events",
                json={"instance_uid": "inst-A", "events": [CROSS_EVENT]})
    _stale_exception(conn, tasks[0])

    with pytest.raises(task_admin.AdminRefused) as exc:
        task_retry.retry_one(conn, tasks[0])
    assert exc.value.code == "POSSIBLY_ORDERED"


def test_auto_retry_still_picks_an_ordinary_retryable_exception(client, conn, seed, on):
    """反面:没越过下单点的 exception 照旧够格 —— 别把整条链锁死了。"""
    from services import task_retry

    _env, _inst, tasks = seed
    _stale_exception(conn, tasks[0], code="CHECKOUT_TIMEOUT")
    assert [c["id"] for c in task_retry.candidates(conn)] == [tasks[0]]


# ── 运营台详情 ──────────────────────────────────────────────────────────

def test_detail_hands_the_flag_to_the_operator_console(client, conn, seed):
    """界面要能把「已越过下单点」显示出来 —— 否则运营看到的还是那个
    人畜无害的 PLUGIN_INTERNAL,点了重置被拒才知道有这回事。"""
    _env, _inst, tasks = seed
    _cross_the_order_line(client, conn, tasks[0])
    data = client.get(f"/v1/admin/tasks/{tasks[0]}").json()["data"]
    assert data["may_have_ordered"] is True
