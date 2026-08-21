"""飞书多维表格的记录 → 落库用的采购行。

这一层做的是**业务判断**(铁律 2:api 层不写业务判断,那些都在这里):
哪一列是限价、一行是一个商品还是一整张订单、什么样的行该拒收、
多行怎么合并成一张任务。

最要紧的一条是**合并**:

    一条 task = 一张上游订单 = **一次 Amazon 下单**

飞书里通常是「一行一个商品」,同一个上游单号占好几行。如果照单全收地
一行落一条任务,同一张上游订单就会变成 N 条任务,插件会在 Amazon 上
**买 N 次**。line_key 拦不住 —— 它是 sha256(上游单号|商品集合),
每行的商品集合都不一样,算出来就是 N 个不同的键,每一个都是「新行」。

所以合并不是优化,是正确性。默认按 upstream_order_no 合并,
而且这个默认是刻意选的:猜错的代价不对称。
  · 真是「一行一个商品」却不合并 → 重复下单
  · 真是「一行一整单」却去合并   → 每组只有一行,合并等于没合并,无害
"""

import json
import re
from pathlib import Path
from typing import Any

from registry import settings

#: 表里可以没有这两列,缺了用默认值。其余都必填。
_OPTIONAL = ("max_delivery_days", "marketplace")

#: 我们需要的列。asin / quantity 单独处理(它们决定商品行)。
_ROW_FIELDS = ("upstream_order_no", "buyer_env_code", "price_cap",
               "ship_name", "ship_phone", "ship_line1",
               "ship_city", "ship_state", "ship_postcode",
               "max_delivery_days", "marketplace")


class MappingError(RuntimeError):
    """映射文件本身有问题 —— 这不是某一行的错,是配置的错,整轮同步都别跑。"""


def load_mapping(path: str | Path | None = None) -> dict[str, Any]:
    """输入:映射文件路径 → 输出:{fields, row_is, take_when}。

    映射文件缺列、写错模式,在这里就抛 —— 拿着一份错映射去跑同步,
    结果是「全表 300 行全部拒收:缺字段 upstream_order_no」,
    看的人第一反应会是上游把表填坏了,而不是我们的映射写错了。
    """
    p = Path(path or settings.feishu_field_map_path())
    if not p.exists():
        raise MappingError(f"找不到列名映射文件:{p}")
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise MappingError(f"列名映射文件不是合法 JSON({p}):{exc}") from exc

    fields = raw.get("fields") or {}
    missing = [f for f in (*_ROW_FIELDS, "asin", "quantity")
               if f not in _OPTIONAL and not fields.get(f)]
    if missing:
        raise MappingError(f"映射文件里这些字段没给列名:{missing}")

    row_is = raw.get("_一行是什么", "product")
    if row_is not in ("product", "order"):
        raise MappingError(f"_一行是什么 只能是 product / order,收到 {row_is!r}")

    take = raw.get("take_when") or {}
    return {
        "fields": fields,
        "row_is": row_is,
        "take_column": (take.get("column") or "").strip(),
        "take_equals": [str(v) for v in (take.get("equals") or [])],
        # 原样带上,由 services/feishu_writeback 自己解释 ——
        # 拉单这一层不需要知道回写写哪几列。
        "writeback": raw.get("writeback") or {},
    }


def _text(value: Any) -> str:
    """输入:摊平后的一格 → 输出:去掉首尾空白的字符串。

    列表取第一个:人员列、单选被存成多选时都会是列表。取第一个而不是拼起来 ——
    「收件人」那一格里两个名字,拼成「张三李四」会真的按这个名字寄出去。
    """
    if value is None:
        return ""
    if isinstance(value, list):
        value = value[0] if value else ""
    if isinstance(value, bool):
        return "是" if value else ""
    if isinstance(value, float) and value.is_integer():
        # 飞书的数字列一律回 float。邮编 92707 变成 "92707.0" 会让地址填错。
        return str(int(value))
    return str(value).strip()


def _split_multi(value: Any) -> list[str]:
    """输入:一格 → 输出:拆开的多个值(「一行一整单」模式下 ASIN/数量列用)。"""
    if isinstance(value, list):
        return [_text(v) for v in value if _text(v)]
    text = _text(value)
    if not text:
        return []
    # **一次切掉所有分隔符,不是「找到第一个就按它切」。**
    #
    # 人手填的格子里混用分隔符是常态:"B0AAA, B0BBB;B0CCC"。
    # 只按第一个分隔符切,会切出 "B0BBB;B0CCC" 这么一个东西 ——
    # 它长得像个 ASIN,会被原样当成 ASIN 拿去亚马逊搜,而不是被拒收。
    # 「被拒收」还有人看得见,「搜了个不存在的 ASIN」只会变成一条 OUT_OF_STOCK。
    return [t.strip() for t in re.split(r"[,,;;、|\n\r\t]+", text) if t.strip()]


