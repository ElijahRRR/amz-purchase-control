"""登录态:心跳落库、认领被拒、恢复后又能派单、unknown 的处置。

这一整件事修的是一个「两种不同的情况渲染出同一个结果」的缺陷:

买家号的 Amazon 登录态只存在浏览器 profile 里(我们不申请 cookies 权限、不读
Cookie)。号被登出之后,插件照样认领、照样开结算 iframe,Amazon 把它导到
/ap/signin,然后等待超时 → `CHECKOUT_TIMEOUT`(可重试)。于是「被登出」和
「页面慢」长成同一个样子:重置多少次都不会好,而运营台上看不出这个买家号
其实已经不能用了。
"""

from services import instance, task_queue, vocab


def _login_state(conn, uid: str = "inst-A"):
    return conn.execute(
        "SELECT login_state, login_checked_at FROM procure.plugin_instances"
        " WHERE instance_uid = %s", (uid,)
    ).fetchone()


def _statuses(conn):
    return sorted(r["status"] for r in
                  conn.execute("SELECT status FROM procure.tasks").fetchall())


# ── 心跳落库 ────────────────────────────────────────────────────────────

def test_heartbeat_records_login_state(client, conn, seed):
    r = client.post("/v1/instances/heartbeat",
                    json={"instance_uid": "inst-A", "login_state": "signed_out"})
    assert r.json()["data"]["login_state"] == "signed_out"

    row = _login_state(conn)
    assert row["login_state"] == "signed_out"
    assert row["login_checked_at"] is not None


def test_heartbeat_without_login_state_keeps_the_last_one(client, conn, seed):
    """不传 = 这一轮没有新消息,**不是**「不知道」。

    覆盖成 unknown 的话,一个已知被登出的买家号会在 20 秒后的下一次心跳里
    自己"洗白"成存疑,然后重新被派单 —— 这道闸就等于不存在。
    """
    client.post("/v1/instances/heartbeat",
                json={"instance_uid": "inst-A", "login_state": "signed_out"})
    was = _login_state(conn)["login_checked_at"]

    client.post("/v1/instances/heartbeat", json={"instance_uid": "inst-A"})
    now = _login_state(conn)
    assert now["login_state"] == "signed_out"
    # 检查时刻也不许动:没读页面就不算"刚查过"
    assert now["login_checked_at"] == was


def test_unknown_does_not_wipe_a_known_signed_out(client, conn, seed):
    """报 unknown **不许**把库里确凿的 signed_out 洗掉。只有 ok 能解封。

    「不传」那一半上面那条测试已经盯着了,这条盯的是另一半 —— 而另一半才是
    真会发生的那个:插件被服务端叫去复检,这一次读不出来(Amazon 弹了验证码、
    探测页没加载出来)。unknown 是个非空值,原先那句 COALESCE 拦不住它,
    于是闸门当场重新打开:单子被派给一台仍然登不上的机器,领走、跑到
    /ap/signin、再退回队列,每个复检周期循环一次;更要紧的是运营台那一行
    从红色「已登出 · 不可派」变回灰色「登录态存疑 · 可派」,
    唯一能让人去重新登录的信号就此消失。
    """
    client.post("/v1/instances/heartbeat",
                json={"instance_uid": "inst-A", "login_state": "signed_out"})
    was = _login_state(conn)["login_checked_at"]

    r = client.post("/v1/instances/heartbeat",
                    json={"instance_uid": "inst-A", "login_state": "unknown"})
    assert r.status_code == 200
    assert r.json()["data"]["login_state"] == "signed_out"

    now = _login_state(conn)
    assert now["login_state"] == "signed_out"
    # 值留住了,它的时刻也得留住:否则界面上是「已登出 · 刚刚检查过」,
    # 而"刚刚"那一次读到的其实是"读不出来"。
    assert now["login_checked_at"] == was

    # 闸门还得关着 —— 这才是这条规则要保住的东西
    assert client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"}).status_code == 409
    row = client.get("/v1/admin/instances").json()["data"]["items"][0]
    assert row["login_state"] == "signed_out" and row["dispatchable"] is False

    # 只有 ok 能解封
    client.post("/v1/instances/heartbeat",
                json={"instance_uid": "inst-A", "login_state": "ok"})
    assert client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"}).status_code == 200


