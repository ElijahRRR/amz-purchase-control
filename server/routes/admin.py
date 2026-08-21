"""运营台的读写接口。

铁律 1:这里只做请求校验 + 调 services,不写业务判断。
「哪些状态允许重置」「强制回填要不要说明」这类判断在 services/task_admin.py。

不做鉴权(所有者定稿),服务默认只监听 127.0.0.1。
"""

import csv
import io
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, StreamingResponse

from registry import settings
from server import schemas
from server.deps import conn_ctx
from services import (error_codes, instance, ops_query, task_admin, task_intake,
                      task_query, vocab)

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


def _bad_range(date_from: date | None, date_to: date | None) -> JSONResponse | None:
    """起止日期反了就明说,别返回一个空结果。

    反着传会让所有查询都返回 0 条,而「0 条」跟「这段时间确实没有单」长得一模一样。
    这个项目最怕的就是这种:界面给了一个看着正常的答案,而它回答的是另一个问题。
    """
    if date_from and date_to and date_from > date_to:
        return JSONResponse(status_code=422, content={
            "ok": False, "data": None,
            "error": {"code": "BAD_DATE_RANGE",
                      "message": f"起止日期反了:{date_from} 晚于 {date_to}"},
        })
    return None


@router.get("/meta")
def meta() -> schemas.Envelope:
    """封闭集连中文标签一起吐给前端,让前端不必存副本。

    这个项目已经因为「两份副本悄悄分叉」栽过两次。少一份就少一处会分叉的地方。
    """
    return schemas.Envelope(ok=True, data={
        "task_status": {"labels": vocab.STATUS_LABELS, "tone": vocab.STATUS_TONE},
        "shipment_status": {"labels": vocab.SHIPMENT_LABELS, "tone": vocab.SHIPMENT_TONE},
        "event_kind": {"labels": vocab.EVENT_LABELS, "tone": vocab.EVENT_TONE},
        "error_code": {
            "labels": error_codes.LABELS,
            "retryable": sorted(error_codes.RETRYABLE),
            "to_manual": sorted(error_codes.TO_MANUAL),
            "business_blocked": sorted(error_codes.BUSINESS_BLOCKED),
            "possibly_ordered": sorted(error_codes.POSSIBLY_ORDERED),
            # 界面文案要照事实写:这一位是 False 时不许说「系统自己会再试」
            "auto_retry_implemented": error_codes.AUTO_RETRY_IMPLEMENTED,
        },
    })


@router.get("/summary")
def summary(
    env_code: str | None = None,
    # Literal 而不是 str:传个 "updated" 进来,原先会一路走到
    # task_query.summary 里 raise ValueError → 500。500 的意思是「服务坏了」,
    # 而实际情况是「你传错了」—— 让 FastAPI 在门口回 422 说清楚是哪个字段。
    date_field: Literal["created", "purchased"] = "created",
    date_from: date | None = None,
    date_to: date | None = None,
    asin: str | None = None,
    conn=Depends(conn_ctx),
):
    """状态桶的计数。接的是与列表**同一套**条件(env / 时间 / ASIN),只是不接
    status —— 否则筛了之后那排数字还是全局的,点进去数量对不上,像是界面丢了单。"""
    if (bad := _bad_range(date_from, date_to)) is not None:
        return bad
    got = task_query.summary(conn, env_code=env_code, date_field=date_field,
                             date_from=date_from, date_to=date_to, asin=asin)
    return schemas.Envelope(ok=True, data=got)


@router.get("/error-stats")
def error_stats(
    date_from: date | None = None,
    date_to: date | None = None,
    conn=Depends(conn_ctx),
):
    """错误码分布。默认看最近 14 天 —— 够看出趋势,又不至于把一次早就修好的
    旧故障混进今天的判断里。"""
    if (bad := _bad_range(date_from, date_to)) is not None:
        return bad
    today = date.today()
    got = task_query.error_stats(conn,
                                 date_from=date_from or today - timedelta(days=13),
                                 date_to=date_to or today)
    return schemas.Envelope(ok=True, data=got)


