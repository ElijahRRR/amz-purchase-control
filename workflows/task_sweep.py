"""claimed 超时清扫:把「领走后再没消息」的任务转人工。

不退回 ready —— 插件可能已经在 Amazon 上真下了单,自动重试会造成重复下单。
"""

from registry import db, settings
from services import task_queue


def run(params: dict) -> str:
    """输入:params(可选 timeout_min 覆盖默认值)→ 输出:结果摘要。"""
    timeout = int(params.get("timeout_min") or settings.claim_timeout_minutes())
    if params.get("dry_run"):
        with db.pg_conn() as conn:
            rows = conn.execute(
                """
                SELECT id FROM procure.tasks
                 WHERE status = 'claimed'
                   AND claimed_at < now() - make_interval(mins => %(mins)s)
                """,
                {"mins": timeout},
            ).fetchall()
        return f"dry-run:{len(rows)} 条任务超过 {timeout} 分钟未回传,将转 manual"
    with db.pg_conn() as conn:
        ids = task_queue.sweep_stale(conn, timeout)
    return f"清扫完成:{len(ids)} 条超时任务转 manual" + (f" (id: {ids})" if ids else "")
