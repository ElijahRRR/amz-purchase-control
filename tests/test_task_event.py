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
