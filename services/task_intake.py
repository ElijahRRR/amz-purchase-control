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

from services import task_event

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
_MIGRATABLE = frozenset({"pending", "ready", "exception", "manual"})


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


def _mark_external(conn, *, line_key: str, amazon_order_no: str,
                   purchased_at: datetime | None) -> tuple[str, str | None]:
    """输入:已在库的那一行 + 上游填的 AMZ 单号 → 输出:(result, 说明)。

    **状态迁移表的执行处**(表在模块顶上的 `_MIGRATABLE`,文字版在 docs/01 §10):

      pending / ready / exception / manual  → 转 purchased(external),写一条事件
      claimed                               → **一动不动**,报出来让人看
      purchased 且单号相同                   → 什么都不做,也不报(幂等,回写就是这么来的)
      purchased 且单号不同                   → 一动不动,报出来
      其余(cancelled)                       → 一动不动,报出来

    `claimed` 那一格是这张表里最要紧的一条:插件此刻正拿着这一单在亚马逊上下单。
    这时候把它改成「已拍单」,插件几分钟后回来 complete 会拿到 409 TASK_NOT_HELD
    —— 钱花了、货发了,而库里记的是上游那张单号。所以宁可不动、报给人看。
    """
    t = conn.execute(
        "SELECT id, status, amazon_order_no FROM procure.tasks WHERE line_key = %s",
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
    if t["status"] not in _MIGRATABLE:
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
                            "reason": f"AMZ 单号 {order_no} 已经挂在任务 {taken} 上了"})
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
            "price_cap": Decimal(str(row["price_cap"] or 0)),
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

        if external and (taken := _order_no_taken(conn, order_no, key)) is not None:
            rejected += 1
            details.append({**entry, "result": "rejected",
                            "reason": f"AMZ 单号 {order_no} 已经挂在任务 {taken} 上了"})
            continue

        in_db = conn.execute(
            "SELECT status, amazon_order_no FROM procure.tasks WHERE line_key = %s", (key,)
        ).fetchone()
        dup = key in seen_keys or in_db is not None
        if dup:
            if external and in_db is not None:
                # 与真跑同一张迁移表 —— 这里只是不写。两处判据分叉的话,
                # 空跑说「会转 3 条」而真跑转了 5 条,那种空跑比没有空跑更坏。
                if in_db["status"] == "purchased" and in_db["amazon_order_no"] == order_no:
                    duplicated += 1
                    details.append({**entry, "result": "duplicated", "line_key": key})
                elif in_db["status"] in _MIGRATABLE:
                    migrated += 1
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
        inserted += 1
        details.append({**entry, "result": "inserted", "line_key": key,
                        **({"amazon_order_no": order_no} if external else {})})

    return {"inserted": inserted, "duplicated": duplicated, "rejected": rejected,
            "migrated": migrated, "conflicted": conflicted, "details": details}


def _why_not_migrated(t: dict[str, Any], amazon_order_no: str) -> str:
    """输入:库里那一行 + 上游填的单号 → 输出:「为什么没动」那句话。

    **只管措辞,不参与决定**(决定在 `_MIGRATABLE`)。真跑与空跑共用它 ——
    两套措辞的话,空跑说的和真跑说的对不上,而人是照空跑那份去核对的。
    """
    if t["status"] == "claimed":
        # 这张表里最要紧的一格:插件此刻正拿着这一单在亚马逊上下单。
        return (f"插件正在拍这单(claimed),上游却填了 AMZ 单号 {amazon_order_no} —— "
                f"这一单没动。请去买家号订单页看一眼到底买了几次")
    if t["status"] == "purchased":
        return (f"这一单已经是已拍单,库里的 AMZ 单号是 {t['amazon_order_no']},"
                f"上游填的是 {amazon_order_no} —— 两个号不一样,没动")
    return f"{t['status']} 的单不接外部单号({amazon_order_no})—— 没动"


def load_rows(path) -> list[dict[str, Any]]:
    """输入:JSON 文件路径 → 输出:采购行列表。

    文件形态是 [{...}, {...}] 或 {"rows": [...]}。
    上游 ERP 的真实接口还没接,先走文件投放 —— 形状与将来的接口一致,
    接上时换掉这个函数即可。
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["rows"] if isinstance(data, dict) else data
