"""插件实例登记与心跳。

不发凭据、不做鉴权(所有者定稿)。instance_uid 由插件首次启动生成并持久化,
服务端按它认人;重复注册幂等。

**登录态也在这里。** 买家号的 Amazon 登录态只存在浏览器 profile 里(我们不申请
`cookies` 权限、不读也不上传 Cookie),服务端唯一的知情渠道就是插件读页面导航栏
之后随心跳报上来的这一位。它决定两件事:认领那道闸拦不拦(见
`task_queue.login_blocks_claim`),以及运营台上那个买家号显示成什么。
"""

from typing import Any

from services import task_queue

#: 登录态封闭集。与 refdata/schema.sql 里 plugin_instances.login_state 的行内注释、
#: services/vocab.LOGIN_STATE_LABELS 一字不差 —— 有测试盯着。
#:
#: unknown **不是** ok:读不到导航栏(页面没渲染完、Amazon 改版、插件是旧版从不上报)
#: 就是读不到。把它当成 ok 正是这个项目反复栽过的那一类
#: 「看起来有护栏、实际防不住」。
LOGIN_STATES = frozenset({"ok", "signed_out", "unknown"})


def validate_login_state(state: str) -> str:
    """输入:登录态 → 输出:原样返回;不在封闭集内抛 ValueError。

    **HTTP 那条路上走不到这里** —— `server/schemas.HeartbeatReq.login_state` 是个
    `Literal`,Pydantic 先回 422。这个函数是给直接调 service 的人(workflow、
    cli、将来的别的入口)兜底的,两处一起构成封闭集的两道闸。
    """
    if state not in LOGIN_STATES:
        raise ValueError(
            f"未知登录态 {state!r},封闭集:{', '.join(sorted(LOGIN_STATES))}"
        )
    return state


#: 「这一次上报要不要留住库里的旧值」——**这条规则的唯一定义处**,
#: 下面 heartbeat 的两个 CASE 用的是同一个片段(值和它的时刻永远一起动)。
#:
#: 两种情况留旧值:
#:   · 没传          —— 「这一轮没有新消息」,不是「不知道」
#:   · 传 unknown 而库里是 signed_out —— **unknown 不许解封 signed_out**。
#:
#: 第二条是这道闸的关键。插件读页面读不出来的情形是常态(Amazon 弹验证码、
#: 探测 iframe 没加载出来、导航栏没渲染完),一次这样的上报要是能把库里确凿的
#: signed_out 抹成 unknown,认领闸当场重新打开:单子被派给一台仍然登不上的机器,
#: 领走 → 跑到 /ap/signin → 退回队列,每个复检周期循环一次;而运营台那一行
#: 从红色「已登出 · 不可派」变回灰色「登录态存疑 · 可派」——
#: **唯一能让人去重新登录的信号就此消失**。
#:
#: 只有 `ok` 能解封:那是「真读到了导航栏,而且登着」,是一个确凿的好消息。
#: 插件侧还有一层(loop.ensureLoginChecked 读失败时**什么都不报**),
#: 但那一层是可以被旧版插件、别的调用方绕开的,所以库这一侧必须自己站得住。
#:
#: `::text` 不是装饰:占位符落在 CASE 的条件里,PostgreSQL 没有上下文能推出
#: 它的类型,不写就直接回 AmbiguousParameter。
_KEEPS_OLD_LOGIN_STATE = (
    "%(login_state)s::text IS NULL"
    " OR (%(login_state)s::text = 'unknown' AND login_state = 'signed_out')"
)


