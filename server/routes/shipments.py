"""物流轨迹回传。"""

from fastapi import APIRouter, Depends, HTTPException

from server import schemas
from server.deps import conn_ctx, require_instance
from registry import settings
from services import shipment, task_event

router = APIRouter(prefix="/v1/shipments", tags=["shipments"])


@router.post("/pending")
def pending(req: schemas.ShipmentPendingReq, conn=Depends(conn_ctx)) -> schemas.Envelope:
    """插件问:我这个买家号下,哪些单的物流该同步了。"""
    inst = require_instance(conn, req.instance_uid)
    limit = min(req.limit or settings.shipment_batch_size(), settings.shipment_batch_size())
    rows = shipment.pending(
        conn, env_id=inst["buyer_env_id"],
        resync_minutes=settings.shipment_resync_minutes(), limit=limit,
    )
    return schemas.Envelope(ok=True, data={"items": rows})


@router.post("/sync")
def sync(req: schemas.ShipmentSyncReq, conn=Depends(conn_ctx)) -> schemas.Envelope:
    inst = require_instance(conn, req.instance_uid)
    exists = conn.execute(
        "SELECT 1 FROM procure.tasks WHERE id = %s", (req.task_id,)
    ).fetchone()
    if exists is None:
        raise HTTPException(404, detail={"code": "TASK_NOT_FOUND",
                                         "message": f"任务不存在:{req.task_id}"})
    # 订单本身的状态盖过轨迹状态:页面说 cancelled,轨迹上写什么都不算数。
    status = "cancelled" if req.order_state == "cancelled" else req.status

    sid = shipment.sync(
        conn, task_id=req.task_id, carrier=req.carrier, tracking_no=req.tracking_no,
        tracking_url=req.tracking_url, status=status,
        events=[e.model_dump() for e in req.events],
    )

    task_event.record(conn, req.task_id, "shipment", instance_id=inst["id"], payload={
        "order_state": req.order_state, "status": status,
        "carrier": req.carrier, "tracking_no": req.tracking_no,
        "events": len(req.events),
        # 「Amazon 暂时给不了」与「我们没解析出来」都是 0 条轨迹,
        # 不记这一位的话事后分不出是哪一种 —— 而处置完全不同。
        "tracking_unavailable": req.tracking_unavailable,
    })

    if req.order_state == "not_found":
        # 订单详情页打不开这一单,说明我们回填的那个号可能根本不属于这个买家号。
        # 这里**只记不改**:一次打不开也可能是页面抽风,自动把 purchased 打回
        # 待人工会在 Amazon 抽风的那天把一整批已完成的单全掀翻。
        # 连续多少次才该转人工,要等真实数据说话 —— 见 docs/03 §5。
        task_event.record(conn, req.task_id, "shipment", instance_id=inst["id"], payload={
            "order_state": "not_found",
            "note": "订单详情页打不开;回填的单号可能不属于这个买家号,待人工复核",
        })

    return schemas.Envelope(ok=True, data={"shipment_id": sid, "events": len(req.events),
                                           "status": status})
