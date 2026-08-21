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


def test_docs_layout_lists_every_service_and_workflow():
    """docs/01 §目录树 与真实文件必须**双向**对得上。

    这条测试的由来:那张目录树里曾经写着 workflows/erp_sync.py、workflows/reconcile.py、
    api/erp.py —— 三个都不存在。文档描述一个不存在的目录结构,
    比不写目录结构更糟:照着它去找文件的人会以为自己漏看了什么。

    2026-08-21 发现它自己也是「看起来在盯、其实盯不住」的一例,两处:
      · 只断言了「文件有、文档没提」,**没查反方向** —— 恰恰抓不住上面那次事故
      · 抓 `services/` 下的文件名时用的正则不分节,把整棵树里所有 `*.py`
        都算成了「services 一节列出的」。于是那个方向的断言是个超集比较,
        永远成立。
    """
    from registry import paths

    root = paths.repo_root()
    doc = (root / "docs" / "01-系统设计.md").read_text(encoding="utf-8")
    tree = doc[doc.index("amz-purchase-control/"):]
    tree = tree[:tree.index("```")]

    def files_under(pkg: str) -> set[str]:
        """目录树里 `pkg/` 那一节下面直接列出的 *.py。

        按缩进切节:从 `  pkg/` 那一行往下,收所有缩进更深的行,
        遇到缩进回到同级或更浅就停。不这么切的话就是在全树里瞎抓。
        """
        lines = tree.splitlines()
        head = next(i for i, ln in enumerate(lines)
                    if ln.strip() == f"{pkg}/" or ln.strip().startswith(f"{pkg}/ "))
        base = len(lines[head]) - len(lines[head].lstrip())
        out: set[str] = set()
        for ln in lines[head + 1:]:
            if not ln.strip():
                continue
            if len(ln) - len(ln.lstrip()) <= base:
                break
            name = ln.split()[0]
            if name.endswith(".py"):
                out.add(name)
        return out

    for pkg in ("services", "workflows"):
        real = {f.name for f in (root / pkg).glob("*.py") if f.name != "__init__.py"}
        listed = files_under(pkg)
        assert not (real - listed), f"{pkg}/ 里有文档没提的文件:{sorted(real - listed)}"
        assert not (listed - real), \
            f"文档里写着但 {pkg}/ 下不存在的文件:{sorted(listed - real)}"


def test_event_kinds_have_exactly_one_definition_per_place_and_they_agree():
    """事件类型有三份,得对得上。

    ① services/task_event.KINDS —— 写入时校验用的封闭集
    ② services/vocab.EVENT_LABELS / EVENT_TONE —— 界面词汇
    ③ web/src/types.ts 的 TaskEvent["kind"] —— 前端类型

    ①②之间少一个,界面上会冒出一个裸英文 kind;多一个,界面准备了一个
    永远不会出现的标签。③错了则是编译期承诺与运行时不符。
    这三份之前一份测试都没有 —— 而这个项目已经因为「两份副本悄悄分叉」栽过两次。
    """
    import re

    from registry import paths
    from services import task_event, vocab

    assert set(vocab.EVENT_LABELS) == set(task_event.KINDS), (
        f"只在 vocab:{sorted(set(vocab.EVENT_LABELS) - set(task_event.KINDS))};"
        f"只在 task_event:{sorted(set(task_event.KINDS) - set(vocab.EVENT_LABELS))}")
    assert set(vocab.EVENT_TONE) == set(vocab.EVENT_LABELS), "标签与色调对不上"

    src = (paths.repo_root() / "web" / "src" / "types.ts").read_text(encoding="utf-8")
    block = src[src.index("export interface TaskEvent"):src.index("export interface Shipment")]
    kinds_line = block[block.index("kind:"):block.index(";", block.index("kind:"))]
    assert set(re.findall(r'"(\w+)"', kinds_line)) == set(task_event.KINDS), \
        "web/src/types.ts 的 TaskEvent.kind 与服务端封闭集分叉了"


def test_shipment_and_task_status_labels_cover_the_closed_sets():
    """物流状态与任务状态的标签必须盖满各自的封闭集,不多不少。

    多一个 = 界面准备了一个永远不会出现的标签(读的人会以为库里有这个状态);
    少一个 = 界面上冒出一个裸英文枚举。两种都在给人制造错误的心智模型。
    """
    import re

    from registry import paths
    from services import vocab

    schema = (paths.repo_root() / "refdata" / "schema.sql").read_text(encoding="utf-8")
    line = next(ln for ln in schema.splitlines()
                if "not_shipped" in ln and "delivered" in ln)
    in_schema = set(re.findall(r"\b(not_shipped|in_transit|delivered|cancelled)\b", line))
    assert set(vocab.SHIPMENT_LABELS) == in_schema
    assert set(vocab.SHIPMENT_TONE) == in_schema


def test_extension_error_codes_match_the_server():
    """插件那份离线副本必须与服务端一字不差。

    它必须存在(断网时面板还要显示状态),所以这是唯一一份合理的副本 ——
    合理不等于安全,得有东西盯着。厂商那套「文档写 subTotal、插件发 subtotal」
    就是没人盯的下场。
    """
    import re

    from registry import paths
    from services import error_codes

    src = (paths.repo_root() / "extension" / "src" / "core" / "codes.ts").read_text(
        encoding="utf-8")

    block = src[src.index("export const ERROR_CODES = ["):src.index("] as const;")]
    in_ext = set(re.findall(r'"([A-Z_]+)"', block))
    assert in_ext == set(error_codes.ERROR_CODES), (
        f"只在插件里:{sorted(in_ext - set(error_codes.ERROR_CODES))};"
        f"只在服务端:{sorted(set(error_codes.ERROR_CODES) - in_ext)}")

    # 分组也要一致:一个码在服务端算「转人工」、在插件里算「可重试」,
    # 会让同一次失败在两边得到相反的处置
    to_manual_block = src[src.index("export const TO_MANUAL"):src.index("export function toManual")]
    assert set(re.findall(r'"([A-Z_]+)"', to_manual_block)) == set(error_codes.TO_MANUAL)

    retry_block = src[src.index("export const RETRYABLE"):src.index("export const TO_MANUAL")]
    assert set(re.findall(r'"([A-Z_]+)"', retry_block)) == set(error_codes.RETRYABLE)

    # **中文标签也要一字不差。**
    #
    # 这条断言是 2026-08-21 补的。在此之前这个测试只比码名和两个分组,
    # 而 19 个标签已经悄悄分叉了 10 个:「结算页跳转超时」/「结算页超时」、
    # 「无法确定哪个单号属于本单」/「单号对不上」……
    # 运营在插件面板和运营台上看到的是两套说法,同一个错误看着像两件事。
    #
    # 而 services/vocab.py 的注释一直写着「有测试盯着」—— 一条声称有测试盯着、
    # 实际没有的注释,比根本不写那句话更危险:后来的人会照着它放心地在一边改。
    label_block = src[src.index("ERROR_LABEL"):src.index("/** 可自动重试")]
    ext_labels = dict(re.findall(r'(\w+):\s*"([^"]+)"', label_block))
    drift = {k: (v, ext_labels.get(k)) for k, v in error_codes.LABELS.items()
             if ext_labels.get(k) != v}
    assert not drift, f"标签两边不一致(码: (服务端, 插件)):{drift}"
