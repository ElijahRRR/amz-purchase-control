"""任务落库:把上游发下来的采购行变成 procure.tasks。

这是整套系统的入口 —— 没有它,库里一条任务都不会有。

去重靠 line_key。**一条 task = 一张上游订单 = 一次 Amazon 下单**,
里面可以有多个商品(插件会把它们一起加购、一次结算)。所以 line_key 必须覆盖
整个商品集合,不能只拿其中一个 ASIN:

    line_key = sha256("上游单号|asin1xN,asin2xM")   (ASIN 排序后拼)

docs/db_schema.md 原来写的是 sha256(上游单号|asin),那是单商品时的写法 ——
task_products 是个列表,多商品时"哪个 asin"没有答案。含糊的唯一键比没有唯一键
更糟:它会在某些组合下让同一张上游订单重复落库,而看代码的人以为有去重。
"""

import hashlib
import json
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from services import error_codes, task_event

MARKETPLACES = frozenset({"US"})     # 首期只做 US

#: Amazon 单号形态。与 services/task_query.AMZ_ORDER_RE、
#: server/schemas.ForceBackfillReq 是同一条规则 —— 三处都在拦同一件事:
#: 一个形状不对的单号写进库,后面对账、物流、退款全跟着错。
AMZ_ORDER_RE = re.compile(r"^\d{3}-\d{7}-\d{7}$")

#: 这一单是谁买的(procure.tasks.purchase_source 的封闭集)。
#: 标签在 services/vocab.PURCHASE_SOURCE_LABELS。
PURCHASE_SOURCES = frozenset({"plugin", "external", "manual_backfill"})

#: **上游后来才填上 AMZ 单号时,已有任务按状态分流的那张表**(唯一定义处;
#: docs/01-系统设计.md §10 是它的文字版,两边必须说同一件事)。
#:
#: 这几个状态可以转成「外部下单」:单子还没被买到,或者买砸了/在等人 ——
#: 上游既然已经在别处买了,我们这边那张单就不该再被拍一次。
#:
#: **状态只是判据的三分之一**,另外两条是「越过没越过下单点」与「失败原因属不属于
#: 『可能已下单』那一组」,三条在 `_can_migrate` 里取与。光看状态的话,一张
#: `manual + may_have_ordered` 的单(插件在点下单按钮之前报过 step、随后
#: ORDER_CONFIRM_TIMEOUT,正等着人去买家号订单页看一眼到底下没下成)会被一轮定时
#: 同步静默转成「已拍单 · 外部下单」并清掉错误码 —— 全项目唯一「可能已经花过钱」
#: 的那一桶被清空,而 NEEDS_ACK 那道要人亲自确认的闸一次都没被问过。
_MIGRATABLE = frozenset({"pending", "ready", "exception", "manual"})


def _can_migrate(t: dict[str, Any]) -> bool:
    """输入:库里那一行 → 输出:能不能转成「外部下单」。**状态迁移表的判据,唯一定义处。**

    三条取与:
      · 状态在 `_MIGRATABLE` 里 —— 单子还没被买到,或者买砸了/在等人
      · **没越过下单点** —— `may_have_ordered` 为真意味着插件已经点过下单按钮
        (或者点的过程中崩了),这一单可能已经在亚马逊上真花过钱
      · **失败原因不属于「可能已下单」那一组** —— `error_codes.POSSIBLY_ORDERED`

    后两条**与 `task_admin.reset_to_queue` 那道 NEEDS_ACK 闸同源,而且必须同源**:
    那边判的正是 `risky_code or crossed` 两条取或(见 README「几条贯穿全项目的判断」)。
    只判 `may_have_ordered` 会漏掉一整类:`CLAIM_TIMEOUT`(插件领走之后机器睡了/崩了,
    那条 step 从没发出去,这一位仍是 false)、以及**所有加列之前的历史行**
    —— `may_have_ordered` 是后加的 `ADD COLUMN ... DEFAULT false`,加列之前那些
    `manual + ORDER_CONFIRM_TIMEOUT` 的单在这一位上一律是 false。实测过:
    一张 `manual + CLAIM_TIMEOUT` 的单,人工重置被 NEEDS_ACK 拦下,而同一张单
    走一轮定时同步就被静默转成「已拍单 · 外部下单」、错误码被清掉、
    单号换成上游那一张 —— 同一件事两条路两个答案。

    **回队列与转终态都不许替人做那次「去买家号订单页看一眼到底买了几次」的确认。**
    `claimed` 那一格早就有这条保护(报 conflicted 让人去看)。
    """
    return (t["status"] in _MIGRATABLE
            and not t["may_have_ordered"]
            and t["error_code"] not in error_codes.POSSIBLY_ORDERED)


