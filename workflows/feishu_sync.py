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
from services import feishu_intake, task_intake


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

    summary = (f"同步完成:新增 {got['inserted']},重复 {got['duplicated']},"
               f"拒收 {got['rejected']}(共 {len(rows)} 张订单)")
    summary += "\n" + _tail(mapped, records)
    bad = [d for d in got["details"] if d["result"] == "rejected"]
    if bad:
        # 拒收的必须逐条说出来。回一句「同步成功」就完了的话,少了几行没人知道。
        summary += "\n  拒收明细:"
        for d in bad:
            summary += f"\n    #{d['index']} {d['upstream_order_no']}: {d['reason']}"
    return summary
