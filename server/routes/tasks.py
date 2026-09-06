"""任务:认领、上报、护栏裁决、完成、失败、释放。"""

from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from registry import settings
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

    try:
        task = task_queue.claim(conn, inst["buyer_env_id"], inst["id"])
    except task_queue.ClaimBlocked as exc:
        # 这里**不能**回 ok=True/data=None:那是「没单可派」的意思,
        # 插件收到之后会安静地等下一轮,10 秒一次一直刷到有人发现为止。
        # 被闸拦下要说出闸的名字 —— 这一整件事就是为了让「被登出」不再长得
        # 跟「队列是空的」一模一样。
        #
        # 用 return 而不是 raise:这条路径上还没写过库,但 CLAUDE.md 那条
        # 「写过库就不许 raise」是按路由整体来守的,统一走 JSONResponse 更省心。
        return JSONResponse(status_code=409, content={
            "ok": False, "data": None,
            "error": {"code": exc.code, "message": exc.message},
        })
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
            # 从库里那一列来。此前这里不传,走的是 GuardsOut 里的 `= True` 默认值
            # —— 一道号称"可关"的闸恒为真,而插件侧 run.ts 读的就是它。
            require_fba=task["require_fba"],
        ),
        # 插件那边所有「等下去」的上界都要按它反推,别让 sweep 在插件还在等的时候
        # 把单收走(见 schemas.TaskOut.claim_timeout_min)。
        claim_timeout_min=settings.claim_timeout_minutes(),
    ))


@router.post("/{task_id}/events")
def events(task_id: int, req: schemas.EventsReq, conn=Depends(conn_ctx)) -> schemas.Envelope:
    inst = require_instance(conn, req.instance_uid)
    task = require_task_owned(conn, task_id, inst)
    crossed = False
    for ev in req.events:
        task_event.record(conn, task_id, ev.kind, instance_id=inst["id"],
                          code=ev.code, payload=ev.payload)
        # 「点击下单按钮」那一条。插件在 placeOrder() **之前**置位 mayHaveOrdered
        # 并立刻报上来 —— 从这一刻起,这一单是可能已经花过钱的。
        if ev.kind == "step" and ev.payload.get("may_have_ordered") is True:
            crossed = True
    if crossed:
        # **与追加事件同一事务。** 分开写(比如另起一个连接、或者留给别处补)的话,
        # 会出现「事件流里写着点过下单按钮、而闸门那一列还是 false」——
        # 一条留了痕却没人认的痕,比不留更坏:看的人以为它管用。
        #
        # 只往 true 写,永远不写回 false:重置回队列不清它,「曾经花过钱」是既成事实。
        conn.execute(
            "UPDATE procure.tasks SET may_have_ordered = true "
            " WHERE id = %s AND NOT may_have_ordered", (task_id,))
    # 回的是**这条任务此刻的状态**,不是「这一批里有没有那条 step」。
    #
    # 原先回的是后者,于是同一条已经越过下单点的任务,下一次报「等待确认页」时
    # 拿到的是 false —— 而库里那一列是 true。字段名叫 may_have_ordered,
    # 读的人(插件想据此决定还能不能 release、下一个写运营台或重放工具的人)
    # 会照字面理解成任务的状态,于是「从没越过下单点」与「上一次请求已经越过了」
    # 渲染成同一个 false。这一列只会 false → true,所以旧值取或就是新值,
    # 不必为此再查一次库。
    return schemas.Envelope(ok=True, data={
        "recorded": len(req.events),
        "may_have_ordered": bool(task["may_have_ordered"]) or crossed,
    })


