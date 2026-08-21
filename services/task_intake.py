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
from decimal import Decimal, InvalidOperation
from typing import Any

MARKETPLACES = frozenset({"US"})     # 首期只做 US


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
  (line_key, upstream_order_no, buyer_env_id, marketplace, status,
   ship_name, ship_phone, ship_line1, ship_city, ship_state, ship_postcode, ship_country,
   price_cap, max_delivery_days)
VALUES
  (%(line_key)s, %(upstream_order_no)s, %(env_id)s, %(marketplace)s, %(status)s,
   %(ship_name)s, %(ship_phone)s, %(ship_line1)s, %(ship_city)s, %(ship_state)s,
   %(ship_postcode)s, %(ship_country)s, %(price_cap)s, %(max_delivery_days)s)
ON CONFLICT (line_key) DO NOTHING
RETURNING id
"""


def _validate(row: dict[str, Any]) -> str | None:
    """输入:一行 → 输出:拒收理由;通过返回 None。"""
    for field in _REQUIRED:
        if not str(row.get(field) or "").strip():
            return f"缺字段 {field}"

    marketplace = (row.get("marketplace") or "US").upper()
    if marketplace not in MARKETPLACES:
        return f"首期只做 {'/'.join(sorted(MARKETPLACES))},收到 {marketplace}"

    try:
        cap = Decimal(str(row["price_cap"]))
    except (InvalidOperation, ValueError, TypeError):
        return f"price_cap 不是数字:{row['price_cap']!r}"
    if cap <= 0:
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


def ingest(conn, rows: list[dict[str, Any]], *, release: bool = False) -> dict[str, Any]:
    """输入:上游采购行 → 输出:{inserted, duplicated, rejected, details}。

    release=True 直接落成 ready(可被认领);默认落成 pending(等放行)。

    **每一行的去向都会出现在 details 里**,不存在被静默丢掉的行。
    厂商那套导入回一句「导入成功」就完了,少了几行没人知道。
    """
    env_ids: dict[str, int] = {}
    details: list[dict[str, Any]] = []
    inserted = duplicated = rejected = 0

    for idx, row in enumerate(rows):
        reason = _validate(row)
        if reason:
            rejected += 1
            details.append({"index": idx, "upstream_order_no": row.get("upstream_order_no"),
                            "result": "rejected", "reason": reason})
            continue

        code = row["buyer_env_code"]
        if code not in env_ids:
            got = conn.execute(
                "SELECT id FROM procure.buyer_envs WHERE code = %s", (code,)
            ).fetchone()
            if got is None:
                rejected += 1
                details.append({"index": idx, "upstream_order_no": row["upstream_order_no"],
                                "result": "rejected", "reason": f"买家号 {code} 不存在"})
                continue
            env_ids[code] = got["id"]

        products = row["products"]
        key = line_key(row["upstream_order_no"], products)
        got = conn.execute(_INSERT, {
            "line_key": key,
            "upstream_order_no": row["upstream_order_no"],
            "env_id": env_ids[code],
            "marketplace": (row.get("marketplace") or "US").upper(),
            "status": "ready" if release else "pending",
            "ship_name": row["ship_name"], "ship_phone": row["ship_phone"],
            "ship_line1": row["ship_line1"], "ship_city": row["ship_city"],
            "ship_state": row["ship_state"], "ship_postcode": row["ship_postcode"],
            "ship_country": (row.get("ship_country") or "US").upper(),
            "price_cap": Decimal(str(row["price_cap"])),
            "max_delivery_days": int(row.get("max_delivery_days") or 7),
        }).fetchone()

        if got is None:
            duplicated += 1
            details.append({"index": idx, "upstream_order_no": row["upstream_order_no"],
                            "result": "duplicated", "line_key": key})
            continue

        task_id = got["id"]
        for p in products:
            conn.execute(
                """INSERT INTO procure.task_products (task_id, asin, quantity, image_url)
                   VALUES (%s, %s, %s, %s)""",
                (task_id, p["asin"].strip(), int(p["quantity"]), p.get("image_url")),
            )
        inserted += 1
        details.append({"index": idx, "upstream_order_no": row["upstream_order_no"],
                        "result": "inserted", "task_id": task_id, "line_key": key})

    return {"inserted": inserted, "duplicated": duplicated,
            "rejected": rejected, "details": details}


def dry_run(conn, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """输入:采购行 → 输出:与 ingest 同形状的预览,**不写库**。

    走的是与 ingest 完全相同的判定路径(字段校验、买家号存不存在、line_key 是否已落过),
    所以预览数字与真跑一致。只做字段校验的空跑会少报拒收,
    那种「预览与真跑对不上」的空跑比没有空跑更误导人。
    """
    details: list[dict[str, Any]] = []
    inserted = duplicated = rejected = 0
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
        dup = key in seen_keys or conn.execute(
            "SELECT 1 FROM procure.tasks WHERE line_key = %s", (key,)
        ).fetchone() is not None
        if dup:
            duplicated += 1
            details.append({**entry, "result": "duplicated", "line_key": key})
            continue
        seen_keys.add(key)      # 同一批里重复的行,第二次也是重复
        inserted += 1
        details.append({**entry, "result": "inserted", "line_key": key})

    return {"inserted": inserted, "duplicated": duplicated,
            "rejected": rejected, "details": details}


def load_rows(path) -> list[dict[str, Any]]:
    """输入:JSON 文件路径 → 输出:采购行列表。

    文件形态是 [{...}, {...}] 或 {"rows": [...]}。
    上游 ERP 的真实接口还没接,先走文件投放 —— 形状与将来的接口一致,
    接上时换掉这个函数即可。
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["rows"] if isinstance(data, dict) else data
