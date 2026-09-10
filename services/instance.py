"""插件实例登记与心跳。

不发凭据、不做鉴权(所有者定稿)。instance_uid 由插件首次启动生成并持久化,
服务端按它认人;重复注册幂等。

**登录态也在这里。** 买家号的 Amazon 登录态只存在浏览器 profile 里(我们不申请
`cookies` 权限、不读也不上传 Cookie),服务端唯一的知情渠道就是插件读页面导航栏
之后随心跳报上来的这一位。它决定两件事:认领那道闸拦不拦(见
`task_queue.login_blocks_claim`),以及运营台上那个买家号显示成什么。
"""

import json
import re
from typing import Any

from services import task_queue

#: 登录态封闭集。与 refdata/schema.sql 里 plugin_instances.login_state 的行内注释、
#: services/vocab.LOGIN_STATE_LABELS 一字不差 —— 有测试盯着。
#:
#: unknown **不是** ok:读不到导航栏(页面没渲染完、Amazon 改版、插件是旧版从不上报)
#: 就是读不到。把它当成 ok 正是这个项目反复栽过的那一类
#: 「看起来有护栏、实际防不住」。
LOGIN_STATES = frozenset({"ok", "signed_out", "unknown"})


#: 买家号 ID 的形态。厂商是在页面 HTML 上跑 /customerId:\s*"([^"]*)"/ 抠出来的
#: (v2.5.3 popup.js),他们**拿它当身份用**;我们只拿它对账与比对,身份仍然是
#: 买家号环境本身。形状卡死是因为这一列一旦写进去就成了「该是谁」——
#: 一个空串或者半截值会把这道闸永久钉在 mismatch 上,而运营看到的理由是假的。
CUSTOMER_ID_RE = re.compile(r"^A[0-9A-Z]{8,}$")

#: 买家号那条事件流的封闭集(procure.env_events.kind)。
#: 中文标签在 services/vocab.ENV_EVENT_LABELS —— 有测试盯着两边一致。
ENV_EVENT_KINDS = frozenset({
    "customer_id_seen",       # 这个买家号第一次被认出账号(写进 buyer_envs)
    "customer_id_mismatch",   # 报上来的账号与库里的不一样,认领已被拒
    "customer_id_override",   # 人点了「以这个为准」
})