def register(conn, *, env_code: str, instance_uid: str, plugin_version: str | None) -> dict[str, Any]:
    """输入:连接 + 环境名 + 实例唯一号(+插件版本)→ 输出:实例 dict(含 buyer_env_id)。

    环境不存在时抛 LookupError —— 买家号必须先在后台登记,插件不能凭空创建产能通道。
    """
    env = conn.execute(
        "SELECT id, status FROM procure.buyer_envs WHERE code = %s", (env_code,)
    ).fetchone()
    if env is None:
        raise LookupError(f"买家号环境不存在:{env_code}")

    row = conn.execute(
        """
        INSERT INTO procure.plugin_instances (buyer_env_id, instance_uid, plugin_version,
                                              last_seen_at)
        VALUES (%(env_id)s, %(uid)s, %(ver)s, now())
        ON CONFLICT (instance_uid) DO UPDATE
           SET buyer_env_id   = EXCLUDED.buyer_env_id,
               plugin_version = EXCLUDED.plugin_version,
               last_seen_at   = now()
        RETURNING id, buyer_env_id, instance_uid, plugin_version
        """,
        {"env_id": env["id"], "uid": instance_uid, "ver": plugin_version},
    ).fetchone()
    row["env_status"] = env["status"]
    return row


def heartbeat(
    conn,
    *,
    instance_uid: str,
    login_state: str | None = None,
    recheck_minutes: int = 10,
) -> dict[str, Any] | None:
    """输入:连接 + 实例唯一号(+这一轮读到的登录态)→ 输出:实例现状 dict;未注册返回 None。

    返回 `{id, buyer_env_id, login_state, login_checked_at, login_check_due}`。

    `login_state` 为 None 表示**这一轮没有新消息**,不是「不知道」——
    原样保留库里那一位。覆盖成 unknown 的话,一个已知被登出的买家号会在下一次
    心跳(20 秒后)自己变回"存疑"然后重新被派单,这道闸就等于不存在。
    传上来的 `unknown` 同样不许把库里的 `signed_out` 洗掉,规则见
    `_KEEPS_OLD_LOGIN_STATE`:**只有 `ok` 能解封**。

    `login_check_due` 是给插件的回话:**该去读一次页面了吗**。它=「这个买家号
    确实有单在等着派」且「上一次读页面已经超过 recheck_minutes」。
    把这条策略放在服务端而不是插件里,是因为它是可调参数
    (registry/settings.login_recheck_minutes),改它不该要发一版插件;
    也因为「有没有单在等」只有服务端知道 —— 插件问出这件事的唯一办法是先认领,
    而先认领恰恰是我们想避免的那个动作。
    """
    if login_state is not None:
        validate_login_state(login_state)
    row = conn.execute(
        f"""
        UPDATE procure.plugin_instances
           SET last_seen_at = now(),
               -- 留旧值还是覆盖,规则只有一处定义(_KEEPS_OLD_LOGIN_STATE)。
               -- **这一位和它的时刻永远一起动**:留住旧值就连 login_checked_at
               -- 一起留住,否则界面上会出现「已登出 · 刚刚检查过」——
               -- 而"刚刚"那一次读到的其实是"读不出来",时刻描述的不是它旁边那个值。
               login_state = CASE WHEN {_KEEPS_OLD_LOGIN_STATE}
                                  THEN login_state ELSE %(login_state)s::text END,
               login_checked_at = CASE WHEN {_KEEPS_OLD_LOGIN_STATE}
                                       THEN login_checked_at ELSE now() END
         WHERE instance_uid = %(uid)s
        RETURNING id, buyer_env_id, login_state, login_checked_at
        """,
        {"uid": instance_uid, "login_state": login_state},
    ).fetchone()
    if row is None:
        return None
    row["login_check_due"] = _login_check_due(
        conn,
        buyer_env_id=row["buyer_env_id"],
        checked_at=row["login_checked_at"],
        recheck_minutes=recheck_minutes,
    )
    return row


