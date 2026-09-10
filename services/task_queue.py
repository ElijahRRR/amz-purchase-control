"""任务队列:认领、释放、状态流转。

设计取舍(所有者定稿 2026-08-20):
  运营前提是「同一买家号不会在两处同时登录拍单」,因此**不做**跨实例的并发互斥
  (无租约表、无顾问锁、无 per-env 唯一索引)。SKIP LOCKED 保留,它只是避免行锁
  排队,不承担正确性职责。

  claimed 态保留,但职责不是「锁」而是「在途标记」:
    · 供 task_sweep 发现「领走后再没消息」的任务
    · 供后台看清此刻哪些任务在执行
"""

from typing import Any

from services import error_codes, task_event

CLAIM_SQL = """
WITH env AS (
    -- expected_card_last4 跟着一起选出来:所有者定稿「替买家号切换支付卡」之后,
    -- 插件在读完结算页、报护栏之前要按它把卡切过去,所以它得随认领一起下发。
    --
    -- 与 daily_cap 同一个 CTE **只保证一件事**:这两位是同一瞬间从库里读到的,
    -- 认领这一次不会读到半新半旧的一组配置。**它关不掉那条真正的窗口** ——
    -- guard-check 是另一个请求、另一个事务,每次都重新查一遍 buyer_envs
    -- (server/routes/tasks.py 的 guard_check),而那已经是几分钟之后的事了。
    -- 所以「插件切的是旧值、服务端比的是新值」今天是**开着的**:认领之后
    -- 有人在运营台上改了这一格,这一单必然被 PAYMENT_METHOD_UNEXPECTED 拦下,
    -- 而且这一次买家号在 Amazon 上的默认支付卡已经被我们真改过了 —— 事件流里
    -- 没有任何一条说得出「这次失败是因为期望卡在途中被改了」。
    -- 关掉它要把期望卡快照进 tasks 行(走改表流程,guard-check 比快照而不是
    -- 比当前库值),那跨了这条线的文件边界,留给合并那一轮定夺。
    -- 有一条 pytest 把这条窗口钉着(test_expected_card_changed_mid_flight_...),
    -- docs/01 §5.3 里也记了改这一格时在途的单会怎样。
    SELECT daily_cap, expected_card_last4 FROM procure.buyer_envs WHERE id = %(env_id)s
),
done_today AS (
    -- 今天这个买家号已经拍成了多少单。日限是防关联场景下最基本的一条闸:
    -- 一个号一天买太多本身就是风控信号。
    SELECT count(*) AS n
      FROM procure.tasks
     WHERE buyer_env_id = %(env_id)s
       AND status = 'purchased'
       AND purchased_at >= date_trunc('day', now())
),
candidate AS (
    SELECT t.id
    FROM procure.tasks t
    WHERE t.status = 'ready'
      AND t.buyer_env_id = %(env_id)s
      -- daily_cap = 0 表示不限。闸门放在这条 SQL 里而不是路由里,
      -- 是为了让「查额度」和「选中并置位」天然同事务,不另开一个窗口。
      AND ((SELECT daily_cap FROM env) = 0
           OR (SELECT n FROM done_today) < (SELECT daily_cap FROM env))
    ORDER BY t.created_at
    FOR UPDATE OF t SKIP LOCKED
    LIMIT 1
)
UPDATE procure.tasks
   SET status = 'claimed',
       claimed_by = %(instance_id)s,
       claimed_at = now(),
       updated_at = now()
  FROM candidate, env
 WHERE procure.tasks.id = candidate.id
RETURNING procure.tasks.*, env.expected_card_last4
"""

PRODUCTS_SQL = """
SELECT asin, quantity FROM procure.task_products
 WHERE task_id = %(task_id)s ORDER BY id
"""

_TERMINAL = frozenset({"purchased", "exception", "manual", "cancelled"})