@router.post("/{task_id}/guard-check")
def guard_check(task_id: int, req: schemas.GuardCheckReq,
                conn=Depends(conn_ctx)) -> schemas.Envelope:
    inst = require_instance(conn, req.instance_uid)
    task = require_task_owned(conn, task_id, inst)

    # 这个买家号配了「该刷哪张卡」吗。留空 = 不校验(与 require_fba 同形态)。
    env = conn.execute(
        "SELECT expected_card_last4 FROM procure.buyer_envs WHERE id = %s",
        (task["buyer_env_id"],),
    ).fetchone()

    gift = req.gift_card
    verdict = price_guard.adjudicate(
        price_cap=task["price_cap"],
        max_delivery_days=task["max_delivery_days"],
        actual_total=req.actual_total,
        delivery_raw=req.delivery_raw,
        delivery_raws=req.delivery_raws,
        today=_site_today(),
        # 显式传,不吃默认值 —— 这一步此前是漏的
        require_fba=task["require_fba"],
        is_fba=req.is_fba,
        gift_card_applied=bool(gift and gift.applied),
        gift_card_amount=gift.amount if gift else None,
        expected_card_last4=env["expected_card_last4"] if env else None,
        payment_last4=req.payment_last4,
        payment_slots=req.payment_slots,
        line_items=[i.model_dump() for i in req.line_items],
    )

    # 服务端算出来的那两个数落库,**不管放不放行**:被拦下的单同样要能答出
    # 「当时护栏比的是哪个数」。插件报的 goods_total 只用来对账,不写库。
    # 算不出来时(那几条 PLUGIN_INTERNAL)不写 —— 见 record_guard_amounts:
    # 拿 None 覆盖会把上一次已经落库的数抹成 NULL。
    task_queue.record_guard_amounts(
        conn, task_id,
        gift_card_amount=verdict.gift_card_amount,
        goods_total=verdict.goods_total,
    )

    # 插件算的和服务端算的不一致,单独记一笔。两边算同一个式子却得出不同的数,
    # 只可能是解析层出了岔子 —— 不拦单(以服务端的为准),但必须看得见。
    plugin_goods = str(req.goods_total) if req.goods_total is not None else None
    server_goods = str(verdict.goods_total) if verdict.goods_total is not None else None
    mismatch = (plugin_goods is not None and server_goods is not None
                and req.goods_total != verdict.goods_total)

    # **放行与拦下共用同一份载荷。** 拆成两处各拼一遍的后果实测过:
    # plugin_goods_total 当初只写进了放行那一支,于是「插件把货款算错了」
    # 与「这一单被护栏拦下了」同时发生时 —— 也就是最需要这条线索的时候 ——
    # 事件流里反而没有它,事后只知道「服务端算出 2241.86 拦了」,
    # 不知道插件当时算的是 1.00,而这正是「解析层坏了」与「这单真超了」的分水岭。
    amounts = {
        "actual_total": str(req.actual_total),
        "goods_total": server_goods,
        "gift_card_amount": (str(verdict.gift_card_amount)
                             if verdict.gift_card_amount is not None else None),
        # 非阻断的自洽记录。事件流是这类「不拦但要留痕」信号的正确去处 ——
        # 与 unitPriceSelectorBroken 同一个模式。
        "consistency_note": verdict.consistency_note,
        # 只在两边真的不一致时非空:一致时写进去等于每一单都记一笔「一致」,
        # 而一条每单都出现的记录等于没有记录。
        "plugin_goods_total": plugin_goods if mismatch else None,
        # 结算页上「已选支付方式」的槽位数。见 price_guard 里拆分支付那一段。
        "payment_slots": req.payment_slots,
    }

    if not verdict.allow:
        task_event.record(conn, task_id, "guard_block", instance_id=inst["id"],
                          code=verdict.error_code,
                          payload={"detail": verdict.detail, **amounts,
                                   "delivery_raw": verdict.delivery_raw_used or req.delivery_raw})
    else:
        task_event.record(conn, task_id, "step", instance_id=inst["id"],
                          payload={"step": "guard_check", "result": "allow", **amounts,
                                   "delivery_date": str(verdict.delivery_date)})

    return schemas.Envelope(ok=True, data=schemas.GuardCheckOut(
        allow=verdict.allow,
        error_code=verdict.error_code,
        detail=verdict.detail,
        delivery_date=str(verdict.delivery_date) if verdict.delivery_date else None,
        delivery_raw_used=verdict.delivery_raw_used,
        goods_total=verdict.goods_total,
    ))