def line_key(upstream_order_no: str, products: list[dict[str, Any]]) -> str:
    """输入:上游单号 + 商品行 → 输出:该上游订单的行唯一键(十六进制)。

    ASIN 排序后再拼,保证「同一批商品换个顺序」得到同一个键。
    """
    parts = sorted(f"{p['asin']}x{int(p['quantity'])}" for p in products)
    return hashlib.sha256(f"{upstream_order_no}|{','.join(parts)}".encode()).hexdigest()


_REQUIRED = ("upstream_order_no", "buyer_env_code", "price_cap",
             "ship_name", "ship_phone", "ship_line1", "ship_city",
             "ship_state", "ship_postcode")

_INSERT = """
INSERT INTO procure.tasks
  (line_key, upstream_order_no, buyer_env_id, marketplace, status, purchase_source,
   ship_name, ship_phone, ship_line1, ship_city, ship_state, ship_postcode, ship_country,
   price_cap, max_delivery_days, amazon_order_no, purchased_at)
VALUES
  (%(line_key)s, %(upstream_order_no)s, %(env_id)s, %(marketplace)s, %(status)s,
   %(purchase_source)s,
   %(ship_name)s, %(ship_phone)s, %(ship_line1)s, %(ship_city)s, %(ship_state)s,
   %(ship_postcode)s, %(ship_country)s, %(price_cap)s, %(max_delivery_days)s,
   %(amazon_order_no)s,
   -- 上游没给采购时间就用库里的 now()。**用数据库的钟,不用进程的钟** ——
   -- 这一列后面要跟 date_trunc('day', now()) 比(日限、今日已拍),
   -- 两个钟差几秒就够把一张单算到昨天去。
   COALESCE(%(purchased_at)s::timestamptz,
            CASE WHEN %(status)s = 'purchased' THEN now() END))
ON CONFLICT (line_key) DO NOTHING
RETURNING id
"""


def is_external(row: dict[str, Any]) -> bool:
    """输入:一行 → 输出:这是不是一张「外部下单」的行。**判据的唯一定义处。**

    判据只有一条:上游把 AMZ 单号填进来了。所有者定稿 ④ —— 订单可能不经本系统
    采购,但要由本系统同步物流;而进物流同步只要三样东西(上游单号、买家号、
    AMZ 单号),限价、交期、护栏对它一概没有意义。
    """
    return bool(str(row.get("amazon_order_no") or "").strip())


def parse_purchased_at(value: Any) -> datetime | None:
    """输入:上游给的采购时间(datetime / ISO 字符串 / 空)→ 输出:datetime;认不出抛 ValueError。"""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, datetime):
        return value
    # 上游那张表里这一格多半是人手填的文本。"Z" 结尾 fromisoformat 到 3.11 才认,
    # 换成 +00:00 —— 认不出就抛,由调用方拒成一条带理由的 rejected。
    #
    # **不带时区的字符串按数据库会话时区算**(psycopg 原样送进 timestamptz,
    # 由 PostgreSQL 解释)。上游填 "2026-09-01 10:00" 时我们无从知道那是哪儿的
    # 十点,不在这里替它猜一个 —— 猜出来的偏移会安静地把一张单算到前一天。
    #
    # 下面这几行原先只有上面那两段注释、**没有实现**:任何字符串都静默变成 None,
    # 于是 docstring 承诺的「认不出抛 ValueError」与 _validate 里那条
    # 「purchased_at 不是时间」的拒收一次都不会触发,而上游给的时间被丢掉、
    # 换成落库时的 now() —— 八月的单全部记成同步那一天。
    if not isinstance(value, str):
        raise ValueError(f"purchased_at 只认时间或 ISO 字符串,收到 {type(value).__name__}")
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