@router.get("/runs")
def runs(limit: int = 60, conn=Depends(conn_ctx)) -> schemas.Envelope:
    """工作流运行记录。ops.runs 之前是只写不读的 —— 写了没人看等于没写,
    而 task_sweep 是全项目唯一必须挂定时的一条,它悄悄停了没人会知道。"""
    return schemas.Envelope(ok=True, data=ops_query.recent(conn, limit=limit))


@router.post("/tasks/search")
def search(req: schemas.TaskSearchReq, conn=Depends(conn_ctx)):
    if (bad := _bad_range(req.date_from, req.date_to)) is not None:
        return bad
    got = task_query.search(
        conn, status=req.status, env_code=req.env_code, date_field=req.date_field,
        date_from=req.date_from, date_to=req.date_to,
        order_numbers=req.order_numbers, asin=req.asin,
        page=req.page, page_size=req.page_size,
    )
    return schemas.Envelope(ok=True, data=got)


@router.post("/tasks/export")
def export_tasks(req: schemas.TaskSearchReq, conn=Depends(conn_ctx)):
    """按当前筛选导出 CSV。

    **导的是整个筛选结果,不是当前这一页** —— 只导一页是最阴的那种错:
    表看着完整、其实少了后面几千行,拿去对账会得出一个错的结论。

    流式吐,不在内存里攒完再发:几千行本身不大,但「先攒完」会让人误以为
    这个接口对行数没上限,哪天真导十万行就变成一次 OOM。

    带 UTF-8 BOM:Excel 不看 BOM 会把中文当成 GBK,一表格乱码。
    这一个字节省下来没有任何好处,而少了它运营第一次打开就会来问。
    """
    def rows():
        buf = io.StringIO()
        w = csv.writer(buf)

        def flush() -> str:
            out = buf.getvalue()
            buf.seek(0)
            buf.truncate(0)
            return out

        w.writerow([label for _, label in task_query.EXPORT_COLUMNS])
        yield "\ufeff" + flush()

        for row in task_query.export_rows(
            conn, page_size=settings.admin_page_size_max(),
            status=req.status, env_code=req.env_code, date_field=req.date_field,
            date_from=req.date_from, date_to=req.date_to,
            order_numbers=req.order_numbers, asin=req.asin,
        ):
            w.writerow(["" if row.get(k) is None else str(row[k])
                        for k, _ in task_query.EXPORT_COLUMNS])
            yield flush()

    return StreamingResponse(rows(), media_type="text/csv; charset=utf-8", headers={
        "Content-Disposition": 'attachment; filename="tasks.csv"',
    })


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


@router.post("/tasks/batch-reset")
def batch_reset(req: schemas.BatchResetReq, conn=Depends(conn_ctx)) -> schemas.Envelope:
    """批量重置回待拍单。**不接受 acknowledged,永远不接受** ——
    见 services/task_admin.batch_reset 的注释。能重的都重,不能重的原样报回来。"""
    got = task_admin.batch_reset(conn, req.task_ids, operator=req.operator)
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


@router.post("/tasks/import")
def import_tasks(req: schemas.IntakeReq, conn=Depends(conn_ctx)) -> schemas.Envelope:
    """上游采购行落库。每一行的去向都在 details 里,不存在被静默丢掉的行。"""
    rows = [r.model_dump() for r in req.rows]
    got = task_intake.ingest(conn, rows, release=req.release)
    return schemas.Envelope(ok=True, data=got)


@router.post("/tasks/{task_id}/release")
def release_task(task_id: int, req: schemas.OperatorReq | None = None,
                 conn=Depends(conn_ctx)):
    """pending → ready。放行闸口:落库与放行分开,中间那一格留给上游或人来把关。

    收 operator —— 原先这条路由不接请求体,「操作人」在放行这一个动作上永远记 null。
    """
    try:
        got = task_admin.release(conn, task_id,
                                 operator=req.operator if req else None)
    except task_admin.AdminRefused as exc:
        return _refused(exc)
    return schemas.Envelope(ok=True, data=got)