def _login_check_due(conn, *, buyer_env_id: int, checked_at, recheck_minutes: int) -> bool:
    """输入:连接 + 买家环境 id + 这个实例上次检查的时刻 + 复检间隔 → 输出:该不该去读页面。

    两个条件都要:
      · 这个买家号**真有单在等派** —— 队列空着的时候开一张 Amazon 页面读导航栏,
        读到的结论没人用得上,白白多一次页面加载
      · 这个实例上次读页面已经过了复检间隔

    按**这个实例自己**的检查时刻算,不按整个买家号的最新值:认领那道闸看的是
    来认领的那一个实例,这里也就得看同一个,否则同一个环境上有两个实例时,
    甲刚查过会让乙以为自己也不用查了 —— 而乙才是那个要去干活的。
    """
    row = conn.execute(
        """
        SELECT EXISTS (SELECT 1 FROM procure.tasks
                        WHERE buyer_env_id = %(env_id)s AND status = 'ready')     AS has_work,
               (%(checked_at)s::timestamptz IS NULL
                OR %(checked_at)s::timestamptz < now() - make_interval(mins => %(mins)s))
                                                                                  AS stale
        """,
        {"env_id": buyer_env_id, "checked_at": checked_at, "mins": recheck_minutes},
    ).fetchone()
    return bool(row["has_work"] and row["stale"])


def resolve(conn, instance_uid: str) -> dict[str, Any] | None:
    """输入:连接 + 实例唯一号 → 输出:{id, buyer_env_id, env_status, login_state};不存在返回 None。"""
    return conn.execute(
        """
        SELECT i.id, i.buyer_env_id, i.login_state, i.login_checked_at,
               e.status AS env_status
          FROM procure.plugin_instances i
          JOIN procure.buyer_envs e ON e.id = i.buyer_env_id
         WHERE i.instance_uid = %s
        """,
        (instance_uid,),
    ).fetchone()


LIST_SQL = """
SELECT e.id            AS env_id,
       e.code          AS env_code,
       e.marketplace,
       e.status        AS env_status,
       e.amazon_customer_id,
       e.daily_cap,
       e.expected_card_last4,
       i.instance_uid,
       i.plugin_version,
       i.last_seen_at,
       i.login_state,
       i.login_checked_at,
       (SELECT count(*) FROM procure.tasks t
         WHERE t.buyer_env_id = e.id AND t.status = 'ready')     AS queue_depth,
       (SELECT count(*) FROM procure.tasks t
         WHERE t.buyer_env_id = e.id AND t.status = 'manual')    AS manual_count,
       (SELECT count(*) FROM procure.tasks t
         WHERE t.buyer_env_id = e.id AND t.status = 'purchased'
           AND t.purchased_at >= date_trunc('day', now()))       AS purchased_today
  FROM procure.buyer_envs e
  LEFT JOIN LATERAL (
        SELECT * FROM procure.plugin_instances pi
         WHERE pi.buyer_env_id = e.id
         ORDER BY pi.last_seen_at DESC NULLS LAST, pi.id DESC
         LIMIT 1
  ) i ON TRUE
 ORDER BY e.code
"""