def _validate(row: dict[str, Any]) -> str | None:
    """输入:一行 → 输出:拒收理由;通过返回 None。"""
    external = is_external(row)
    for field in _REQUIRED:
        # 外部单没有限价这回事:那一单不经我们的护栏,库里那个 0 是个占位。
        # 逼上游为一张已经买完的单编一个限价,只会换来一列没人敢信的数。
        if external and field == "price_cap":
            continue
        if not str(row.get(field) or "").strip():
            return f"缺字段 {field}"

    if external:
        no = str(row["amazon_order_no"]).strip()
        if not AMZ_ORDER_RE.match(no):
            # 形状不对的单号写进库,后面对账、物流、退款全跟着错;而它又正好是
            # 人手填进上游那张表的那一格,填错是常态。
            return f"AMZ 单号形状不对(要 111-1234567-1234567):{no!r}"
        try:
            parse_purchased_at(row.get("purchased_at"))
        except (ValueError, TypeError):
            return f"purchased_at 不是时间:{row.get('purchased_at')!r}"

    marketplace = (row.get("marketplace") or "US").upper()
    if marketplace not in MARKETPLACES:
        return f"首期只做 {'/'.join(sorted(MARKETPLACES))},收到 {marketplace}"

    if row.get("price_cap") is not None and str(row.get("price_cap")).strip():
        try:
            cap = Decimal(str(row["price_cap"]))
        except (InvalidOperation, ValueError, TypeError):
            return f"price_cap 不是数字:{row['price_cap']!r}"
        # 外部单的限价只可能是个占位:它没走过我们的结算页,没有任何一道闸会读它。
        # 负数照旧拒 —— 那不是占位,那是填错了。
        if external:
            if cap < 0:
                return f"price_cap 不能是负数,收到 {cap}"
        elif cap <= 0:
            # 限价是护栏的输入。0 或负数会让「实付 ≤ 限价」永远不成立,
            # 整批单全卡在待人工 —— 这种错要在入口拦下,不能等到插件跑到结算页。
            return f"price_cap 必须大于 0,收到 {cap}"

    # 下面两条校验对应 ingest 里真正做的类型转换。少了它们,dry_run 会说「都能进」,
    # 而 ingest 走到那一行时抛 ValueError/AttributeError,pg_conn 回滚 ——
    # **连同已经写进去的前几行一起**,最终 0 行落库,而且 details 里一句解释都没有。
    # 模块 docstring 承诺「预览数字与真跑一致」,这两处正好把承诺打破。
    md = row.get("max_delivery_days")
    if md:
        try:
            int(md)
        except (ValueError, TypeError):
            return f"max_delivery_days 不是整数:{md!r}"

    products = row.get("products") or []
    if not products:
        return "没有商品行"
    for p in products:
        # 必须是字符串:上游把 ASIN 导成 JSON 数字(630509311712)时,
        # str() 判空能过,而 ingest 里的 p["asin"].strip() 会抛 AttributeError。
        if not isinstance(p.get("asin"), str) or not p["asin"].strip():
            return f"商品行的 asin 必须是非空字符串,收到 {p.get('asin')!r}"
        try:
            if int(p["quantity"]) <= 0:
                return f"{p['asin']} 的数量必须大于 0"
        except (KeyError, ValueError, TypeError):
            return f"{p.get('asin')} 的数量不是整数"
    return None


