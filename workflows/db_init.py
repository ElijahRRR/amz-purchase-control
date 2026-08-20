"""建库/升级:执行 refdata/schema.sql(幂等)。

改表流程:先改 docs/db_schema.md → 同步 refdata/schema.sql → 跑本工作流。
"""

from registry import db, paths


def run(params: dict) -> str:
    """输入:params(不接受参数)→ 输出:结果摘要字符串。"""
    sql_path = paths.repo_root() / "refdata" / "schema.sql"
    sql = sql_path.read_text(encoding="utf-8")
    if params.get("dry_run"):
        return f"dry-run:将执行 {sql_path}({len(sql)} 字符),未连接数据库"
    with db.pg_conn() as conn:
        conn.execute(sql)
        rows = conn.execute(
            """
            SELECT table_schema || '.' || table_name AS name
              FROM information_schema.tables
             WHERE table_schema IN ('procure','logistics','ops')
             ORDER BY 1
            """
        ).fetchall()
    return f"建库完成,共 {len(rows)} 张表:" + ", ".join(r["name"] for r in rows)