def to_rows(records: list[dict[str, Any]], mapping: dict[str, Any]) -> dict[str, Any]:
    """输入:飞书记录 + 映射 → 输出:{rows, skipped, groups}。

    `rows` 直接喂 services/task_intake.ingest —— 形状与文件投放那条路完全一致,
    所以两条入口共用同一套校验、去重、拒收明细。

    `skipped` 是**被 take_when 滤掉的**,不是被拒收的。两者在摘要里要分开说:
    「没轮到它」和「它有问题」是两回事,混在一起会让人去查一批其实没毛病的行。
    """
    f = mapping["fields"]
    col = lambda rec, key: rec["fields"].get(f.get(key, ""))     # noqa: E731

    take_col, take_eq = mapping["take_column"], mapping["take_equals"]
    skipped: list[dict[str, Any]] = []
    groups: dict[str, dict[str, Any]] = {}

    for rec in records:
        if take_col and take_eq:
            got = _text(rec["fields"].get(take_col))
            if got not in take_eq:
                skipped.append({"record_id": rec.get("record_id"), "value": got})
                continue

        order_no = _text(col(rec, "upstream_order_no"))
        if not order_no:
            # 没有单号就没法合并,也没法追溯。给一个稳定的假键,让它照常走到
            # ingest 那一层被拒收并逐条报出来 —— 在这里静默丢掉的话,
            # 上游会以为这一行同步了。
            order_no = f"(无单号·record {rec.get('record_id')})"

        products = _products(rec, mapping)

        if order_no in groups:
            # 同一张上游订单的第二行:只并商品,其余字段以第一行为准。
            # 后面几行的地址/限价与第一行不一致时不静默覆盖,而是记下来 ——
            # 那说明上游把两张不同的单填成了同一个单号,是要人去看的。
            g = groups[order_no]
            g["products"].extend(products)
            # **后面几行的 record_id 也要收进来。**
            # 漏了的话,回写只会写这张单的第一行 —— 上游在表里看到的是
            # 「第一个商品有单号,其余几个还没动静」,而它们本来就是同一次下单。
            g["record_ids"].append(rec.get("record_id"))
            for key in ("buyer_env_code", "price_cap", "ship_name", "ship_phone",
                        "ship_line1", "ship_city", "ship_state", "ship_postcode"):
                now = _text(col(rec, key))
                if now and now != g["row"].get(key):
                    g["conflicts"].append({"field": key, "first": g["row"].get(key),
                                           "later": now,
                                           "record_id": rec.get("record_id")})
            continue

        row: dict[str, Any] = {"upstream_order_no": order_no}
        for key in _ROW_FIELDS:
            if key == "upstream_order_no":
                continue
            row[key] = _text(col(rec, key))

        row["marketplace"] = row.get("marketplace") or "US"
        row["max_delivery_days"] = row.get("max_delivery_days") or "7"
        row["products"] = products
        groups[order_no] = {"row": row, "products": products,
                            "record_ids": [rec.get("record_id")], "conflicts": []}
        continue

    for order_no, g in groups.items():
        g["row"]["products"] = g["products"]

    return {
        "rows": [g["row"] for g in groups.values()],
        "skipped": skipped,
        "groups": groups,
        "conflicts": [c for g in groups.values() for c in g["conflicts"]],
    }


def _products(rec: dict[str, Any], mapping: dict[str, Any]) -> list[dict[str, Any]]:
    """输入:一条飞书记录 → 输出:这一行贡献的商品行。"""
    f = mapping["fields"]
    asin_raw = rec["fields"].get(f["asin"])
    qty_raw = rec["fields"].get(f["quantity"])

    if mapping["row_is"] == "order":
        asins = _split_multi(asin_raw)
        qtys = _split_multi(qty_raw)
        out = []
        for i, asin in enumerate(asins):
            # 数量列只给一个值时,认为所有 ASIN 都是这个数量;
            # 给了多个就按位置对应。对不上的交给 ingest 去拒收并报出来。
            qty = qtys[i] if i < len(qtys) else (qtys[0] if len(qtys) == 1 else "")
            out.append({"asin": asin, "quantity": qty})
        return out

    asin = _text(asin_raw)
    return [{"asin": asin, "quantity": _text(qty_raw)}] if asin else []
