"""任务:认领、上报、护栏裁决、完成、失败、释放。"""

from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from server import schemas
from server.deps import conn_ctx, require_instance, require_task_owned
from services import order_backfill, price_guard, task_event, task_queue

router = APIRouter(prefix="/v1/tasks", tags=["tasks"])

# 首期只做 US 站,交期以美西时区的「当天」为基准
SITE_TZ = ZoneInfo("America/Los_Angeles")


def _site_today():
    return datetime.now(SITE_TZ).date()


@router.post("/claim")
def claim(req: schemas.ClaimReq, conn=Depends(conn_ctx)) -> schemas.Envelope:
    inst = require_instance(conn, req.instance_uid)
    if inst["env_status"] != "active":
        return schemas.Envelope(ok=True, data=None)   # 环境被暂停,不派单

    task = task_queue.claim(conn, inst["buyer_env_id"], inst["id"])
    if task is None:
        return schemas.Envelope(ok=True, data=None)   # 无可派任务,不是错误

    return schemas.Envelope(ok=True, data=schemas.TaskOut(
        task_id=task["id"],
        marketplace=task["marketplace"],
        shipping=schemas.ShippingOut(
            name=task["ship_name"], phone=task["ship_phone"], line1=task["ship_line1"],
            city=task["ship_city"], state=task["ship_state"],
            postcode=task["ship_postcode"], country=task["ship_country"],
        ),
        products=[schemas.ProductOut(asin=p["asin"], quantity=p["quantity"])
                  for p in task["products"]],
        guards=schemas.GuardsOut(
            price_cap=task["price_cap"],
            max_delivery_days=task["max_delivery_days"],
        ),
    ))


@router.post("/{task_id}/events")
def events(task_id: int, req: schemas.EventsReq, conn=Depends(conn_ctx)) -> schemas.Envelope:
    inst = require_instance(conn, req.instance_uid)
    require_task_owned(conn, task_id, inst)
    for ev in req.events:
        task_event.record(conn, task_id, ev.kind, instance_id=inst["id"],
                          code=ev.code, payload=ev.payload)
    return schemas.Envelope(ok=True, data={"recorded": len(req.events)})


@router.post("/{task_id}/guard-check")
def guard_check(task_id: int, req: schemas.GuardCheckReq,
                conn=Depends(conn_ctx)) -> schemas.Envelope:
    inst = require_instance(conn, req.instance_uid)
    task = require_task_owned(conn, task_id, inst)

    verdict = price_guard.adjudicate(
        price_cap=task["price_cap"],
        max_delivery_days=task["max_delivery_days"],
        actual_total=req.actual_total,
        delivery_raw=req.delivery_raw,
        today=_site_today(),
        is_fba=req.is_fba,
    )

    if not verdict.allow:
        task_event.record(conn, task_id, "guard_block", instance_id=inst["id"],
                          code=verdict.error_code,
                          payload={"detail": verdict.detail,
                                   "actual_total": str(req.actual_total),
                                   "delivery_raw": req.delivery_raw})
    else:
        task_event.record(conn, task_id, "step", instance_id=inst["id"],
                          payload={"step": "guard_check", "result": "allow",
                                   "delivery_date": str(verdict.delivery_date)})

    return schemas.Envelope(ok=True, data=schemas.GuardCheckOut(
        allow=verdict.allow,
        error_code=verdict.error_code,
        detail=verdict.detail,
        delivery_date=str(verdict.delivery_date) if verdict.delivery_date else None,
    ))


@router.post("/{task_id}/complete")
def complete(task_id: int, req: schemas.CompleteReq,
             conn=Depends(conn_ctx)) -> schemas.Envelope:
    inst = require_instance(conn, req.instance_uid)
    task = require_task_owned(conn, task_id, inst)

    # 零成本断言:订单卡上的 ASIN 必须是本单的。不符不静默写库,转人工。
    expected = [r["asin"] for r in conn.execute(
        "SELECT asin FROM procure.task_products WHERE task_id = %s", (task_id,)
    ).fetchall()]
    if not order_backfill.asins_match(expected, req.observed_asins):
        task_event.record(conn, task_id, "assert_failed", instance_id=inst["id"],
                          payload={"expected": expected, "observed": req.observed_asins,
                                   "amazon_order_no": req.amazon_order_no})
        task_queue.fail(conn, task_id, "ORDER_NO_AMBIGUOUS", instance_id=inst["id"],
                        detail=f"订单卡 ASIN {req.observed_asins} 与本单 {expected} 不符",
                        to_manual=True)
        # ⚠ 这里**必须 return 而不是 raise**:registry.db.pg_conn 遇异常会 rollback,
        # 上面刚写的「转 manual」会被一起回滚,任务卡死在 claimed。
        # 规则:路由里只要已经写过库,就不许再抛 HTTPException(见 CLAUDE.md)。
        return JSONResponse(status_code=409, content={
            "ok": False, "data": None,
            "error": {
                "code": "ORDER_NO_AMBIGUOUS",
                "message": f"订单卡 ASIN 与本单不符,已转人工:期望 {expected},实际 {req.observed_asins}",
            },
        })

    delivery_date = None
    if req.delivery_raw:
        from services.delivery import parse_delivery
        delivery_date = parse_delivery(req.delivery_raw, today=_site_today())

    ok = task_queue.complete(
        conn, task_id, amazon_order_no=req.amazon_order_no, instance_id=inst["id"],
        totals={
            "actual_total": req.actual_total,
            "actual_shipping": req.actual_shipping,
            "actual_tax": req.actual_tax,
            "payment_last4": req.payment_last4,
            "delivery_date": delivery_date,
            "delivery_raw": req.delivery_raw,
        },
    )
    if not ok:
        raise HTTPException(409, detail={"code": "TASK_NOT_HELD",
                                         "message": f"任务 {task_id} 已不处于 claimed"})
    return schemas.Envelope(ok=True, data={"task_id": task_id, "status": "purchased"})


@router.post("/{task_id}/fail")
def fail(task_id: int, req: schemas.FailReq, conn=Depends(conn_ctx)) -> schemas.Envelope:
    inst = require_instance(conn, req.instance_uid)
    require_task_owned(conn, task_id, inst)

    if not req.cart_cleared:
        # 不阻断上报(失败必须记下来),但留痕:清车没做,下一单可能被残留商品污染
        task_event.record(conn, task_id, "step", instance_id=inst["id"],
                          payload={"step": "fail", "warning": "cart_not_cleared"})

    ok = task_queue.fail(conn, task_id, req.error_code, instance_id=inst["id"],
                         detail=req.detail, to_manual=req.to_manual)
    if not ok:
        raise HTTPException(409, detail={"code": "TASK_NOT_HELD",
                                         "message": f"任务 {task_id} 已不处于 claimed"})
    return schemas.Envelope(ok=True, data={
        "task_id": task_id,
        "status": "manual" if req.to_manual else "exception",
    })


@router.post("/{task_id}/release")
def release(task_id: int, req: schemas.ReleaseReq, conn=Depends(conn_ctx)) -> schemas.Envelope:
    inst = require_instance(conn, req.instance_uid)
    require_task_owned(conn, task_id, inst)
    if not task_queue.release(conn, task_id, inst["id"]):
        raise HTTPException(409, detail={"code": "TASK_NOT_HELD",
                                         "message": f"任务 {task_id} 已不处于 claimed"})
    return schemas.Envelope(ok=True, data={"task_id": task_id, "status": "ready"})