def _order_no_taken(conn, amazon_order_no: str, line_key: str) -> int | None:
    """输入:AMZ 单号 + 本行的 line_key → 输出:已经占着这个单号的**别的**任务 id。

    先查一次是为了给出人话并且**只废掉这一行**。库层的 uq_tasks_amazon_order_no
    仍然是最后一道闸,但让它去拦的代价是整批回滚:pg_conn 遇异常 rollback,
    连同前面已经写进去的几十行一起没了,而 details 里一句解释都没有。
    """
    row = conn.execute(
        "SELECT id FROM procure.tasks WHERE amazon_order_no = %s AND line_key <> %s",
        (amazon_order_no, line_key),
    ).fetchone()
    return row["id"] if row else None


def _order_no_taken_reason(amazon_order_no: str, task_id: int | None) -> str:
    """输入:AMZ 单号 + 占着它的任务 id(同一批里的前一行则为 None)→ 输出:拒收理由。

    **只管措辞,不参与决定。** 真跑与空跑共用它 —— 两套措辞的话,空跑说的和
    真跑说的对不上,而人是照空跑那份去核对的。
    """
    if task_id is None:
        return (f"AMZ 单号 {amazon_order_no} 在这一批里出现了两次 —— "
                f"两张上游订单不可能是同一张亚马逊订单,这一行没落库")
    return f"AMZ 单号 {amazon_order_no} 已经挂在任务 {task_id} 上了"


def _mark_external(conn, *, line_key: str, amazon_order_no: str,
                   purchased_at: datetime | None) -> tuple[str, str | None]:
    """输入:已在库的那一行 + 上游填的 AMZ 单号 → 输出:(result, 说明)。

    **状态迁移表的执行处**(表在模块顶上的 `_MIGRATABLE`,文字版在 docs/01 §10):

      pending / ready / exception / manual  → 转 purchased(external),写一条事件
      **任一状态 + 越过下单点**              → **一动不动**,报出来让人看
      **任一状态 + 码属于「可能已下单」**    → **一动不动**,报出来让人看
      claimed                               → **一动不动**,报出来让人看
      purchased 且单号相同                   → 什么都不做,也不报(幂等,回写就是这么来的)
      purchased 且单号不同                   → 一动不动,报出来
      其余(cancelled)                       → 一动不动,报出来

    `claimed` 那一格是这张表里最要紧的一条:插件此刻正拿着这一单在亚马逊上下单。
    这时候把它改成「已拍单」,插件几分钟后回来 complete 会拿到 409 TASK_NOT_HELD
    —— 钱花了、货发了,而库里记的是上游那张单号。所以宁可不动、报给人看。

    「越过下单点」那一行同源:那一单**已经**可能花过钱,转成外部下单等于替人
    做掉了「去订单页看一眼到底买了几次」那次确认,还顺手清掉了错误码 ——
    离开待人工桶之后没有人会再去核对它。
    """
    t = conn.execute(
        "SELECT id, status, amazon_order_no, may_have_ordered, error_code"
        "  FROM procure.tasks WHERE line_key = %s",
        (line_key,),
    ).fetchone()
    if t is None:
        return "duplicated", None          # 刚被别人删了,当作没这回事
    if t["status"] == "purchased" and t["amazon_order_no"] == amazon_order_no:
        return "duplicated", None          # 每轮全量拉,这是常态,不报
    # **转不转只看 `_MIGRATABLE` 这一个判据。** 下面那几句只负责把「为什么没动」
    # 说清楚,不参与决定 —— 原先是「claimed 一条分支、purchased 一条分支、
    # 剩下的才查这个集合」,于是这个集合并不是它自称的那个唯一定义处:
    # 往里面加一个 claimed 什么都不会变,而那正是这张表最要紧的一格
    # (实测:加进去之后那条测试照旧全绿)。
    if not _can_migrate(t):
        return "conflicted", _why_not_migrated(t, amazon_order_no)

    conn.execute(
        """UPDATE procure.tasks
              SET status = 'purchased', purchase_source = 'external',
                  amazon_order_no = %(no)s,
                  purchased_at = COALESCE(%(at)s, purchased_at, now()),
                  -- 转成外部单之后这一单不再由我们拍,原来的失败原因是过去时了。
                  -- 留着的话运营台会一边写「已拍单」一边挂着一个红色错误码。
                  error_code = NULL, error_detail = NULL,
                  claimed_by = NULL, claimed_at = NULL, updated_at = now()
            WHERE id = %(id)s""",
        {"no": amazon_order_no, "at": purchased_at, "id": t["id"]},
    )
    # 事件流里必须留一条:这一单的状态是被**上游那张表**改掉的,不是插件拍成的。
    # 混成一条普通的「下单成功」的话,事后没人答得上「这单我们到底拍没拍过」。
    task_event.record(conn, t["id"], "purchased",
                      payload={"amazon_order_no": amazon_order_no,
                               "purchase_source": "external",
                               "from_status": t["status"],
                               "note": "上游给了 AMZ 单号,按外部下单处理"})
    return "migrated", None


