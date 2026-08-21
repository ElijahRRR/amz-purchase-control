"""运营台的读写接口。

铁律 1:这里只做请求校验 + 调 services,不写业务判断。
「哪些状态允许重置」「强制回填要不要说明」这类判断在 services/task_admin.py。

不做鉴权(所有者定稿),服务默认只监听 127.0.0.1。
"""

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from registry import settings
from server import schemas
from server.deps import conn_ctx
from services import instance, task_admin, task_query

router = APIRouter(prefix="/v1/admin", tags=["admin"])


def _refused(exc: task_admin.AdminRefused) -> JSONResponse:
    """拒绝一律走这个出口。

    用 JSONResponse 而不是 raise:虽然这些拒绝都发生在写库之前、抛异常是安全的,
    但「路由里不 raise」当成无条件的习惯更省心 —— 哪天有人在拒绝判定前加了一次写,
    不会因为忘了改出口而把那次写静默回滚掉(见 CLAUDE.md)。
    """
    status = 404 if exc.code == "TASK_NOT_FOUND" else 409
    return JSONResponse(status_code=status, content={
        "ok": False, "data": None,
        "error": {"code": exc.code, "message": exc.message},
    })


@router.post("/tasks/search")
def search(req: schemas.TaskSearchReq, conn=Depends(conn_ctx)) -> schemas.Envelope:
    got = task_query.search(
        conn, status=req.status, env_code=req.env_code, date_field=req.date_field,
        date_from=req.date_from, date_to=req.date_to,
        order_numbers=req.order_numbers, asin=req.asin,
        page=req.page, page_size=req.page_size,
    )
    return schemas.Envelope(ok=True, data=got)


@router.get("/tasks/{task_id}")
def detail(task_id: int, conn=Depends(conn_ctx)):
    got = task_query.detail(conn, task_id)
    if got is None:
        return _refused(task_admin.AdminRefused("TASK_NOT_FOUND", f"任务 {task_id} 不存在"))
    return schemas.Envelope(ok=True, data=got)


@router.get("/instances")
def instances(conn=Depends(conn_ctx)) -> schemas.Envelope:
    rows = instance.list_with_liveness(conn, stale_seconds=settings.heartbeat_stale_seconds())
    return schemas.Envelope(ok=True, data={
        "stale_seconds": settings.heartbeat_stale_seconds(),
        "items": rows,
    })


@router.post("/tasks/{task_id}/reset")
def reset(task_id: int, req: schemas.ResetReq, conn=Depends(conn_ctx)):
    try:
        got = task_admin.reset_to_queue(conn, task_id, acknowledged=req.acknowledged,
                                        operator=req.operator)
    except task_admin.AdminRefused as exc:
        return _refused(exc)
    return schemas.Envelope(ok=True, data=got)


@router.post("/tasks/{task_id}/force-backfill")
def force_backfill(task_id: int, req: schemas.ForceBackfillReq, conn=Depends(conn_ctx)):
    try:
        got = task_admin.force_backfill(conn, task_id, req.amazon_order_no,
                                        note=req.note, operator=req.operator)
    except task_admin.AdminRefused as exc:
        return _refused(exc)
    return schemas.Envelope(ok=True, data=got)


@router.post("/tasks/{task_id}/address")
def address(task_id: int, req: schemas.AddressReq, conn=Depends(conn_ctx)):
    fields = {k: v for k, v in req.model_dump(exclude={"operator"}).items() if v is not None}
    try:
        got = task_admin.update_address(conn, task_id, fields, operator=req.operator)
    except task_admin.AdminRefused as exc:
        return _refused(exc)
    return schemas.Envelope(ok=True, data=got)


@router.post("/tasks/{task_id}/asin")
def asin(task_id: int, req: schemas.AsinReq, conn=Depends(conn_ctx)):
    try:
        got = task_admin.update_asin(conn, task_id, req.old_asin, req.new_asin,
                                     operator=req.operator)
    except task_admin.AdminRefused as exc:
        return _refused(exc)
    return schemas.Envelope(ok=True, data=got)