def record_env_event(conn, buyer_env_id: int, kind: str, *,
                     instance_id: int | None = None,
                     payload: dict[str, Any] | None = None) -> int:
    """输入:连接 + 买家号 id + 事件类型(+实例/载荷)→ 输出:事件 id;kind 不在封闭集抛 ValueError。

    与 `services/task_event.record` 是**两条事件流**,不是一条:那一条挂在 task_id 上,
    这一条挂在买家号上。混成一条的话,任务时间线上会冒出一种永远不属于那儿的事件,
    而买家号身上发生的事仍然没地方放。
    """
    if kind not in ENV_EVENT_KINDS:
        raise ValueError(f"未知买家号事件类型 {kind!r},允许值:{sorted(ENV_EVENT_KINDS)}")
    row = conn.execute(
        """INSERT INTO procure.env_events (buyer_env_id, instance_id, kind, payload)
           VALUES (%s, %s, %s, %s) RETURNING id""",
        (buyer_env_id, instance_id, kind,
         json.dumps(payload or {}, ensure_ascii=False)),
    ).fetchone()
    return row["id"]


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
    amazon_customer_id: str | None = None,
    recheck_minutes: int = 10,
) -> dict[str, Any] | None:
    """输入:连接 + 实例唯一号(+这一轮读到的登录态)→ 输出:实例现状 dict;未注册返回 None。

    返回 `{id, buyer_env_id, login_state, login_checked_at, login_check_due,
    amazon_customer_id, expected_customer_id, account_state, customer_id_rejected}`。

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

    # 形状不对的账号**不写库,但也不拒这条心跳**。
    #
    # 拒的话(照 login_state 那个 Literal 回 422)整条心跳就废了:last_seen_at
    # 不再更新,这台机器在运营台上变成「失联」,登录态也送不上去 —— 一个毒值
    # 把整条通道堵死,正是 service-worker 里 PENDING_LOGIN_MAX_REJECTS 那段注释
    # 在防的事。所以这里只把它挡在库外,并**原样回给插件**(customer_id_rejected),
    # 让它在日志里看得见:静默丢掉才是这个项目最不该有的处置。
    reported = (amazon_customer_id or "").strip() or None
    rejected_customer_id = None
    if reported is not None and not CUSTOMER_ID_RE.match(reported):
        rejected_customer_id, reported = reported, None

    row = conn.execute(
        f"""
        UPDATE procure.plugin_instances
           SET last_seen_at = now(),
               -- 这台机器此刻登着谁。**不传 = 这一轮没有新消息**,保留旧值 ——
               -- 与 login_state 同一条规则。抹成空的话,一台登错号的机器
               -- 只要有一轮读不到 customerId,认领闸当场重新打开。
               amazon_customer_id = CASE WHEN %(customer_id)s::text IS NULL
                                         THEN amazon_customer_id
                                         ELSE %(customer_id)s::text END,
               -- 留旧值还是覆盖,规则只有一处定义(_KEEPS_OLD_LOGIN_STATE)。
               -- **这一位和它的时刻永远一起动**:留住旧值就连 login_checked_at
               -- 一起留住,否则界面上会出现「已登出 · 刚刚检查过」——
               -- 而"刚刚"那一次读到的其实是"读不出来",时刻描述的不是它旁边那个值。
               login_state = CASE WHEN {_KEEPS_OLD_LOGIN_STATE}
                                  THEN login_state ELSE %(login_state)s::text END,
               login_checked_at = CASE WHEN {_KEEPS_OLD_LOGIN_STATE}
                                       THEN login_checked_at ELSE now() END
         WHERE instance_uid = %(uid)s
        RETURNING id, buyer_env_id, login_state, login_checked_at, amazon_customer_id
        """,
        {"uid": instance_uid, "login_state": login_state, "customer_id": reported},
    ).fetchone()
    if row is None:
        return None
    row["customer_id_rejected"] = rejected_customer_id
    # **先结算账号,再算「该不该去读页面」** —— 后者要用前者的结论:
    # 账号还没比对上的机器认领会被拒,而它自己没有别的办法知道该去读一次页面。
    row.update(_settle_customer_id(conn, instance_id=row["id"],
                                   buyer_env_id=row["buyer_env_id"],
                                   reported=row["amazon_customer_id"]))
    row["login_check_due"] = _login_check_due(
        conn,
        buyer_env_id=row["buyer_env_id"],
        checked_at=row["login_checked_at"],
        recheck_minutes=recheck_minutes,
        account_unverified=row["account_state"] == "unverified",
    )
    return row


def _settle_customer_id(conn, *, instance_id: int, buyer_env_id: int,
                        reported: str | None) -> dict[str, Any]:
    """输入:这台机器**此刻记着的**账号 → 输出:{expected_customer_id, account_state}。

    `reported` 是库里那一位(刚写完的),不是「这一轮报上来的」——
    这两者只在「这一轮什么都没报」时不同,而那时正该拿上一轮的结论继续判:
    一台登错号的机器读不到 customerId 的那几轮不该悄悄恢复派单。

    两条规则,方向相反,所以必须分开写:

      · 买家号那一列**为空** → 首次上报即写入,并留一条 `customer_id_seen`。
        这是这一列唯一的自动来源 —— 在此之前全仓一个写入点都没有,
        它是一列永远为空的数据(而 db_schema 里写着「插件从页面提取」)。
      · 已有值且**不一样** → **不覆盖**,留一条 `customer_id_mismatch`,
        认领闸(task_queue.account_blocks_claim)据此拒。
        覆盖是最坏的选择:一台登错号的机器会把买家号那一列改成它自己登的号,
        于是「登错了」这件事被它自己抹平,下一轮心跳一切正常。

    `mismatch` **每次心跳只记第一条**:20 秒一次的心跳无条件追加的话,一台登错号
    的机器一天往 env_events 里灌 4300 行,而它们说的是同一件事;真正要留痕的是
    这件事第一次发生、以及有人做了处置。判据是「上一条 mismatch 里的 reported
    与这次一样就不记」—— 换了个号登进去是新消息,同一个号不是。
    """
    env = conn.execute(
        "SELECT amazon_customer_id FROM procure.buyer_envs WHERE id = %s",
        (buyer_env_id,),
    ).fetchone()
    expected = (env["amazon_customer_id"] or None) if env else None

    if reported and not expected:
        # 条件写:同一个买家号上两台机器同时首报时,只有一台写得进去,
        # 另一台走下面的比对(而它们要是登着不同的号,第二台立刻被判 mismatch）。
        wrote = conn.execute(
            """UPDATE procure.buyer_envs
                  SET amazon_customer_id = %s, updated_at = now()
                WHERE id = %s AND (amazon_customer_id IS NULL OR amazon_customer_id = '')
            RETURNING amazon_customer_id""",
            (reported, buyer_env_id),
        ).fetchone()
        if wrote is not None:
            expected = wrote["amazon_customer_id"]
            record_env_event(conn, buyer_env_id, "customer_id_seen",
                             instance_id=instance_id,
                             payload={"reported": reported, "expected": None,
                                      "note": "买家号ID 之前是空的,按插件第一次报上来的写入"})
        else:
            expected = conn.execute(
                "SELECT amazon_customer_id FROM procure.buyer_envs WHERE id = %s",
                (buyer_env_id,)).fetchone()["amazon_customer_id"]

    state = task_queue.account_state(expected, reported)
    if state == "mismatch":
        last = conn.execute(
            """SELECT payload->>'reported' AS reported
                 FROM procure.env_events
                WHERE buyer_env_id = %s AND kind = 'customer_id_mismatch'
                ORDER BY id DESC LIMIT 1""",
            (buyer_env_id,),
        ).fetchone()
        if last is None or last["reported"] != reported:
            record_env_event(conn, buyer_env_id, "customer_id_mismatch",
                             instance_id=instance_id,
                             payload={"reported": reported, "expected": expected,
                                      "note": "这台机器登着的不是这个买家号,认领已被拒"})
    return {"expected_customer_id": expected, "account_state": state}


def _login_check_due(conn, *, buyer_env_id: int, checked_at, recheck_minutes: int,
                     account_unverified: bool = False) -> bool:
    """输入:连接 + 买家环境 id + 这个实例上次检查的时刻 + 复检间隔 → 输出:该不该去读页面。

    两个条件都要:
      · 这个买家号**真有单在等派** —— 队列空着的时候开一张 Amazon 页面读导航栏,
        读到的结论没人用得上,白白多一次页面加载
      · 这个实例上次读页面已经过了复检间隔,**或者**这台机器的账号还没比对过

    第二个「或者」是那道账号闸的解锁路径:`unverified` 的机器认领会被服务端拒,
    而 customerId 是在**登录探测那一步顺手读**的 —— 不主动要它去读一次页面,
    这台机器就永远报不上来,闸门永远关着。有界:插件那边 `ensureLoginChecked`
    还有一层本地缓存(LOGIN_CACHE_MS),不会每一拍都开一张页面。

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
    return bool(row["has_work"] and (row["stale"] or account_unverified))


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