def test_unknown_still_overwrites_ok(client, conn, seed):
    """反过来,unknown 盖掉 ok 是**应该**发生的。

    「上一次读到登着」和「这一次读了、读不出来」是两件事,渲染成同一个词
    就等于这一列没有。unknown 不拦认领,但它在界面上是「登录态存疑」,
    运营看见会去看一眼。
    """
    client.post("/v1/instances/heartbeat",
                json={"instance_uid": "inst-A", "login_state": "ok"})
    r = client.post("/v1/instances/heartbeat",
                    json={"instance_uid": "inst-A", "login_state": "unknown"})
    assert r.json()["data"]["login_state"] == "unknown"
    assert _login_state(conn)["login_state"] == "unknown"


def test_heartbeat_rejects_unknown_login_state(client, seed):
    """封闭集。拼错的值宁可 422,也不写进库 —— 写进去之后那道闸就认不出它了。

    这个 422 来自 **Pydantic**(`HeartbeatReq.login_state` 是个 Literal),
    不是 `instance.validate_login_state` —— 后者在 HTTP 这条路上走不到,
    它守的是直调 service 的那条路。封闭集因此有两道闸,两道都得跟着改,
    见 test_login_state_closed_set_has_exactly_one_meaning_everywhere。
    """
    r = client.post("/v1/instances/heartbeat",
                    json={"instance_uid": "inst-A", "login_state": "SignedOut"})
    assert r.status_code == 422


def test_signed_out_instance_can_still_heartbeat(client, conn, seed):
    """被登出**不能**连心跳一起拒掉。

    心跳是这台机器唯一的回话通道:拒了它,人重新登录之后那句「我好了」就
    永远送不上来,这个买家号会被永久关在门外。
    """
    client.post("/v1/instances/heartbeat",
                json={"instance_uid": "inst-A", "login_state": "signed_out"})
    r = client.post("/v1/instances/heartbeat",
                    json={"instance_uid": "inst-A", "login_state": "ok"})
    assert r.status_code == 200 and r.json()["data"]["login_state"] == "ok"


# ── 认领被拒 ────────────────────────────────────────────────────────────

def test_claim_refused_when_signed_out(client, conn, seed):
    """被登出的实例认领时被拒,且拒得**说得出名字**。

    这里不能回 `ok=true, data=null` —— 那是「队列里没有单」的意思,
    插件收到之后会安静地等下一轮,10 秒一次一直刷到有人发现为止。
    """
    client.post("/v1/instances/heartbeat",
                json={"instance_uid": "inst-A", "login_state": "signed_out"})

    r = client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"})
    assert r.status_code == 409
    body = r.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "INSTANCE_SIGNED_OUT"

    # 拒绝之后任务一条都不许被动过
    assert _statuses(conn) == ["ready", "ready", "ready"]


def test_claim_resumes_after_login_recovers(client, conn, seed):
    """人重新登录、插件复检报 ok 之后,不需要任何人工干预就能继续派单。"""
    client.post("/v1/instances/heartbeat",
                json={"instance_uid": "inst-A", "login_state": "signed_out"})
    assert client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"}).status_code == 409

    client.post("/v1/instances/heartbeat",
                json={"instance_uid": "inst-A", "login_state": "ok"})
    r = client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"})
    assert r.status_code == 200 and r.json()["data"]["task_id"] is not None
    assert _statuses(conn) == ["claimed", "ready", "ready"]


def test_unknown_does_not_block_claim(client, conn, seed):
    """`unknown` 不拦认领 —— 拦了的话,新装的实例在第一次检查之前永远领不到单。

    但 unknown **不是** ok:它在界面上是另一个词(「登录态存疑」),
    见 test_meta_ships_login_state_vocabulary。
    """
    assert _login_state(conn)["login_state"] == "unknown"     # 建表默认值
    r = client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"})
    assert r.status_code == 200 and r.json()["data"] is not None

    # 断言响应码:漏了它的话,封闭集里少掉 "unknown" 之后这一句已经是 422,
    # 而这条测试照样绿(2026-09-06 复核实测)。
    r = client.post("/v1/instances/heartbeat",
                    json={"instance_uid": "inst-A", "login_state": "unknown"})
    assert r.status_code == 200
    assert task_queue.login_blocks_claim("unknown") is False


# ── 运营台:「可派单」必须与认领那道真闸一致 ───────────────────────────

