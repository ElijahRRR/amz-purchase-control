"""任务落库:把上游投放的采购行读进 procure.tasks。

    python cli.py task_intake --dry-run --file /path/to/rows.json
    python cli.py task_intake --file /path/to/rows.json --release

上游 ERP 的真实接口还没接,先走文件投放。文件形状与将来接口的请求体一致
(见 server/schemas.IntakeReq),接上时把 load_rows 换掉即可,
services/task_intake.ingest 这一层不用动。
"""

from pathlib import Path

from registry import db
from services import task_intake


def run(params: dict) -> str:
    """输入:params(file 必填;release/dry_run 可选)→ 输出:结果摘要。"""
    raw = params.get("file")
    if not raw:
        raise ValueError("task_intake 需要 --file 指向采购行 JSON")
    path = Path(raw).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"找不到投放文件:{path}")

    rows = task_intake.load_rows(path)
    release = bool(params.get("release"))

    if params.get("dry_run"):
        # 空跑不写库,但**要读库** —— 买家号存不存在、这一行是不是已经落过,
        # 都得查过才算数。一个只做字段校验的空跑会少报拒收行数,
        # 那种「预览与真跑不一致」的空跑比没有空跑更误导人。
        with db.pg_conn() as conn:
            preview = task_intake.dry_run(conn, rows)
        head = (f"dry-run:{len(rows)} 行 → 将新增 {preview['inserted']},"
                f"重复 {preview['duplicated']},拒收 {preview['rejected']}"
                f",落成 {'ready' if release else 'pending'}")
        notes = [f"    #{d['index']} {d['upstream_order_no']}: "
                 + (d.get("reason") or "已在库中")
                 for d in preview["details"] if d["result"] != "inserted"]
        return head + ("\n  明细:\n" + "\n".join(notes) if notes else "")

    with db.pg_conn() as conn:
        got = task_intake.ingest(conn, rows, release=release)

    summary = (f"落库完成:新增 {got['inserted']},重复 {got['duplicated']},"
               f"拒收 {got['rejected']}(共 {len(rows)} 行)")
    bad = [d for d in got["details"] if d["result"] == "rejected"]
    if bad:
        # 拒收的必须逐条说出来。厂商那套导入回一句「导入成功」就完了,
        # 少了几行没人知道。
        summary += "\n  拒收明细:"
        for d in bad:
            summary += f"\n    #{d['index']} {d['upstream_order_no']}: {d['reason']}"
    return summary
