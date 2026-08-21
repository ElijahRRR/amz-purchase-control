"""task_event 的封闭集校验:失败必须机器可读。"""

import pytest

from services import task_event


def test_rejects_unknown_kind(conn, seed):
    _, _, task_ids = seed
    with pytest.raises(ValueError, match="未知事件类型"):
        task_event.record(conn, task_ids[0], "whatever")


def test_error_requires_code(conn, seed):
    _, _, task_ids = seed
    with pytest.raises(ValueError, match="必须带 code"):
        task_event.record(conn, task_ids[0], "error")


def test_guard_block_requires_code(conn, seed):
    _, _, task_ids = seed
    with pytest.raises(ValueError, match="必须带 code"):
        task_event.record(conn, task_ids[0], "guard_block")


def test_payload_roundtrip(conn, seed):
    _, _, task_ids = seed
    task_event.record(conn, task_ids[0], "step", payload={"步骤": "加购", "asin": "B0X"})
    row = conn.execute(
        "SELECT payload FROM procure.task_events WHERE task_id=%s", (task_ids[0],)
    ).fetchone()
    assert row["payload"] == {"步骤": "加购", "asin": "B0X"}


def test_payload_accepts_decimal_and_date(conn, seed):
    """金额是 Decimal、交期是 date,事件载荷必须能直接吞下 —— 否则每个调用点
    都得手动 str() 一遍,那种约定迟早漏(这条是真跑出来的回归)。"""
    from datetime import date
    from decimal import Decimal

    from services import task_event

    _, _, task_ids = seed
    task_event.record(conn, task_ids[0], "purchased",
                      payload={"total": Decimal("10.79"), "eta": date(2026, 8, 27)})
    row = conn.execute(
        "SELECT payload FROM procure.task_events WHERE task_id=%s ORDER BY id DESC LIMIT 1",
        (task_ids[0],),
    ).fetchone()
    assert row["payload"] == {"total": "10.79", "eta": "2026-08-27"}