def test_admin_instances_agrees_with_the_real_claim_gate(client, conn, seed):
    """运营台说「可派」的时候,认领就必须真的能派;说不可派就必须真的拒。

    README 里专门记过一次这样的分叉事故:「可派单」曾只看在线、不看 daily_cap,
    于是拍满配额的买家号在界面上仍然是绿色可派,而界面里那个「已到日上限」
    的分支永远走不到。这条测试盯的是同一件事,换成登录态这一项。
    """
    def dispatchable():
        rows = client.get("/v1/admin/instances").json()["data"]["items"]
        return rows[0]

    # 先让它在线(有心跳),此时 unknown → 可派,认领也真的能派
    client.post("/v1/instances/heartbeat", json={"instance_uid": "inst-A"})
    row = dispatchable()
    assert row["login_state"] == "unknown"
    assert row["login_blocks_dispatch"] is False and row["dispatchable"] is True
    assert client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"}).status_code == 200

    # 报被登出:界面说不可派,认领也必须真的拒
    client.post("/v1/instances/heartbeat",
                json={"instance_uid": "inst-A", "login_state": "signed_out"})
    row = dispatchable()
    assert row["login_state"] == "signed_out"
    assert row["login_blocks_dispatch"] is True and row["dispatchable"] is False
    assert row["login_checked_at"] is not None
    assert client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"}).status_code == 409


def test_admin_instances_normalizes_missing_instance_to_unknown(client, conn):
    """一个还没有任何实例的买家号:登录态是 unknown,不是空白。

    空白会在界面上渲染成一个空格子,而空格子跟「已登录」一样不会让人去看一眼。
    """
    conn.execute("INSERT INTO procure.buyer_envs (code) VALUES ('env-999')")
    conn.commit()
    rows = client.get("/v1/admin/instances").json()["data"]["items"]
    row = next(r for r in rows if r["env_code"] == "env-999")
    assert row["login_state"] == "unknown" and row["liveness"] == "never"
    assert row["dispatchable"] is False


# ── 复检节奏:只在有单等着派的时候才让插件去开页面 ─────────────────────

def test_login_check_due_only_when_there_is_work(client, conn, seed):
    """`login_check_due` 是服务端给插件的回话:该去读一次导航栏了吗。

    队列空着的时候读到的结论没人用得上 —— 白开一张 Amazon 页面。
    """
    r = client.post("/v1/instances/heartbeat", json={"instance_uid": "inst-A"})
    assert r.json()["data"]["login_check_due"] is True      # 有 3 条 ready,且从没查过

    # 报一次之后就不该再让它查(刚查过)
    r = client.post("/v1/instances/heartbeat",
                    json={"instance_uid": "inst-A", "login_state": "ok"})
    assert r.json()["data"]["login_check_due"] is False

    # 把上次检查时间推回去 → 又该查了
    conn.execute("UPDATE procure.plugin_instances"
                 " SET login_checked_at = now() - interval '30 minutes'")
    conn.commit()
    r = client.post("/v1/instances/heartbeat", json={"instance_uid": "inst-A"})
    assert r.json()["data"]["login_check_due"] is True

    # 队列清空之后,过期了也不必查
    conn.execute("UPDATE procure.tasks SET status = 'cancelled'")
    conn.commit()
    r = client.post("/v1/instances/heartbeat", json={"instance_uid": "inst-A"})
    assert r.json()["data"]["login_check_due"] is False


# ── 封闭集:六处必须一字不差 ────────────────────────────────────────────

def _ts_union(path, name: str) -> set[str]:
    """输入:一个 .ts 文件 + 类型名 → 输出:那行字面量联合类型的成员集合。"""
    line = next(ln for ln in path.read_text(encoding="utf-8").splitlines()
                if ln.startswith(f"export type {name} ="))
    return {p.strip().strip('"') for p in line.split("=")[1].strip(" ;").split("|")}


