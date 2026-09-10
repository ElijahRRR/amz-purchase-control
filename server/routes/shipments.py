"""物流轨迹回传。"""

from fastapi import APIRouter, Depends, HTTPException

from server import schemas
from server.deps import conn_ctx, require_instance
from registry import settings
from services import instance, shipment, task_event

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
        # 订单详情页打不开这一单。**这句结论要分两种情况说。**
        #
        # 外部下单这一辈子只走 /pending + /sync,**根本不经过 claim** —— 认领那两道闸
        # (登出 / 登错号)对它们一次都不生效。一台登错号或已登出的机器照样领得到
        # 外部单来同步:它在**错的账号**下打开订单详情页,自然打不开,回 not_found。
        # 那时说「回填的单号可能不属于这个买家号」是**错的诊断** —— 单号没问题,
        # 是这台机器登错了号。运营照着它去查上游填的单号(而它是对的),
        # 真正要做的是去那个 profile 里换回账号。两种处置完全不同的情况渲染成
        # 同一句结论,正是这个项目最不许有的事。
        #
        # 判据不新写:走 instance.cannot_speak_for_env(它接的就是认领那两道闸的
        # 唯一定义处)。这里**只记不改**:一次打不开也可能是页面抽风,自动把
        # purchased 打回待人工会在 Amazon 抽风的那天把一整批已完成的单全掀翻。
        # 连续多少次才该转人工,要等真实数据说话 —— 见 docs/03 §5。
        blind = instance.cannot_speak_for_env(conn, inst["id"])
        task_event.record(conn, req.task_id, "shipment", instance_id=inst["id"], payload={
            "order_state": "not_found",
            # 这一位单独留一格:事后要答得出「当时是不是这台机器的问题」,
            # 而 note 是给人读的一句话,不该拿它去做判据。
            "reader_blind": blind,
            "note": (f"订单详情页打不开;但{blind} —— "
                     "这一次 not_found **说明不了**单号有没有挂错。"
                     "请先把这台机器的账号/登录态弄对,再看这一单"
                     if blind else
                     "订单详情页打不开;回填的单号可能不属于这个买家号,待人工复核"),
        })

    return schemas.Envelope(ok=True, data={"shipment_id": sid, "events": len(req.events),
                                           "status": status})
