"""定时从飞书多维表格拉取上游订单,落进 procure.tasks。

    python cli.py feishu_sync --dry-run          # 先看这一轮会动到谁
    python cli.py feishu_sync                    # 落成 pending,等人放行
    python cli.py feishu_sync -p release=1       # 落库即放行

与文件投放那条路(task_intake)共用 services/task_intake.ingest ——
校验、去重、拒收明细完全一致。这里只负责「把飞书的记录变成那批行」。

**每轮全量拉,不做增量游标。** 理由:
  · 去重靠 line_key,已经落过的行照样会被识别成重复,不会重复下单
  · 游标一旦跑到某一行前面,那一行**永远不会再被看见** —— 而它可能只是
    当时缺了个字段被拒收,上游补好了也没人再来拉它
  · 一张派单表通常几千行,全量拉一次是几百毫秒的事
换来的是这条链**幂等且自愈**:任何一轮失败,下一轮自己补回来。
"""

from api import feishu
from registry import db, settings
from services import feishu_intake, task_intake, task_source


def _fetch(mapping: dict) -> tuple[list[dict], dict]:
    """输入:映射 → 输出:(飞书记录, 映射结果)。"""
    app_token = settings.feishu_app_token()
    table_id = settings.feishu_table_id()
    if not app_token or not table_id:
        raise ValueError(
            "没配 AMZ_FEISHU_APP_TOKEN / AMZ_FEISHU_TABLE_ID。"
            "表格 URL 形如 https://xxx.feishu.cn/base/<app_token>?table=<table_id>")

    client = feishu.Client()
    records = list(client.iter_records(app_token, table_id,
                                       view_id=settings.feishu_view_id()))
    return records, feishu_intake.to_rows(records, mapping)


def _tail(mapped: dict, records: list[dict]) -> str:
    """输入:映射结果 → 输出:摘要里「拉了多少、滤掉多少、有没有打架」那几行。"""
    lines = [f"  飞书读到 {len(records)} 条记录 → 合并成 {len(mapped['rows'])} 张订单"]
    if mapped["skipped"]:
        # 「没轮到它」与「它有问题」分开说 —— 混在一起会让人去查一批其实没毛病的行。
        lines.append(f"  按 take_when 滤掉 {len(mapped['skipped'])} 条(不是拒收)")
    for c in mapped["conflicts"]:
        # 同一个上游单号的两行给了不同的地址/限价 —— 上游多半把两张单填成了
        # 同一个号。不静默取第一行了事,那会按错的地址寄出去。
        lines.append(f"  ⚠ 单号冲突 {c['field']}:先出现的是 {c['first']!r},"
                     f"后面那行是 {c['later']!r}(record {c['record_id']});"
                     f"已按先出现的落库,请去飞书核对")
    return "\n".join(lines)


def _link_sources(conn, got: dict, mapped: dict) -> int:
    """输入:落库结果 + 映射结果 → 输出:建立了几条「任务 ↔ 飞书行」对照。

    **新增和重复的都要建**。只给新增建的话,第一轮之后新加进来的那几行
    (上游给同一张单补了个商品)永远不会被对照上,回写时它们那几格空着 ——
    而上游看到的就是「这一单一半有单号一半没有」。

    重复行拿 line_key 回查 task_id:ingest 对重复行不返回 id,但返回 line_key,
    而 line_key 上有唯一索引。
    """
    total = 0
    for d in got["details"]:
        if d["result"] == "rejected":
            continue                      # 都没落库,没有 task 可对照
        task_id = d.get("task_id")
        if task_id is None:
            row = conn.execute("SELECT id FROM procure.tasks WHERE line_key = %s",
                               (d["line_key"],)).fetchone()
            if row is None:
                continue
            task_id = row["id"]
        group = mapped["groups"].get(d["upstream_order_no"])
        if not group:
            continue
        total += task_source.link(conn, task_id, group["record_ids"])
    return total


def run(params: dict) -> str:
    """输入:params(release / dry_run 可选)→ 输出:结果摘要。"""
    mapping = feishu_intake.load_mapping()
    records, mapped = _fetch(mapping)
    rows = mapped["rows"]
    release = bool(params.get("release"))

    if not rows:
        return "这一轮没有可落库的订单\n" + _tail(mapped, records)

    if params.get("dry_run"):
        # 空跑同样**要读库** —— 买家号存不存在、这一行是不是已经落过,
        # 都得查过才算数。只做字段校验的空跑会少报拒收行数,
        # 那种「预览与真跑不一致」的空跑比没有空跑更误导人。
        with db.pg_conn() as conn:
            preview = task_intake.dry_run(conn, rows)
        head = (f"dry-run:{len(rows)} 张订单 → 将新增 {preview['inserted']},"
                f"重复 {preview['duplicated']},拒收 {preview['rejected']}"
                f",落成 {'ready' if release else 'pending'}")
        notes = [f"    #{d['index']} {d['upstream_order_no']}: "
                 + (d.get("reason") or "已在库中")
                 for d in preview["details"] if d["result"] != "inserted"]
        return (head + "\n" + _tail(mapped, records)
                + ("\n  明细:\n" + "\n".join(notes) if notes else ""))

    with db.pg_conn() as conn:
        got = task_intake.ingest(conn, rows, release=release)
        linked = _link_sources(conn, got, mapped)

    summary = (f"同步完成:新增 {got['inserted']},重复 {got['duplicated']},"
               f"拒收 {got['rejected']}(共 {len(rows)} 张订单)")
    summary += "\n" + _tail(mapped, records)
    summary += f"\n  对照上游行 {linked} 条(回写要靠它找到飞书里是哪几行)"
    bad = [d for d in got["details"] if d["result"] == "rejected"]
    if bad:
        # 拒收的必须逐条说出来。回一句「同步成功」就完了的话,少了几行没人知道。
        summary += "\n  拒收明细:"
        for d in bad:
            summary += f"\n    #{d['index']} {d['upstream_order_no']}: {d['reason']}"
    return summary