def list_with_liveness(conn, *, stale_seconds: int) -> list[dict]:
    """输入:连接 + 判活阈值 → 输出:每个买家号一行,带 liveness。

    liveness 是**算出来的**,不是库里的列:
      never   从来没注册过插件(上游建了买家号,机器上还没装)
      online  心跳还新鲜
      stale   有过心跳但超过阈值 —— 可能是关了机器,也可能是插件崩了
      paused  运营手动停的,或买家号被风控停用。停止派单,已领的单不动

    暂停用「停」而不是「坏」来表达:停着不等于坏了,两者的处置方式完全不同。

    一个买家号有多个实例时,这一行显示的是**最近见过的那一个**(LIST_SQL 里的
    LATERAL 就是这么取的,plugin_version / last_seen_at 一直如此)。运营前提是
    一个环境 = 一台机器 = 一个实例,所以这不是问题;真出现两个实例时,认领那道闸
    看的是**来认领的那一个**,与这里显示的可能不是同一个。

    登录态(login_state)与 liveness 是**两条独立的轴**:插件活得好好的、心跳
    一秒不落,浏览器里那个 Amazon 账号照样可能已经被登出。这正是这一列存在的理由
    —— 在此之前,被登出的买家号在这一页上是满格绿色的「在线 · 可派」,
    而它领到的每一单都会走到 /ap/signin 然后超时。
    """
    out = []
    for r in conn.execute(LIST_SQL).fetchall():
        row = dict(r)
        # 一个买家号还没有任何实例时 login_state 是 NULL。归一成 unknown:
        # 「没有实例」与「实例没报过」对派单来说是同一件事(都不知道),
        # 而「从来没连过」这件事由 liveness=never 说,不需要在这里再说一遍。
        row["login_state"] = row["login_state"] or "unknown"
        if row["env_status"] != "active":
            liveness = "paused"
        elif row["last_seen_at"] is None:
            liveness = "never"
        else:
            age = conn.execute(
                "SELECT EXTRACT(EPOCH FROM (now() - %s))::int AS s", (row["last_seen_at"],)
            ).fetchone()["s"]
            row["last_seen_age_seconds"] = age
            liveness = "online" if age <= stale_seconds else "stale"
        row["liveness"] = liveness
        # 「可派单」必须跟真正那道闸算同一件事。
        #
        # 真正的闸在 task_queue.CLAIM_SQL 里:`status='ready'` 且
        # `daily_cap = 0 OR done_today < daily_cap`。原先这里只看在线,
        # 于是拍满当天配额的买家号在界面上仍然是绿色「可派」——
        # 运营看着一台「可派」的机器一整天不动,只能去猜是不是插件坏了。
        # 而运营台自己还渲染着一个「已到日上限」的分支,那个分支永远走不到。
        capped = bool(row["daily_cap"]) and row["purchased_today"] >= row["daily_cap"]
        row["at_daily_cap"] = capped
        # 登录态这道闸的判断只有一处定义(task_queue.login_blocks_claim),
        # 认领 SQL 那边与这里调的是同一个函数。daily_cap 那次分叉的教训:
        # 界面自己算一遍「可派单」,算法与真闸不一样,于是界面上绿着、实际派不出。
        signed_out = task_queue.login_blocks_claim(row["login_state"])
        row["login_blocks_dispatch"] = signed_out
        row["dispatchable"] = liveness == "online" and not capped and not signed_out
        out.append(row)
    return out


class EnvRefused(Exception):
    """一个说得出名字的拒绝(与 task_admin.AdminRefused 同一个形态)。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def set_expected_card(conn, env_id: int, last4: str | None) -> dict:
    """输入:连接 + 买家号 id + 四位数字(或空 = 关掉这道闸)→ 输出:改后的那一行。

    **形状在这里校验,不在路由里。** 一个 "441"(手滑少打一位)存进去的后果是
    这个买家号从此每一单都被 PAYMENT_METHOD_UNEXPECTED 拦下 ——
    而运营看到的是「支付卡不符」,会去查买家号的支付方式,查不出任何问题。

    空串与 None 都是「关掉这道闸」,统一存成 NULL:留一个空串在库里,
    `if expected_card_last4:` 那种判断照样是假,但下一个来读库的人会以为
    「配过、只是配成了空」——两种不同的情况不该长成两个值。

    **这一步不留痕,而它值得留痕。** 把 4417 改成 9021、或者干脆清空关掉这道闸,
    接口 200、库里改了、界面跟着变,没有任何地方答得出是谁在什么时候做的。
    task_events 挂在 task_id 上,这张表没有 task_id,套不进去;buyer_envs
    眼下整张表都没有审计流(daily_cap、status 同样没有)。补它得先给 buyer_envs
    开一条事件流 —— 那是一件独立的事。这里写明白,免得下一个人以为记过。
    """
    v = (last4 or "").strip()
    if v and not (len(v) == 4 and v.isdigit()):
        raise EnvRefused("BAD_CARD_LAST4",
                         f"卡尾号得是 4 位数字,收到 {last4!r};留空表示这个买家号不校验支付方式")
    row = conn.execute(
        """UPDATE procure.buyer_envs
              SET expected_card_last4 = %s, updated_at = now()
            WHERE id = %s
        RETURNING id, code, expected_card_last4""",
        (v or None, env_id),
    ).fetchone()
    if row is None:
        raise EnvRefused("ENV_NOT_FOUND", f"买家号不存在:{env_id}")
    return dict(row)