def ingest(conn, rows: list[dict[str, Any]], *, release: bool = False) -> dict[str, Any]:
    """输入:上游采购行 → 输出:{inserted, duplicated, rejected, migrated, conflicted, details}。

    release=True 直接落成 ready(可被认领);默认落成 pending(等放行)。

    **带了 amazon_order_no 的行是「外部下单」**(所有者定稿 ④):落成
    purchased + purchase_source='external',`release` 对它没有意义 ——
    它不经拍单也不经护栏,直接进物流同步队列。已经在库里的单后来才出现单号时,
    按 `_mark_external` 那张状态迁移表处置。

    **每一行的去向都会出现在 details 里**,不存在被静默丢掉的行。
    厂商那套导入回一句「导入成功」就完了,少了几行没人知道。
    """
    env_ids: dict[str, int] = {}
    details: list[dict[str, Any]] = []
    inserted = duplicated = rejected = migrated = conflicted = 0

    for idx, row in enumerate(rows):
        entry = {"index": idx, "upstream_order_no": row.get("upstream_order_no")}
        reason = _validate(row)
        if reason:
            rejected += 1
            details.append({**entry, "result": "rejected", "reason": reason})
            continue

        code = row["buyer_env_code"]
        if code not in env_ids:
            got = conn.execute(
                "SELECT id FROM procure.buyer_envs WHERE code = %s", (code,)
            ).fetchone()
            if got is None:
                rejected += 1
                details.append({**entry, "result": "rejected",
                                "reason": f"买家号 {code} 不存在"})
                continue
            env_ids[code] = got["id"]

        products = row["products"]
        key = line_key(row["upstream_order_no"], products)
        external = is_external(row)
        order_no = str(row["amazon_order_no"]).strip() if external else None
        purchased_at = parse_purchased_at(row.get("purchased_at")) if external else None

        if external and (taken := _order_no_taken(conn, order_no, key)) is not None:
            rejected += 1
            details.append({**entry, "result": "rejected",
                            "reason": _order_no_taken_reason(order_no, taken)})
            continue

        got = conn.execute(_INSERT, {
            "line_key": key,
            "upstream_order_no": row["upstream_order_no"],
            "env_id": env_ids[code],
            "marketplace": (row.get("marketplace") or "US").upper(),
            "status": "purchased" if external else ("ready" if release else "pending"),
            "purchase_source": "external" if external else "plugin",
            "ship_name": row["ship_name"], "ship_phone": row["ship_phone"],
            "ship_line1": row["ship_line1"], "ship_city": row["ship_city"],
            "ship_state": row["ship_state"], "ship_postcode": row["ship_postcode"],
            "ship_country": (row.get("ship_country") or "US").upper(),
            # 外部单没有限价:库里那一列 NOT NULL,落一个 0 占位,
            # 而界面对 external 一律显示「外部下单,不适用」,不写「未超」。
            # **一律 .get**:_validate 对外部行跳过 price_cap 的必填检查,
            # 于是一行干脆没有这个键的外部单在这里会 KeyError,pg_conn 回滚整批
            # —— 连同前面已经写进去的几十行一起没了,而 dry_run 对同一行说「会新增」。
            "price_cap": Decimal(str(row.get("price_cap") or 0)),
            "max_delivery_days": int(row.get("max_delivery_days") or 7),
            "amazon_order_no": order_no,
            # None 时由上面那句 SQL 用库里的 now() 补(只对 purchased 补)。
            # 留空的话这张单在「按采购时间」的筛选与统计里整个消失。
            "purchased_at": purchased_at,
        }).fetchone()

        if got is None:
            if external:
                result, note = _mark_external(conn, line_key=key, amazon_order_no=order_no,
                                              purchased_at=purchased_at)
                if result == "migrated":
                    migrated += 1
                    details.append({**entry, "result": "migrated", "line_key": key,
                                    "amazon_order_no": order_no})
                elif result == "conflicted":
                    conflicted += 1
                    details.append({**entry, "result": "conflicted", "line_key": key,
                                    "reason": note})
                else:
                    duplicated += 1
                    details.append({**entry, "result": "duplicated", "line_key": key})
                continue
            duplicated += 1
            details.append({**entry, "result": "duplicated", "line_key": key})
            continue

        task_id = got["id"]
        for p in products:
            conn.execute(
                """INSERT INTO procure.task_products (task_id, asin, quantity, image_url)
                   VALUES (%s, %s, %s, %s)""",
                (task_id, p["asin"].strip(), int(p["quantity"]), p.get("image_url")),
            )
        if external:
            task_event.record(conn, task_id, "purchased",
                              payload={"amazon_order_no": order_no,
                                       "purchase_source": "external",
                                       "from_status": None,
                                       "note": "上游给了 AMZ 单号,按外部下单处理"})
        inserted += 1
        details.append({**entry, "result": "inserted", "task_id": task_id, "line_key": key,
                        **({"amazon_order_no": order_no} if external else {})})

    return {"inserted": inserted, "duplicated": duplicated, "rejected": rejected,
            "migrated": migrated, "conflicted": conflicted, "details": details}


