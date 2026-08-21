"""路由公用依赖:连接、实例解析、统一错误。"""

from fastapi import HTTPException

from registry import db
from services import instance


def conn_ctx():
    """输入:无 → 输出:psycopg 连接上下文(FastAPI 依赖用)。"""
    with db.pg_conn() as c:
        yield c


def require_instance(conn, instance_uid: str) -> dict:
    """输入:连接 + 实例唯一号 → 输出:实例 dict;未注册则 404。"""
    row = instance.resolve(conn, instance_uid)
    if row is None:
        raise HTTPException(404, detail={"code": "INSTANCE_NOT_REGISTERED",
                                         "message": f"实例未注册:{instance_uid}"})
    return row


def require_task_owned(conn, task_id: int, inst: dict) -> dict:
    """输入:连接 + 任务 id + 实例 → 输出:任务 dict。

    校验的是「这条任务确实由该实例持有」——没有鉴权体系,但这条归属校验仍然要做:
    它防的不是攻击者,是插件把回传打到错误的 task_id 上。
    """
    row = conn.execute(
        "SELECT * FROM procure.tasks WHERE id = %s", (task_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(404, detail={"code": "TASK_NOT_FOUND",
                                         "message": f"任务不存在:{task_id}"})
    if row["status"] != "claimed" or row["claimed_by"] != inst["id"]:
        raise HTTPException(409, detail={
            "code": "TASK_NOT_HELD",
            "message": f"任务 {task_id} 当前状态 {row['status']},未被该实例持有",
        })
    return row
