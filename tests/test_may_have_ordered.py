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

import re

import pytest

from services import error_codes

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


# ── 契约的另一半:插件真的发了那条 step 吗 ──────────────────────────────

#: 服务端认的键名。四道闸(人工重置 / 批量重置 / 自动重试选单 / release)全都挂在
#: 它身上,所以它在这里出现一次,底下两条测试拿它去比两侧。
CROSS_KEY = "may_have_ordered"
CROSS_STEP = "点击下单按钮"


def test_the_server_and_the_design_doc_agree_on_the_key_name():
    """键名在服务端与 docs/01 §5.4 里必须是同一个词。

    这一条是绿的那一半:它盯的是「我们自己写下的契约与我们自己的实现对不对得上」。
    """
    from registry import paths

    route = (paths.repo_root() / "server" / "routes" / "tasks.py").read_text(encoding="utf-8")
    doc = (paths.repo_root() / "docs" / "01-系统设计.md").read_text(encoding="utf-8")
    assert f'payload.get("{CROSS_KEY}")' in route
    assert CROSS_KEY in doc and CROSS_STEP in doc


def _strip_ts_comments(src: str) -> str:
    """输入:一段 TypeScript 源码 → 输出:去掉 `//` 与 `/* */` 注释之后的代码。

    为什么必须去:下面那条契约用的是**子串搜索**,而 run.ts 里解释这条契约的
    注释本身就写着 `may_have_ordered` 这个词。不去注释的话,把那一行的键名改成
    TS 习惯的 `mayHaveOrdered`,搜索照样命中注释里那一处 —— 全套测试仍然全绿,
    而这正是这条测试点名要防的那一件事。

    字符串字面量里的 `//`(比如一个 http:// 开头的 URL)不算注释,所以要认引号。
    """
    out: list[str] = []
    i, n = 0, len(src)
    quote = ""
    while i < n:
        c = src[i]
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(src[i + 1])
                i += 2
                continue
            if c == quote:
                quote = ""
            i += 1
            continue
        if c in "\"'`":
            quote = c
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            # 注释可能跨行,补回换行免得上下两行粘成一行
            out.append("\n")
            continue
        out.append(c)
        i += 1
    return "".join(out)


