"""任务事件流写入(只追加)。

替代厂商系统那一个 failContent 自由文本字段:每一步、每次拦截、每次失败都留痕,
后台按 task_id 展开就是这条任务的完整时间线。
"""

import json
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from services.error_codes import validate as validate_code

INSERT_SQL = """
INSERT INTO procure.task_events (task_id, instance_id, kind, code, payload)
VALUES (%(task_id)s, %(instance_id)s, %(kind)s, %(code)s, %(payload)s)
RETURNING id
"""

KINDS = frozenset(
    {"claimed", "step", "guard_block", "error", "purchased", "released", "assert_failed",
     # 人在后台动的手。和插件跑出来的结果落在同一条时间线上,但必须分得开 ——
     # 「这个单号是机器读的还是人填的」在事后追责时是第一个要问的问题。
     "admin"}
)


def record(
    conn,
    task_id: int,
    kind: str,
    *,
    instance_id: int | None = None,
    code: str | None = None,
    payload: dict[str, Any] | None = None,
) -> int:
    """输入:连接 + 任务 id + 事件类型(+实例/错误码/载荷)→ 输出:事件 id。

    kind 必须在 KINDS 封闭集内;error / guard_block 必须带 code —— 这两条是
    「失败必须机器可读」的落地点,厂商系统 18 处失败全是 status=99 加自由文本,
    服务端没法按原因分类统计。
    """
    if kind not in KINDS:
        raise ValueError(f"未知事件类型 {kind!r},允许值:{sorted(KINDS)}")
    if kind in ("error", "guard_block") and not code:
        raise ValueError(f"{kind} 事件必须带 code")
    if code is not None:
        # CLAUDE.md 说错误码是封闭集 —— 在这里才真正成立。
        # 在此之前只校验了 kind,插件传什么码就写什么码。
        validate_code(code)
    row = conn.execute(
        INSERT_SQL,
        {
            "task_id": task_id,
            "instance_id": instance_id,
            "kind": kind,
            "code": code,
            "payload": json.dumps(payload or {}, ensure_ascii=False, default=_jsonable),
        },
    ).fetchone()
    return row["id"]


def _jsonable(value: Any) -> str:
    """输入:json 不认识的对象 → 输出:字符串表示。

    事件载荷是任意 JSON,而业务里到处是 Decimal(金额)和 date(交期)。
    不在这里兜住,调用方就得在每个 record() 前手动 str() 一遍 —— 那种约定迟早漏。
    """
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return str(value)