class ClaimBlocked(Exception):
    """认领被一道**说得出名字**的闸拦下了 —— 与「队列里没有单」是两回事。

    为什么不做成认领 SQL 里的一个 WHERE 条件(像 daily_cap 那样):那样返回的是
    「没选中任何行」,和「这个买家号确实没单可派」渲染出完全一样的结果 ——
    插件继续每 10 秒问一次,运营台上那台机器显示「待命」,谁也看不出它其实
    已经不能干活了。**两种不同的情况渲染出同一个结果就是缺陷**,而这一条正是
    本次要修的那个缺陷本身,不该在修它的时候又制造一个同形状的。
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def login_blocks_claim(login_state: str | None) -> bool:
    """输入:实例登录态 → 输出:这道闸拦不拦它。**登录态闸门的唯一定义处。**

    只拦 `signed_out`:
      · `ok`       —— 上一次读页面确实读到了登录态,放行
      · `unknown`  —— 我们不知道。**不拦**:新装的实例第一次心跳之前就是 unknown,
                      拦住它等于新机器永远领不到第一单。真被登出的话,执行中一落到
                      /ap/signin 就会被驱动逮住,退回队列并把这一位改成 signed_out,
                      下一次认领才轮到这道闸。
        —— 但 `unknown` 在**界面上**必须与 `ok` 分得开(「登录态存疑」 vs 「已登录」)。
        这两句话不矛盾:派单上一视同仁,是因为除此之外没有能派单的办法;
        显示上分开,是因为运营看到「存疑」会去看一眼,看到「已登录」不会。

    运营台的「可派单」调的也是这个函数(services/instance.list_with_liveness),
    两处算的必须是同一件事 —— daily_cap 曾经在这里分叉过一次,
    界面上绿着、真闸拦着,而界面里那个「已到日上限」的分支永远走不到。
    """
    return login_state == "signed_out"


def claim(conn, env_id: int, instance_id: int) -> dict[str, Any] | None:
    """输入:连接 + 买家环境 id + 插件实例 id → 输出:任务 dict(含 products
    与买家号的 expected_card_last4),无可派时 None。

    一条 SQL 完成「选中 + 置位」,不存在「选完还没置位」的窗口。

    登录态被判定为 signed_out 的实例在这里被拦下,抛 `ClaimBlocked` ——
    不是返回 None。这条先于认领 SQL 执行,与它同一个事务(同一条连接):
    读到的登录态和随后那次置位之间没有别人插得进来的窗口。
    """
    inst = conn.execute(
        "SELECT login_state, login_checked_at FROM procure.plugin_instances WHERE id = %s",
        (instance_id,),
    ).fetchone()
    if inst is not None and login_blocks_claim(inst["login_state"]):
        raise ClaimBlocked(
            "INSTANCE_SIGNED_OUT",
            "这个买家号的浏览器已被登出(上次检查:"
            f"{inst['login_checked_at'] or '未知'}),不派单。"
            "请在该浏览器环境里重新登录 Amazon,插件下一轮复检会自动恢复",
        )

    row = conn.execute(
        CLAIM_SQL, {"env_id": env_id, "instance_id": instance_id}
    ).fetchone()
    if row is None:
        return None
    row["products"] = conn.execute(PRODUCTS_SQL, {"task_id": row["id"]}).fetchall()
    task_event.record(conn, row["id"], "claimed", instance_id=instance_id)
    return row


def release(conn, task_id: int, instance_id: int | None = None) -> bool:
    """输入:连接 + 任务 id(+实例 id)→ 输出:是否成功退回 ready。

    插件主动放弃(不算失败)。只有仍处于 claimed 的任务才可退回 —— 已经流转到
    终态的任务不允许被一个迟到的 release 拉回队列。
    """
    row = conn.execute(
        """
        UPDATE procure.tasks
           SET status = 'ready', claimed_by = NULL, claimed_at = NULL, updated_at = now()
         WHERE id = %(task_id)s AND status = 'claimed'
        RETURNING id
        """,
        {"task_id": task_id},
    ).fetchone()
    if row is None:
        return False
    task_event.record(conn, task_id, "released", instance_id=instance_id)
    return True


def fail(
    conn,
    task_id: int,
    error_code: str,
    *,
    instance_id: int | None = None,
    detail: str | None = None,
    to_manual: bool = False,
) -> bool:
    """输入:连接 + 任务 id + 结构化错误码(+详情/是否转人工)→ 输出:是否写入成功。

    to_manual=True 用于「可能已经在 Amazon 上产生了订单」的场景(如下单后未见确认页),
    这类任务不能自动重试,必须人工确认。
    """
    error_codes.validate(error_code)   # 拼错的码宁可拒收,也不写进库
    status = "manual" if to_manual else "exception"
    row = conn.execute(
        """
        UPDATE procure.tasks
           SET status = %(status)s, error_code = %(code)s, error_detail = %(detail)s,
               claimed_by = NULL, claimed_at = NULL, updated_at = now()
         WHERE id = %(task_id)s AND status = 'claimed'
        RETURNING id
        """,
        {"task_id": task_id, "status": status, "code": error_code, "detail": detail},
    ).fetchone()
    if row is None:
        return False
    task_event.record(
        conn, task_id, "error", instance_id=instance_id, code=error_code,
        payload={"detail": detail, "to_manual": to_manual},
    )
    return True


def record_guard_amounts(conn, task_id: int, *, gift_card_amount, goods_total) -> None:
    """输入:连接 + 任务 id + 服务端算出的礼品卡抵扣额与货款 → 输出:无。

    在 guard-check 那一步落库,**不管放不放行**:被护栏拦下的单同样要能答出
    「当时比的是哪个数」。放在这里而不是 complete 里,是因为这两个数是服务端
    在裁决那一刻算出来的,complete 那一步的请求体里根本没有它们 ——
    让插件在下单后再报一遍,等于给同一个事实开两个来源。

    只更新还在途(claimed)的任务:一条迟到的 guard-check 不该改动一张已经
    流转到终态的单上的金额。

    **算不出来(None)时什么都不写。** 护栏在算出货款之前就返回的那几档
    (实付读不出来、认出礼品卡抵扣行却读不出金额)本来就答不出「比的是哪个数」,
    而拿 None 去覆盖的话,上一次 guard-check 已经落库的 5.00 / 15.79 会被抹成 NULL
    —— 界面上于是从「当时比的是 15.79」退回成「还没有下单,也就没有实付金额」,
    一个**更旧、而且是假的**结论。两个 None 都为空时这条 UPDATE 一列都不动。
    """
    sets = []
    params: dict = {"task_id": task_id}
    if gift_card_amount is not None:
        sets.append("gift_card_amount = %(gift)s")
        params["gift"] = gift_card_amount
    if goods_total is not None:
        sets.append("goods_total = %(goods)s")
        params["goods"] = goods_total
    if not sets:
        return
    conn.execute(
        "UPDATE procure.tasks SET " + ", ".join(sets) + ", updated_at = now()"
        " WHERE id = %(task_id)s AND status = 'claimed'",
        params,
    )


def _write_unit_prices(conn, task_id: int, line_items) -> None:
    """输入:任务 id + 结算页实测的行 → 输出:无。按 ASIN 回填 actual_unit_price。

    只更新已存在的商品行,不新增 —— 结算页多出一行商品意味着买错了东西,
    那种情况应该在购物车回读那一步就被 CART_MISMATCH 拦住,轮不到这里补救。
    """
    for item in line_items or []:
        asin = item["asin"] if isinstance(item, dict) else item.asin
        price = item["unit_price"] if isinstance(item, dict) else item.unit_price
        conn.execute(
            """UPDATE procure.task_products SET actual_unit_price = %s
                WHERE task_id = %s AND asin = %s""",
            (price, task_id, asin),
        )


def complete(
    conn,
    task_id: int,
    *,
    amazon_order_no: str,
    instance_id: int | None = None,
    totals: dict[str, Any] | None = None,
    line_items: list[Any] | None = None,
) -> bool:
    """输入:连接 + 任务 id + Amazon 订单号(+金额/交期/实测单价)→ 输出:是否写入成功。

    totals 可含 actual_total / actual_shipping / actual_tax / payment_last4 /
    delivery_date / delivery_raw。
    line_items 是结算页读到的每行单价,落进 task_products.actual_unit_price ——
    「上游给的限价」与「实际每件多少钱」是两个数,后者才是对账要看的。
    """
    t = totals or {}
    row = conn.execute(
        """
        UPDATE procure.tasks
           SET status = 'purchased',
               amazon_order_no = %(order_no)s,
               actual_total    = %(actual_total)s,
               actual_shipping = %(actual_shipping)s,
               actual_tax      = %(actual_tax)s,
               payment_last4   = %(payment_last4)s,
               delivery_date   = %(delivery_date)s,
               delivery_raw    = %(delivery_raw)s,
               purchased_at    = now(),
               claimed_by = NULL, claimed_at = NULL, updated_at = now()
         WHERE id = %(task_id)s AND status = 'claimed'
        RETURNING id
        """,
        {
            "task_id": task_id,
            "order_no": amazon_order_no,
            "actual_total": t.get("actual_total"),
            "actual_shipping": t.get("actual_shipping"),
            "actual_tax": t.get("actual_tax"),
            "payment_last4": t.get("payment_last4"),
            "delivery_date": t.get("delivery_date"),
            "delivery_raw": t.get("delivery_raw"),
        },
    ).fetchone()
    if row is None:
        return False
    _write_unit_prices(conn, task_id, line_items)
    task_event.record(
        conn, task_id, "purchased", instance_id=instance_id,
        payload={"amazon_order_no": amazon_order_no, **t},
    )
    return True


def sweep_stale(conn, timeout_minutes: int) -> list[int]:
    """输入:连接 + 超时分钟数 → 输出:被转为 manual 的任务 id 列表。

    claimed 超时**不退回 ready**:插件可能已经在 Amazon 上真下了单,只是没来得及
    回传。自动重试会造成重复下单,所以一律转人工确认。
    """
    rows = conn.execute(
        """
        UPDATE procure.tasks
           SET status = 'manual', error_code = 'CLAIM_TIMEOUT',
               error_detail = %(detail)s, updated_at = now()
         WHERE status = 'claimed'
           AND claimed_at < now() - make_interval(mins => %(mins)s)
        RETURNING id
        """,
        {"mins": timeout_minutes, "detail": f"领取后 {timeout_minutes} 分钟无回传"},
    ).fetchall()
    ids = [r["id"] for r in rows]
    for tid in ids:
        task_event.record(conn, tid, "error", code="CLAIM_TIMEOUT")
    return ids