def test_the_plugin_really_sends_the_step_that_arms_those_gates():
    """**这一条盯的是插件那一侧。**

    服务端那四道闸没有一道是自己看出来「这一单越过下单点了」的 —— 它们全都在等
    `extension/src/flow/run.ts` 在 `placeOrder()` 之前发的那条 step,而且认的是
    payload 里 `may_have_ordered` 这个**键名**。键名一旦不同(按 TS 习惯写成
    `mayHaveOrdered`),或者那一行压根没写,`payload.get("may_have_ordered") is True`
    恒为 False:库里那一列永远是 false,四道闸里那个 `or crossed` 恒假,
    **这道闸退化成一块永远不动的招牌** —— 而库里那一列、运营台上那一行、
    docs/01 §5.4 整节都在说它管用。

    本文件其余的测试全部自己用 HTTP 合成那条事件,所以一条都不会红。
    这与 tests/test_login_state.py 记的那次事故完全同型(「插件那份副本没人比过,
    19 个悄悄分叉了 10 个」),解法也照它:拿源码去比。

    **比的是代码,不是「文件里出现过这个词」。** 先剥掉注释(run.ts 里解释这条
    契约的注释自己就写着这个键名),再比整段调用的字面量 —— 否则改坏键名时
    搜索会命中注释,这条测试当场变成招牌。
    """
    from registry import paths

    raw = (paths.repo_root() / "extension" / "src" / "flow" / "run.ts").read_text(encoding="utf-8")
    src = _strip_ts_comments(raw)
    place = src.find("driver.placeOrder(")
    assert place > 0, "run.ts 里找不到 driver.placeOrder( —— 这条测试的锚点没了,先来修锚点"
    before = src[:place]

    # 整段字面量,不是三个互不相干的子串:键名、步骤名、以及「真的这么发」
    # 三件事一起钉住。
    call = re.compile(
        r'step\(\s*"' + re.escape(CROSS_STEP) + r'"\s*,\s*\{\s*'
        + re.escape(CROSS_KEY) + r'\s*:\s*true\s*\}\s*\)')

    # 用 pytest.fail 而不是 assert:`assert x in src` 失败时 pytest 会把整个
    # run.ts 的内容打进报告里,真正要说的那句话被淹掉。
    #
    # 「压根没有」与「有、但在 placeOrder 之后」分开说 —— 前者是这条契约还没落地,
    # 后者是落错了地方(置位在 placeOrder 之前是铁律:点击过程中崩了,
    # 我们同样不知道单下没下成)。两句一样的话会让人查错方向。
    if call.search(src) and not call.search(before):
        pytest.fail(
            f"extension/src/flow/run.ts 报了 {CROSS_KEY!r},但它出现在 "
            f"driver.placeOrder() **之后**。置位必须在点击之前 —— "
            f"点击过程中崩了,我们同样不知道单下没下成,而那一刻服务端还以为"
            f"这一单没越过下单点,四道闸全放行。"
        )
    if not call.search(before):
        pytest.fail(
            f"extension/src/flow/run.ts 在 driver.placeOrder() 之前没有上报 "
            f"{CROSS_KEY!r}(注释里写着不算 —— 这里比的是代码)。服务端那四道闸"
            f"(人工重置 / 批量重置 / 自动重试选单 / release)全靠这条 step 置位 "
            f"tasks.may_have_ordered —— 插件不发,四道闸就都是摆设,"
            f"而界面和文档都在说它管用。\n"
            f"照契约补上这一行(placeOrder 之前):\n"
            f'    const armed = await step("{CROSS_STEP}", {{ {CROSS_KEY}: true }});\n'
            f"注意是下划线的 {CROSS_KEY},不是 TS 习惯的 mayHaveOrdered —— "
            f"服务端按字面取这个键。"
        )


def test_the_plugin_does_not_click_place_order_until_that_step_landed():
    """那条 step 的**返回值必须被消费** —— 它是下单的前置条件,不是旁白。

    发出去不等于落地:`client.events` 走 core/api.post(一次就是一次、不重试),
    撞上网络抖动 / 服务端重启 / 15 秒超时就回一个 `{ok:false,kind:'transport'}`。
    返回值一丢,插件照点下单按钮:订单在 Amazon 上真下成了,而
    `tasks.may_have_ordered` 从没被置上 —— 四道闸一起失效,人一键重置或
    `task_retry` 自动放回队列,同一张单被再买一遍。触发条件不再是「键名写错」,
    而是「那一次 POST 没说上话」,后果一模一样。

    这里只钉源码形状(行为那一半在 extension/test/unit.test.mjs 里真的跑了一遍:
    events 回 transport 失败时 placeOrder 一次都不许被调用)。
    """
    from registry import paths

    raw = (paths.repo_root() / "extension" / "src" / "flow" / "run.ts").read_text(encoding="utf-8")
    src = _strip_ts_comments(raw)
    place = src.find("driver.placeOrder(")
    assert place > 0, "run.ts 里找不到 driver.placeOrder( —— 这条测试的锚点没了,先来修锚点"
    before = src[:place]

    bind = re.search(
        r'(?:const|let|var)\s+(\w+)\s*=\s*await\s+step\(\s*"' + re.escape(CROSS_STEP) + r'"',
        before)
    if bind is None:
        pytest.fail(
            "extension/src/flow/run.ts 把那条 step 的返回值直接丢掉了。"
            "它是**下单的前置条件**,不是旁白:没落地就不许点下单按钮。\n"
            '照契约写成:const armed = await step("点击下单按钮", '
            "{ may_have_ordered: true }); 然后判 armed.ok。"
        )
    name = bind.group(1)
    if f"{name}.ok" not in before[bind.end():]:
        pytest.fail(
            f"run.ts 接住了那条 step 的返回值({name}),但在 driver.placeOrder() "
            f"之前没有判过 {name}.ok。接住不判等于没接 —— 那一次 POST 没说上话时,"
            f"服务端不知道我们要点下单,四道回队列的闸对这一单全是空的。"
        )


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