@router.post("/{task_id}/complete")
def complete(task_id: int, req: schemas.CompleteReq,
             conn=Depends(conn_ctx)) -> schemas.Envelope:
    inst = require_instance(conn, req.instance_uid)

    # 归属校验就地做,不走 require_task_owned 的 raise ——
    # 因为这里要在拒绝**之前**把单号留痕。插件走到这一步意味着 Amazon 上
    # 很可能已经真下成了单;这时候把请求原样丢掉,那个真实单号就只剩在插件的内存里,
    # 库里、事件流里、日志里全都没有。运营看到的是一条「没回传」的任务,
    # 而钱已经花掉了。
    row = conn.execute(
        "SELECT status, claimed_by FROM procure.tasks WHERE id = %s", (task_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(404, detail={"code": "TASK_NOT_FOUND",
                                         "message": f"任务不存在:{task_id}"})
    if row["status"] != "claimed" or row["claimed_by"] != inst["id"]:
        # 典型成因:这一单跑得久,task_sweep 已经把它当超时转成 manual 了。
        task_event.record(conn, task_id, "assert_failed", instance_id=inst["id"],
                          payload={"reason": "late_complete", "status": row["status"],
                                   "amazon_order_no": req.amazon_order_no,
                                   "observed_asins": req.observed_asins,
                                   "actual_total": str(req.actual_total or "")})
        # 已经写过库,只能 return 不能 raise(pg_conn 遇异常会把这条留痕一起回滚)
        return JSONResponse(status_code=409, content={
            "ok": False, "data": None,
            "error": {"code": "TASK_NOT_HELD",
                      "message": f"任务 {task_id} 当前是 {row['status']},"
                                 f"单号 {req.amazon_order_no} 已记入事件流待人工回填"},
        })

    # 单号撞库要在写之前查:UniqueViolation 会让整个事务作废,
    # 那样连「这个单号是谁报上来的」都留不下,任务还会卡死在 claimed。
    dup = conn.execute(
        "SELECT id FROM procure.tasks WHERE amazon_order_no = %s AND id <> %s",
        (req.amazon_order_no, task_id),
    ).fetchone()
    if dup:
        task_event.record(conn, task_id, "assert_failed", instance_id=inst["id"],
                          payload={"reason": "order_no_taken",
                                   "amazon_order_no": req.amazon_order_no,
                                   "held_by_task": dup["id"]})
        task_queue.fail(conn, task_id, "ORDER_NO_AMBIGUOUS", instance_id=inst["id"],
                        detail=f"{req.amazon_order_no} 已挂在任务 {dup['id']} 上", to_manual=True)
        return JSONResponse(status_code=409, content={
            "ok": False, "data": None,
            "error": {"code": "ORDER_NO_TAKEN",
                      "message": f"{req.amazon_order_no} 已经挂在任务 {dup['id']} 上,已转人工"},
        })

    task = require_task_owned(conn, task_id, inst)

    # 零成本断言:订单卡上的 ASIN 必须是本单的。不符不静默写库,转人工。
    expected = [r["asin"] for r in conn.execute(
        "SELECT asin FROM procure.task_products WHERE task_id = %s", (task_id,)
    ).fetchall()]
    verdict = order_backfill.asins_match(expected, req.observed_asins)
    if verdict == "not_observed":
        # 既定取舍:一个 ASIN 都没采到**不阻断回填**(断言的职责是抓错配,
        # 不是制造噪音)。但它与「对上了」不是同一件事,不能渲染成同一个结果 ——
        # 选择器一坏,observed 就恒为空,断言整体退化成厂商那套「盲取第一张卡」,
        # 而回填照常成功。留一条事件,让「这道断言什么时候整体失效」是可数的
        # (近 7 日计数在 GET /v1/admin/error-stats 上,见 services/ops_query)。
        task_event.record(conn, task_id, "assert_skipped", instance_id=inst["id"],
                          payload={"reason": "no_asin_observed", "expected": expected,
                                   "amazon_order_no": req.amazon_order_no})
    elif verdict == "mismatch":
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
        line_items=[i.model_dump() for i in req.line_items],
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
        # 不阻断上报(失败必须记下来),但留痕。**分两种写**:
        #   试了没清动 → warning=cart_not_cleared,这台机器清不动购物车,
        #                下一单会被残留商品污染,运营台实例页那一格数的就是它;
        #   压根没试   → 越过下单点之后按规矩不动购物车(见 flow/run.finish),
        #                规矩被遵守了不是异常,不该跟上面那种长成一个样子。
        # step 的正文写中文:TaskDetail 的约定是「step 的正文在 payload.step,
        # 插件发的时候就是中文」,而这两条是服务端自己发的,原先正文是英文单词
        # "fail" —— 事件流上于是出现「执行步骤  fail · warning=cart_not_cleared」。
        # 机器读的键名(warning / cart)不动:运营台实例页那格 SQL 认的是它们。
        payload = ({"step": "失败上报 · 清车没清动", "warning": "cart_not_cleared"}
                   if req.cart_clear_attempted
                   else {"step": "失败上报 · 越过下单点后按规矩没动购物车",
                         "cart": "not_touched_after_order_point"})
        task_event.record(conn, task_id, "step", instance_id=inst["id"], payload=payload)

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
    task = require_task_owned(conn, task_id, inst)

    # 「点下单那一刻起,禁止退回队列」—— 这一条在服务端也必须有一份。
    #
    # 插件那侧确实判了(run.ts 的 `if (!mayHaveOrdered)`),但那正是这次改动
    # 全部的立意所在:重置回队列的三条路之所以不再只按 error_code 判,就是因为
    # 「越没越过下单点」这件事不能只由被管的一方说了算。而 /release 是**最直接的
    # 第四条路** —— 插件版本旧了、那个 if 被人改坏、或者另写了一条清理路径,
    # 这一单就原地回到 ready,下一次 claim 立刻把它再派出去,全程没有任何人参与,
    # 而它已经点过下单按钮了。人工重置那道闸至少还要人点一下,这条连人都没有。
    #
    # 判据放在路由层不放 task_queue.release 的 WHERE 里:那个函数返回 False 会被
    # 这里渲染成 TASK_NOT_HELD —— **说错了原因**,插件日志里留下的是「这一单已经
    # 不在我手上」,而真相是「它在你手上,但你不许放手」。
    #
    # 拒绝之前先留痕:插件试图退回一张越过下单点的单,本身就是插件那侧漏判的证据,
    # 而这件事在库里不留一行的话,下次只能靠猜。
    if task["may_have_ordered"]:
        task_event.record(conn, task_id, "assert_failed", instance_id=inst["id"],
                          payload={"reason": "release_after_order_line"})
        # 已经写过库,只能 return 不能 raise(pg_conn 遇异常会把这条留痕一起回滚)。
        return JSONResponse(status_code=409, content={
            "ok": False, "data": None,
            "error": {"code": "POSSIBLY_ORDERED",
                      "message": f"任务 {task_id} 已经越过下单点(下单按钮点过了),"
                                 f"不许退回队列。让它超时转人工,或者走后台由人裁决。"},
        })

    if not task_queue.release(conn, task_id, inst["id"]):
        raise HTTPException(409, detail={"code": "TASK_NOT_HELD",
                                         "message": f"任务 {task_id} 已不处于 claimed"})
    return schemas.Envelope(ok=True, data={"task_id": task_id, "status": "ready"})