LIST_SQL = f"""
SELECT e.id            AS env_id,
       e.code          AS env_code,
       e.marketplace,
       e.status        AS env_status,
       e.amazon_customer_id,
       -- **这台机器此刻登着的**那个账号(与上面那一列「这个买家号该是谁」是两列)。
       -- 两列一比才判得出「登错号了」—— 在此之前这一页上,一台登着隔壁号的机器
       -- 是满格绿色的「在线 · 可派」,而它领到的每一单都会用错的账号真买下来。
       i.amazon_customer_id AS instance_customer_id,
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
       -- 此刻有几单在途(claimed)。**给「改期望卡」那一格用的**:
       -- 认领时下发的是那一刻的快照,所以改这一格不会再把在途那单拦下 ——
       -- 但那个买家号在 Amazon 上的默认卡此刻**可能已经被切成旧值了**,
       -- 库与账号在这一刻不一致。运营台那一格因此在有在途单时问一句
       -- (web/src/pages/Instances.tsx 的 ExpectedCard),而不是 onBlur 就提交。
       -- 见 docs/01 §5.3。
       (SELECT count(*) FROM procure.tasks t
         WHERE t.buyer_env_id = e.id AND t.status = 'claimed')   AS in_flight,
       -- 「今日已拍」与真正那道日限闸必须是同一个数:判据在
       -- task_queue.OURS_ONLY_SQL(外部下单不算 —— 那不是我们拍的)。
       -- 分叉一次的表现是界面上绿着的「可派」和实际派不出,daily_cap 已经栽过一次。
       (SELECT count(*) FROM procure.tasks t
         WHERE t.buyer_env_id = e.id AND t.status = 'purchased'
           AND t.{task_queue.OURS_ONLY_SQL}
           AND t.purchased_at >= date_trunc('day', now()))       AS purchased_today,
       -- 最近 24 小时里,这个买家号有几单**试着清车但没清动**。
       --
       -- 这一位原先是「只写不读」的:/fail 收到 cart_cleared=false 就往事件流里
       -- 记一条 warning,全项目没有任何地方读它。而它说的是一件会连累后面每一单
       -- 的事 —— 清车是每一单的第一步,它失败通常意味着 Amazon 改了购物车页的结构,
       -- 于是队列里的单会被一单一单打进「拍单异常」桶,而运营台上那台机器
       -- 是满格绿色的「在线 · 可派」。与登录态那一列同一个道理,也放在同一页上。
       --
       -- 只数「试了没清动」:越过下单点之后按规矩不清车的那一路记的是另一个 payload
       -- (见 server/routes/tasks.fail),不该混进来。
       (SELECT count(*) FROM procure.task_events ev
          JOIN procure.tasks t ON t.id = ev.task_id
         WHERE t.buyer_env_id = e.id
           AND ev.kind = 'step'
           AND ev.payload->>'warning' = 'cart_not_cleared'
           AND ev.created_at >= now() - interval '24 hours')     AS cart_fail_24h
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
        # 账号那道闸同样只有一处定义(task_queue.account_state /
        # account_blocks_claim),认领 SQL 前那道闸调的是同一个函数。
        # **它拦两档**:登错号(mismatch)与还没比对过(unverified)。
        # 界面上这一格不许自己写死「登错号」三个字 —— 两档共用一句话的话,
        # 一台刚装好的机器会被当成登错号去人工处置。
        row["account_state"] = task_queue.account_state(
            row["amazon_customer_id"], row["instance_customer_id"])
        blocked = task_queue.account_blocks_claim(row["account_state"])
        row["account_blocks_dispatch"] = blocked
        row["dispatchable"] = (liveness == "online" and not capped
                               and not signed_out and not blocked)
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

    运营台那一格现在会为「清空 = 关掉这道闸」单独问一句(填一个新值不问 ——
    填错的表现是每一单都被拦下,吵而安全;关掉是**静悄悄地**不再校验)。
    那是界面上的一道拦,不是留痕:谁在什么时候关的,库里仍然答不出。
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


def set_customer_id(conn, env_id: int, customer_id: str | None, *,
                    operator: str | None = None) -> dict:
    """输入:连接 + 买家号 id + 账号(或空 = 清掉)+ 操作人 → 输出:改后的那一行。

    这是 `buyer_envs.amazon_customer_id` 唯一的人工入口(自动那条在 heartbeat 的
    `_settle_customer_id` 里,而且只在这一列为空时写)。

    **它会打开一道认领闸** —— 登错号被拒的那一道。所以与 `set_expected_card`
    不同,这一步**必须留痕**:往 `procure.env_events` 写一条 `customer_id_override`,
    带上改之前的值、改成什么、谁改的。一个能开闸的按钮按完之后库里一个字都不留,
    是这个项目不该有的东西。
    (`expected_card_last4` 还没接进这条事件流 —— 那是另一件事,这里不假装做过。)

    留空 = 清掉这一列,回到「还没比对过」,**等于关掉这道闸**。允许它,是因为
    真会有记错的时候;但它同样写事件 —— 关闸比开闸更该留痕。
    """
    v = (customer_id or "").strip() or None
    if v is not None and not CUSTOMER_ID_RE.match(v):
        raise EnvRefused(
            "BAD_CUSTOMER_ID",
            f"买家号ID 的形状不对(应形如 A1B2C3D4E5,A 开头 + 至少 8 位大写字母数字),"
            f"收到 {customer_id!r};留空表示清掉这一列、不再比对")
    before = conn.execute(
        "SELECT amazon_customer_id FROM procure.buyer_envs WHERE id = %s", (env_id,)
    ).fetchone()
    if before is None:
        raise EnvRefused("ENV_NOT_FOUND", f"买家号不存在:{env_id}")
    row = conn.execute(
        """UPDATE procure.buyer_envs
              SET amazon_customer_id = %s, updated_at = now()
            WHERE id = %s
        RETURNING id, code, amazon_customer_id""",
        (v, env_id),
    ).fetchone()
    record_env_event(conn, env_id, "customer_id_override",
                     payload={"expected": before["amazon_customer_id"], "reported": v,
                              "operator": operator,
                              "note": "人工把买家号ID 改成了这个值"})
    return dict(row)


def env_events(conn, env_id: int, *, limit: int = 20) -> list[dict]:
    """输入:买家号 id → 输出:这个买家号最近的事件(最新在前)。

    「这个号是什么时候被认出来的、什么时候开始登错、谁把它改成了准」
    三句话在同一条时间线上。

    **中文标签在这里就贴好**(照 error-stats 里 assert_skipped.label 那个先例):
    这几个 kind 不属于任何一个下发给前端的封闭集,让调用方再写一份中文
    就又多了一处会分叉的副本。

    ⚠ **运营台还没有渲染这条流** —— 眼下它只能从这个接口(或库里)读。
    写在这里,免得下一个人以为买家号那一页上看得见。
    """
    from services import vocab

    return [dict(r, label=vocab.ENV_EVENT_LABELS.get(r["kind"], r["kind"]))
            for r in conn.execute(
        """SELECT ev.kind, ev.payload, ev.created_at, i.instance_uid
             FROM procure.env_events ev
             LEFT JOIN procure.plugin_instances i ON i.id = ev.instance_id
            WHERE ev.buyer_env_id = %s
            ORDER BY ev.id DESC LIMIT %s""",
        (env_id, limit)).fetchall()]