def test_the_response_field_says_the_task_state_not_this_batch(client, conn, seed):
    """`may_have_ordered` 回的是**这条任务此刻的状态**,不是这一批里有没有那条 step。

    原先回的是后者:先报「点击下单按钮」(true),再报一条普通的「等待确认页」,
    第二次就回 false —— 而库里那一列是 true。字段名会被照字面理解成任务的状态
    (插件想据此决定还能不能 release、下一个写运营台或重放工具的人),
    于是「从没越过下单点」与「上一次请求已经越过了」渲染成同一个 false。
    """
    _env, _inst, tasks = seed
    _claim(client, conn, tasks[0])
    first = client.post(f"/v1/tasks/{tasks[0]}/events",
                        json={"instance_uid": "inst-A", "events": [CROSS_EVENT]})
    assert first.json()["data"]["may_have_ordered"] is True

    second = client.post(f"/v1/tasks/{tasks[0]}/events", json={
        "instance_uid": "inst-A",
        "events": [{"kind": "step", "payload": {"step": "等待确认页"}}]})
    assert second.json()["data"]["may_have_ordered"] is True
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


def test_the_two_triggers_say_two_different_things(client, conn, seed):
    """两种拦法必须说成两句不一样的话,而且那句话要能直接念给运营听。

    码触发(ORDER_CONFIRM_TIMEOUT 这类)与越过下单点触发,处置一样但**要找的东西
    不一样**:前者去订单页看这个码对应的那一步有没有成,后者是「下单按钮已经点过了」。
    运营台那条二次确认条现在直接渲染这句 message —— 它自己不再按 error_code 编,
    编出来的那句对后一类是假话(PLUGIN_INTERNAL 并不意味着下过单)。
    所以这句话必须自己把话说全,而且不许出现 acknowledged 这种接口参数名。
    """
    _env, _inst, tasks = seed
    _cross_the_order_line(client, conn, tasks[0])                       # 越过下单点
    _claim(client, conn, tasks[1])
    client.post(f"/v1/tasks/{tasks[1]}/fail", json={                    # 只是码危险
        "instance_uid": "inst-A", "error_code": "ORDER_CONFIRM_TIMEOUT",
        "detail": "确认页没等到", "to_manual": True, "cart_cleared": True})

    crossed = client.post(f"/v1/admin/tasks/{tasks[0]}/reset",
                          json={}).json()["error"]["message"]
    by_code = client.post(f"/v1/admin/tasks/{tasks[1]}/reset",
                          json={}).json()["error"]["message"]

    assert crossed != by_code, "两种拦法说成同一句话,等于没分"
    assert "越过下单点" in crossed and "PLUGIN_INTERNAL" not in crossed
    # 码那一支说的是**中文标签**,不是英文码。docs/01 §4:界面上不出现英文码,
    # 英文只在库、日志和 API 里露面。原先这里拼的是码本身,于是同一个弹窗上方
    # 三行处显示「下单后未见确认页」,确认条里却是一串运营不认识的大写英文。
    assert error_codes.LABELS["ORDER_CONFIRM_TIMEOUT"] in by_code
    for msg in (crossed, by_code):
        # 后果要说出来 —— 只说「可能已下单」的话,人不知道点下去会发生什么
        assert "再买一遍" in msg
        assert "acknowledged" not in msg, "接口参数名不许出现在给人看的话里"
        # 一个英文码都不许出现在这句话里(封闭集逐个比,不是只比这一个)。
        for code in error_codes.ERROR_CODES:
            assert code not in msg, f"给人看的话里出现了英文码 {code}"


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