def dry_run(conn, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """输入:采购行 → 输出:与 ingest 同形状的预览,**不写库**。

    走的是与 ingest 完全相同的判定路径(字段校验、买家号存不存在、line_key 是否已落过、
    AMZ 单号被不被占、已有任务的状态该不该迁移),所以预览数字与真跑一致。
    只做字段校验的空跑会少报拒收,那种「预览与真跑对不上」的空跑比没有空跑更误导人。
    """
    details: list[dict[str, Any]] = []
    inserted = duplicated = rejected = migrated = conflicted = 0
    seen_keys: set[str] = set()
    # 同一批里已经用掉的 AMZ 单号。**必须有它**:真跑时第一行落库、第二行被
    # `_order_no_taken` 拒掉,空跑这一侧不记的话就说「两行都会新增」——
    # 而这一批数字正是运营用来判断「这一轮同步对不对」的唯一依据。
    # line_key 那一侧的 `seen_keys` 是同一个道理。
    seen_order_nos: set[str] = set()

    for idx, row in enumerate(rows):
        entry = {"index": idx, "upstream_order_no": row.get("upstream_order_no")}
        reason = _validate(row)
        if reason:
            rejected += 1
            details.append({**entry, "result": "rejected", "reason": reason})
            continue
        code = row["buyer_env_code"]
        exists = conn.execute(
            "SELECT 1 FROM procure.buyer_envs WHERE code = %s", (code,)
        ).fetchone()
        if exists is None:
            rejected += 1
            details.append({**entry, "result": "rejected", "reason": f"买家号 {code} 不存在"})
            continue
        key = line_key(row["upstream_order_no"], row["products"])
        external = is_external(row)
        order_no = str(row["amazon_order_no"]).strip() if external else None

        if external:
            taken = _order_no_taken(conn, order_no, key)
            if taken is not None or order_no in seen_order_nos:
                rejected += 1
                details.append({**entry, "result": "rejected",
                                "reason": _order_no_taken_reason(order_no, taken)})
                continue

        in_db = conn.execute(
            "SELECT status, amazon_order_no, may_have_ordered, error_code"
            "  FROM procure.tasks WHERE line_key = %s", (key,)
        ).fetchone()
        dup = key in seen_keys or in_db is not None
        if dup:
            if external and in_db is not None:
                # 与真跑同一张迁移表 —— 这里只是不写。两处判据分叉的话,
                # 空跑说「会转 3 条」而真跑转了 5 条,那种空跑比没有空跑更坏。
                if in_db["status"] == "purchased" and in_db["amazon_order_no"] == order_no:
                    duplicated += 1
                    details.append({**entry, "result": "duplicated", "line_key": key})
                elif _can_migrate(in_db):
                    migrated += 1
                    seen_order_nos.add(order_no)
                    details.append({**entry, "result": "migrated", "line_key": key,
                                    "amazon_order_no": order_no})
                else:
                    conflicted += 1
                    details.append({**entry, "result": "conflicted", "line_key": key,
                                    "reason": _why_not_migrated(in_db, order_no)})
                continue
            duplicated += 1
            details.append({**entry, "result": "duplicated", "line_key": key})
            continue
        seen_keys.add(key)      # 同一批里重复的行,第二次也是重复
        if external:
            seen_order_nos.add(order_no)
        inserted += 1
        details.append({**entry, "result": "inserted", "line_key": key,
                        **({"amazon_order_no": order_no} if external else {})})

    return {"inserted": inserted, "duplicated": duplicated, "rejected": rejected,
            "migrated": migrated, "conflicted": conflicted, "details": details}


def _why_not_migrated(t: dict[str, Any], amazon_order_no: str) -> str:
    """输入:库里那一行 + 上游填的单号 → 输出:「为什么没动」那句话。

    **只管措辞,不参与决定**(决定在 `_can_migrate`)。真跑与空跑共用它 ——
    两套措辞的话,空跑说的和真跑说的对不上,而人是照空跑那份去核对的。
    """
    if t["status"] == "claimed":
        # 这张表里最要紧的一格:插件此刻正拿着这一单在亚马逊上下单。
        return (f"插件正在拍这单(claimed),上游却填了 AMZ 单号 {amazon_order_no} —— "
                f"这一单没动。请去买家号订单页看一眼到底买了几次")
    if t["may_have_ordered"]:
        # 与 claimed 那一格同源:两者都是「可能已经花过钱」,只是一个正在花、
        # 一个已经花完还没确认。措辞里必须出现「到底买了几次」——
        # 这一句就是要人去买家号订单页做的那件事。
        return (f"这一单越过过下单点(可能已经在亚马逊上真花过钱,状态 {t['status']}),"
                f"上游又填了 AMZ 单号 {amazon_order_no} —— 这一单没动。"
                f"请去这个买家号的订单页确认到底买了几次")
    if t["error_code"] in error_codes.POSSIBLY_ORDERED:
        # 与 may_have_ordered 那一格同源,只是这一支拦的是**那条 step 从没发出去**
        # 的那一类:CLAIM_TIMEOUT(领走之后机器睡了/崩了)、以及所有加列之前的
        # 历史行。措辞照 task_admin.reset_to_queue 那道 NEEDS_ACK 闸的口径 ——
        # 同一件事在两条路上必须是同一句话,而且说的是**中文标签**不是英文码
        # (docs/01 §4:界面上不出现英文码)。
        return (f"这一单的失败原因是「{error_codes.label(t['error_code'])}」,"
                f"意味着它可能已经真下成了(状态 {t['status']}),"
                f"上游又填了 AMZ 单号 {amazon_order_no} —— 这一单没动。"
                f"请去这个买家号的订单页确认到底买了几次")
    if t["status"] == "purchased":
        return (f"这一单已经是已拍单,库里的 AMZ 单号是 {t['amazon_order_no']},"
                f"上游填的是 {amazon_order_no} —— 两个号不一样,没动")
    return f"{t['status']} 的单不接外部单号({amazon_order_no})—— 没动"


# ── 给人看的那份摘要(两条工作流共用)────────────────────────────────────
#
# 原先是两份副本,于是加了 migrated/conflicted 两个计数之后只改了飞书那一边:
# `cli.py task_intake` 那条文件入口的摘要三个数全是 0、一句话都没有,而其中
# 那条要人立刻去看的 conflicted 被「只挑 rejected」的过滤悄悄滤掉了。
# ingest 的 docstring 承诺「每一行的去向都会出现在 details 里」——
# details 里确实有,而人看的那份摘要里没有,那句承诺就只兑现了一半。

#: 空跑那份预览里,一行「会发生什么」的说法。**按 result 分别给话**:
#: migrated 没有 reason,原先与 duplicated 共用 `d.get("reason") or "已在库中"`,
#: 于是 30 条即将被改成「已拍单」的行印的是「已在库中」——
#: 「什么都不会变」和「会被改成已拍单」渲染成同一句话。
_PREVIEW_NOTE = {
    "duplicated": "已在库中",
    "migrated": "将转成外部下单(上游给了 AMZ 单号,不再由我们拍)",
}


def preview_note(d: dict[str, Any]) -> str:
    """输入:details 里的一条 → 输出:空跑清单上那一行的说明。"""
    return d.get("reason") or _PREVIEW_NOTE.get(d["result"], d["result"])


def summarize(got: dict[str, Any], *, total: int, unit: str = "行",
              verb: str = "落库完成", dry_run: bool = False, tail: str = "") -> str:
    """输入:ingest/dry_run 的结果 + 这一批有多少行 → 输出:那份计数摘要。

    **五个计数一个都不许少。** 少一个的表现不是「少一行字」:一轮把 30 张待拍单
    转成了已拍单、还撞上一条插件正在拍的单,而终端上打出来的是「新增 0,重复 0,
    拒收 0」——三个 0,没有任何东西告诉人刚才库里动了 31 行。
    """
    if dry_run:
        return (f"dry-run:{total} {unit} → 将新增 {got['inserted']},"
                f"重复 {got['duplicated']},拒收 {got['rejected']}"
                f",转外部下单 {got['migrated']},外部单号对不上 {got['conflicted']}"
                + tail)
    out = (f"{verb}:新增 {got['inserted']},重复 {got['duplicated']},"
           f"拒收 {got['rejected']}(共 {total} {unit})")
    # 外部下单那两个数**单独说**,不并进「新增/重复」:
    # 「上游后来给了单号,我们把已有的单转成了外部下单」和「新落了一张单」是两件事,
    # 合在一起的话,一轮把 30 张待拍单全部转成已拍单会显示成「重复 30」——
    # 一个每天都出现、谁也不会多看一眼的数字。
    if got.get("migrated"):
        out += f"\n  转外部下单 {got['migrated']} 条(上游给了 AMZ 单号,不再由我们拍)"
    if got.get("conflicted"):
        out += f"\n  ⚠ 外部单号对不上 {got['conflicted']} 条(都没动,逐条见下)"
    return out + tail


def explain_rows(got: dict[str, Any]) -> str:
    """输入:ingest 的结果 → 输出:「拒收/未动明细」那一段(没有就空串)。

    拒收的必须逐条说出来 —— 厂商那套导入回一句「导入成功」就完了,少了几行没人知道。
    **conflicted 也在这一段里**:那几条同样是没落库的事实,而且其中两种
    (插件正在拍这单、这一单越过过下单点)是要人立刻放下手里的事去看的。
    """
    bad = [d for d in got["details"] if d["result"] in ("rejected", "conflicted")]
    if not bad:
        return ""
    out = "\n  拒收/未动明细:"
    for d in bad:
        out += f"\n    #{d['index']} {d['upstream_order_no']}: {d['reason']}"
    return out


def load_rows(path) -> list[dict[str, Any]]:
    """输入:JSON 文件路径 → 输出:采购行列表。

    文件形态是 [{...}, {...}] 或 {"rows": [...]}。
    上游 ERP 的真实接口还没接,先走文件投放 —— 形状与将来的接口一致,
    接上时换掉这个函数即可。
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["rows"] if isinstance(data, dict) else data
