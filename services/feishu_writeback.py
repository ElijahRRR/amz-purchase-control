"""把采购结果写回飞书那张表。

这一层做业务判断:哪几格该写、写成什么、什么时候值得写。
真正发请求在 api/feishu.py,取候选行在 services/task_source.py。

三条刻意的取舍:

**默认关着。** `refdata/feishu_fields.json` 里 `writeback.enabled` 不打开就不写。
往别人的表里写字是有副作用的动作,不该因为「代码里有这个功能」就默认发生。

**只写有结果的单。** pending / ready / claimed 还在路上。每次状态变化都往上游表里
写一次,只会把那张表刷得没法看,而且真正要紧的那次变化(拍成了/拍砸了)
会淹在一串「待拍单 → 拍单中 → 待拍单」里。

**内容没变就不写。** 拿要写的内容算个摘要存下来,下一轮一样就跳过。
不然每 10 分钟一轮,同一批单会被反复写,把飞书的编辑历史刷成一片
「机器人修改了此记录」,人再想看谁改过什么就看不见了。
"""

import hashlib
import json
from typing import Any

from services import error_codes, vocab

#: 可以回写的字段。左边是我们的键,右边由 refdata/feishu_fields.json 给出列名。
#: 不在这张表里的键会在加载映射时被拒绝 —— 写错一个键的表现是「那一列永远不更新」,
#: 而那种沉默的错要几个星期才有人发现。
WRITEBACK_KEYS = frozenset({
    "amazon_order_no",     # AMZ 单号
    "purchase_status",     # 采购状态(中文,与运营台一致)
    "error_label",         # 失败原因(中文;成功时写空)
    "purchased_at",        # 采购时间
    "actual_total",        # 实付总计
    "shipment_status",     # 物流状态(中文)
    "carrier",             # 物流商
    "tracking_no",         # 运单号
})


class WritebackDisabled(RuntimeError):
    """没开回写。不是错误,是配置 —— 调用方据此安静地跳过。"""


def load_config(mapping: dict[str, Any]) -> dict[str, str]:
    """输入:整份映射 → 输出:{我们的键: 飞书列名}。没开回写就抛 WritebackDisabled。"""
    wb = mapping.get("writeback") or {}
    if not wb.get("enabled"):
        raise WritebackDisabled(
            "回写没开。要开的话把 refdata/feishu_fields.json 里 writeback.enabled "
            "改成 true,并确认飞书应用有 bitable:app 写权限")

    fields = {k: v for k, v in (wb.get("fields") or {}).items() if v}
    unknown = set(fields) - WRITEBACK_KEYS
    if unknown:
        # 写错一个键的表现是「那一列永远不更新」—— 沉默的错要几个星期才有人发现。
        raise ValueError(f"writeback.fields 里有不认识的键:{sorted(unknown)};"
                         f"可用的是 {sorted(WRITEBACK_KEYS)}")
    if not fields:
        raise WritebackDisabled("回写开着,但 writeback.fields 一列都没配")
    return fields


def _money(v: Any) -> str:
    """金额转字符串。Decimal 直接进 JSON 会炸,而 float 会掉精度。"""
    return "" if v is None else str(v)


def build(row: dict[str, Any], fields: dict[str, str]) -> dict[str, Any]:
    """输入:一条候选(task_source join task)+ 列名映射 → 输出:要写进飞书的 fields。

    中文标签取自 services/vocab —— 与运营台**同一个来源**。
    上游在飞书里看到「已拍单」,运营在控制台看到的也是「已拍单」;
    两边各写一份的话,迟早一边说「已拍单」一边说「采购成功」,
    然后有人开始怀疑这是不是两回事。
    """
    values: dict[str, Any] = {
        "amazon_order_no": row.get("amazon_order_no") or "",
        "purchase_status": vocab.STATUS_LABELS.get(row["status"], row["status"]),
        "error_label": (error_codes.LABELS.get(row["error_code"], row["error_code"])
                        if row.get("error_code") else ""),
        # 日期用 ISO 字符串,不用毫秒时间戳:飞书的「日期」列要时间戳,
        # 「文本」列要字符串,而我们不知道上游那一列是什么类型。
        # 写字符串进日期列会被飞书拒绝并明确报错,写时间戳进文本列则会
        # **静默存成一串数字** —— 宁可要那个会报错的。
        "purchased_at": (row["purchased_at"].strftime("%Y-%m-%d %H:%M:%S")
                         if row.get("purchased_at") else ""),
        "actual_total": _money(row.get("actual_total")),
        "shipment_status": (vocab.SHIPMENT_LABELS.get(row["shipment_status"],
                                                      row["shipment_status"])
                            if row.get("shipment_status") else ""),
        "carrier": row.get("carrier") or "",
        "tracking_no": row.get("tracking_no") or "",
    }
    return {fields[k]: values[k] for k in fields}


def digest(payload: dict[str, Any]) -> str:
    """输入:要写的内容 → 输出:摘要。一样就不用再写一次。

    每 10 分钟一轮的话,不比对会把飞书的编辑历史刷成一片
    「机器人修改了此记录」,人再想看谁改过什么就看不见了。
    """
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def plan(rows: list[dict[str, Any]], fields: dict[str, str]) -> dict[str, Any]:
    """输入:候选行 → 输出:{updates, skipped}。

    `updates` 是 [{record_id, fields, _source_id, _hash}],直接喂 api 的 batch_update。
    `skipped` 是内容没变、这一轮不用写的。
    """
    updates, skipped = [], 0
    for row in rows:
        payload = build(row, fields)
        h = digest(payload)
        if h == row.get("pushed_hash"):
            skipped += 1
            continue
        updates.append({"record_id": row["external_id"], "fields": payload,
                        "_source_id": row["id"], "_hash": h,
                        "_upstream": row["upstream_order_no"]})
    return {"updates": updates, "skipped": skipped}