def test_login_state_closed_set_has_exactly_one_meaning_everywhere():
    """封闭集一共**六份**,得一字不差地对得上:

      1. `services/instance.LOGIN_STATES`      —— 直调 service 那条路的校验
      2. `server/schemas.HeartbeatReq` 的 Literal —— **HTTP 那条路真正的门闩**
      3. `services/vocab` 的标签与色调          —— 界面词汇(只出中文,前端不存副本)
      4. `refdata/schema.sql` + `docs/db_schema.md` 的行内注释
      5. `extension/src/core/types.ts` 的 `LoginState`
      6. `extension/src/flow/dom/parse.ts` 的 `LoginState` —— **判定真正发生的地方**

    这条测试原先只比了 1/3/4/5,而漏掉的两份恰好是最要紧的两份:

    · 第 2 份漂移的后果是**心跳被 422 拒**。而 service worker 里那一位只在 `r.ok`
      时才清(`pendingLoginState`),于是它会被永远重发、每一次心跳都 422 ——
      `last_seen_at` 再也不更新(实例在运营台上变「失联」),登录态从此再也送不上去,
      这道闸退化成一块永远不动的招牌。(实测:把 Literal 里的 "unknown" 删掉,
      245 条 pytest 照样全绿。)
    · 第 6 份漂移 tsc 也看不见 —— 值经 runner → service worker 时是
      `msg.state as LoginState`,强转把类型断了。(实测:给它加一个 "captcha"
      并从 readLoginState 返回,typecheck、DOM、pytest 全绿。)

    这个项目已经因为「两份副本悄悄分叉」栽过两次(厂商的 subTotal/subtotal;
    我们自己的 vocab 与插件那份错误码标签)。
    """
    import re

    from registry import paths

    assert set(vocab.LOGIN_STATE_LABELS) == instance.LOGIN_STATES
    assert set(vocab.LOGIN_STATE_TONE) == instance.LOGIN_STATES

    # HTTP 那条路上真正把请求挡在门外的是这一份。`instance.validate_login_state`
    # 在这条路上走不到 —— Pydantic 先回 422。
    schemas_src = (paths.repo_root() / "server" / "schemas.py").read_text(encoding="utf-8")
    literals = re.findall(r"login_state:\s*Literal\[([^\]]+)\]", schemas_src)
    assert len(literals) == 1, f"server/schemas.py 里 login_state 的 Literal 有 {len(literals)} 处"
    assert instance.LOGIN_STATES == {m.strip().strip('"') for m in literals[0].split(",")}

    schema = (paths.repo_root() / "refdata" / "schema.sql").read_text(encoding="utf-8")
    doc = (paths.repo_root() / "docs" / "db_schema.md").read_text(encoding="utf-8")
    for state in instance.LOGIN_STATES:
        assert state in schema, f"schema.sql 的行内注释里没写 {state}"
        assert state in doc, f"docs/db_schema.md 里没写 {state}"

    # 插件那两份也是同一套。它们必须离线可用,所以留着副本 —— 那就得有东西盯着。
    ext = paths.repo_root() / "extension" / "src"
    assert instance.LOGIN_STATES == _ts_union(ext / "core" / "types.ts", "LoginState")
    assert instance.LOGIN_STATES == _ts_union(ext / "flow" / "dom" / "parse.ts", "LoginState")


def test_meta_ships_login_state_vocabulary(client):
    """界面上只出中文,标签由服务端下发,前端不存副本。

    而且 unknown 与 ok **必须是两个词** —— 读不到导航栏和读到了登录着是两件事,
    渲染成同一个词就等于这道闸没有。
    """
    meta = client.get("/v1/admin/meta").json()["data"]["login_state"]
    assert meta["labels"] == vocab.LOGIN_STATE_LABELS
    assert meta["labels"]["unknown"] != meta["labels"]["ok"]
    assert meta["tone"]["unknown"] != meta["tone"]["ok"]


def test_login_lost_is_deliberately_not_an_error_code():
    """「登录态失效」**刻意不进错误码封闭集**。

    错误码回答的是「这一单为什么失败」,而这件事不是这一单的问题:单子本身
    没毛病,是这台机器的环境坏了,处置是退回队列(mayHaveOrdered 为假时),
    任务的 error_code 一个字都不会写。真给它编一个码,那个码会永远停在 0 次出现,
    还得硬塞进 RETRYABLE / TO_MANUAL / BUSINESS_BLOCKED 三组之一 ——
    这个项目已经栽过一次「有码不属于任何一组」了。

    这条测试是给将来的人看的:这不是漏了,是决定。
    """
    from services import error_codes

    assert not [c for c in error_codes.ERROR_CODES if "LOGIN" in c or "SIGN" in c]
    # 登录态有自己的表达方式,不需要借错误码说一遍
    assert instance.LOGIN_STATES and set(vocab.LOGIN_STATE_LABELS) == instance.LOGIN_STATES
