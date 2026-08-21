"""物流轨迹回传。"""

from fastapi import APIRouter, Depends, HTTPException

from server import schemas
from server.deps import conn_ctx, require_instance
from services import shipment

router = APIRouter(prefix="/v1/shipments", tags=["shipments"])


@router.post("/sync")
def sync(req: schemas.ShipmentSyncReq, conn=Depends(conn_ctx)) -> schemas.Envelope:
    require_instance(conn, req.instance_uid)
    exists = conn.execute(
        "SELECT 1 FROM procure.tasks WHERE id = %s", (req.task_id,)
    ).fetchone()
    if exists is None:
        raise HTTPException(404, detail={"code": "TASK_NOT_FOUND",
                                         "message": f"任务不存在:{req.task_id}"})
    sid = shipment.sync(
        conn, task_id=req.task_id, carrier=req.carrier, tracking_no=req.tracking_no,
        tracking_url=req.tracking_url, status=req.status,
        events=[e.model_dump() for e in req.events],
    )
    return schemas.Envelope(ok=True, data={"shipment_id": sid, "events": len(req.events)})
