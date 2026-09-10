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
        # 摘要与明细的拼装**与 feishu_sync 共用一份**(services/task_intake)。
        # 两份副本的下场刚发生过:加了「转外部下单/外部单号对不上」两个计数之后
        # 只改了飞书那一边,这条文件入口的摘要三个数全是 0、一句话都没有。
        head = task_intake.summarize(
            preview, total=len(rows), unit="行", dry_run=True,
            tail=f",落成 {'ready' if release else 'pending'}"
                 f"(带 AMZ 单号的那几行不受这个影响,一律落成已拍单)")
        notes = [f"    #{d['index']} {d['upstream_order_no']}: "
                 + task_intake.preview_note(d)
                 for d in preview["details"] if d["result"] != "inserted"]
        return head + ("\n  明细:\n" + "\n".join(notes) if notes else "")

    with db.pg_conn() as conn:
        got = task_intake.ingest(conn, rows, release=release)

    return (task_intake.summarize(got, total=len(rows), unit="行", verb="落库完成")
            + task_intake.explain_rows(got))
