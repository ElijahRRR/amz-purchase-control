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


# ── 错误码封闭集 ────────────────────────────────────────────────────────

def test_unknown_error_code_is_rejected(conn, seed):
    """封闭集必须真的封闭。

    在 2026-08-21 之前 task_event 只校验 kind、从没校验过 code —— 文档写着封闭集,
    实际插件传什么写什么。这类「看起来有护栏、实际防不住」比没有护栏更危险:
    读文档的人会照着这张表建统计和处置 SOP,而库里其实什么码都可能有。
    """
    import pytest

    from services import task_event

    _env_id, _inst_id, task_ids = seed
    with pytest.raises(ValueError, match="未知错误码"):
        task_event.record(conn, task_ids[0], "error", code="OUT_OF_STOK")


def test_known_error_code_passes(conn, seed):
    from services import task_event

    _env_id, _inst_id, task_ids = seed
    assert task_event.record(conn, task_ids[0], "error", code="OUT_OF_STOCK") > 0


def test_fail_rejects_unknown_code(conn, seed):
    import pytest

    from services import task_queue

    env_id, inst_id, _task_ids = seed
    task = task_queue.claim(conn, env_id, inst_id)
    with pytest.raises(ValueError, match="未知错误码"):
        task_queue.fail(conn, task["id"], "TOTALLY_MADE_UP")


def test_error_codes_table_matches_docs():
    """docs/01 §4 那张表与 services/error_codes.py 必须一字不差。

    两处副本是字段错位的温床 —— 厂商那套「文档写 subTotal、插件发 subtotal」
    就是这么来的。这条测试让副本至少不会悄悄分叉。
    """
    import re

    from registry import paths
    from services import error_codes

    doc = (paths.repo_root() / "docs" / "01-系统设计.md").read_text(encoding="utf-8")
    in_doc = set(re.findall(r"^\| `([A-Z_]+)` \|", doc, re.M))
    assert in_doc == set(error_codes.ERROR_CODES), (
        f"只在文档里:{sorted(in_doc - set(error_codes.ERROR_CODES))};"
        f"只在代码里:{sorted(set(error_codes.ERROR_CODES) - in_doc)}"
    )
