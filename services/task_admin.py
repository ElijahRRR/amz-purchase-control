"""后台的人工处置:重置回队列、强制回填单号、改地址、改 ASIN。

每一个动作都会往 task_events 里追加一条 kind='admin' 的记录 ——
人动过的手和插件跑出来的结果必须在同一条时间线上分得开。
厂商面板这四个动作各有一个独立接口,改完不留痕,事后没法追。

拒绝的判定一律发生在**写库之前**,所以拒绝时抛异常是安全的
(见 CLAUDE.md「路由里只要已经写过库,就不许再 raise」)。
"""

from typing import Any

from services import error_codes, task_event


class AdminRefused(Exception):
    """这个动作在当前状态下不允许。code 给界面用,message 给人看。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _task(conn, task_id: int) -> dict[str, Any]:
    row = conn.execute(
        "SELECT id, status, error_code, amazon_order_no, may_have_ordered "
        "  FROM procure.tasks WHERE id = %s",
        (task_id,),
    ).fetchone()
    if row is None:
        raise AdminRefused("TASK_NOT_FOUND", f"任务 {task_id} 不存在")
    return dict(row)


def reset_to_queue(conn, task_id: int, *, acknowledged: bool = False,
                   operator: str | None = None, by: str = "manual",
                   payload_extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """输入:任务 id(+ 是否已确认过 + 是人点的还是系统自动重的)→ 输出:{task_id, status}。

    exception 可以直接重置。要看的是这一单**有没有可能已经在 Amazon 上真花过钱**:
    错误码属于 POSSIBLY_ORDERED,**或者** tasks.may_have_ordered 为 true(插件报过
    「点击下单按钮」)—— 任何一条成立,重置就是让下一个实例把同一单再买一遍,
    必须先有人去买家号里确认过,acknowledged 就是那一步的回执。

    `by` 只有两个值,它决定三件事,而这三件事必须一起决定,不能分头写:
      · 事件流里落 `admin`(人)还是 `auto_retry`(机器)—— 两种重置在时间线上
        长得一样的话,出现重复下单时没人答得上「是谁把它放回队列的」
      · `retry_count` 加不加 1 —— **只有机器那次加**。人点的重置背后有人在看,
        不该占掉机器的自动次数;放在这一条 UPDATE 里,是为了不给「重置了但忘了计数」
        留出任何缝隙(有界重试的「界」全靠这个数)
      · 机器**永远不许**带 acknowledged(见下面那道拒绝)

    自动重试走这个函数而不是另写一条状态流转:两条路各写一遍,迟早一条改了另一条没改
    (本项目已经因为「两份副本悄悄分叉」栽过两次),而这条路的分叉后果是重复下单。
    """
    if by not in ("manual", "auto"):
        raise ValueError(f"by 只能是 manual / auto,收到 {by!r}")
    if by == "auto" and acknowledged:
        # 机器给不了这个回执。acknowledged 的含义是**有人去那个买家号的订单页看过了**,
        # 自动重试里没有那个人。哪天有人在自动重试那条链上顺手写了 acknowledged=True,
        # 这里就是最后一道闸 —— 它拦的是「一条定时任务把可能已下单的单反复重拍」。
        raise AdminRefused("ACK_NOT_FOR_AUTO",
                           "acknowledged 是人去买家号确认过的回执,自动重试给不了它")
    t = _task(conn, task_id)
    if t["status"] not in ("exception", "manual"):
        raise AdminRefused("BAD_STATUS", f"只有拍单异常/待人工能重置,当前是 {t['status']}")

    # 按 **error_code** 判,不按 status。
    #
    # 原先是 `status == "manual" and error_code in POSSIBLY_ORDERED` —— 那等于
    # 把「要不要人先去看一眼」的决定权交给了插件:状态是插件在 /fail 里用自己算的
    # to_manual 布尔定的。插件那侧漏判一次(版本旧了、TO_MANUAL 两边分叉、
    # 或者干脆算错),同一个 ORDER_CONFIRM_TIMEOUT 就会落成 exception,
    # 于是这道闸整个绕过去,而运营台上那条紫色警告照样在喊「可能已经下单」——
    # **喊完了静默重置**。这正是「看起来有护栏、实际防不住」。
    #
    # 错误码是服务端校验过的封闭集(task_event.validate),比状态可靠。
    #
    # **但光判码还是漏。** run.ts 的 catch 里,DriverError 认得出原因时直接用它自己的码,
    # 只有认不出来才兜底成 ORDER_CONFIRM_TIMEOUT。于是「点完下单按钮之后读订单卡抛错」
    # 这一路落库是 status=manual + error_code=PLUGIN_INTERNAL —— 状态说要人裁决,
    # 码说重一下就过,而这三个码一个都没沾上。判码的闸放行,人点一下重置,
    # 这张已经花过钱的单被再买一遍。
    #
    # 所以第二条判据是 tasks.may_have_ordered:插件在 placeOrder() **之前**报的
    # 那一条 step 事件把它置成 true(server/routes/tasks.py 的 events 端点),
    # 它记的是「越没越过下单点」这个事实本身,与失败之后落了哪个码无关。
    # 两条判据取或,不取与 —— 任何一条成立都要人先去订单页看过。
    risky_code = t["error_code"] in error_codes.POSSIBLY_ORDERED
    crossed = bool(t["may_have_ordered"])
    if (risky_code or crossed) and not acknowledged:
        why = (f"{t['error_code']} 意味着这一单可能已经真下成了" if risky_code
               else "这一单已经越过下单点(下单按钮点过了),可能已经真下成了")
        raise AdminRefused(
            "NEEDS_ACK",
            f"{why}。请先去买家号里确认没有这一单,再带 acknowledged 重置。",
        )

    conn.execute(
        """UPDATE procure.tasks
              SET status='ready', error_code=NULL, error_detail=NULL,
                  claimed_by=NULL, claimed_at=NULL, updated_at=now(),
                  retry_count = retry_count + %(bump)s
            WHERE id = %(task_id)s""",
        {"task_id": task_id, "bump": 1 if by == "auto" else 0},
    )
    # 重置会把 tasks.error_code 清空,所以「当初是因为什么被重的」只剩事件里这一份
    # (payload 的 was_error_code)。这条不落 code 列:code 列是失败事件的统计口径
    # (task_query 的错误码分布按 kind in error/guard_block 取),重置不是一次新的失败。
    task_event.record(conn, task_id, "auto_retry" if by == "auto" else "admin",
                      payload={"action": "reset_to_queue", "from": t["status"], "by": by,
                               "was_error_code": t["error_code"],
                               "acknowledged": acknowledged, "operator": operator,
                               **(payload_extra or {})})
    return {"task_id": task_id, "status": "ready"}


def force_backfill(conn, task_id: int, amazon_order_no: str, *,
                   note: str, operator: str | None = None) -> dict[str, Any]:
    """输入:任务 id + 人工确认的 AMZ 单号 + 必填说明 → 输出:{task_id, status}。

    这是整套后台里唯一一个「跳过断言直接写库」的动作。断言正是当初把这一单
    挡在待人工的那道闸,所以:
      · 只能对 manual 用
      · note 必填 —— 事后追责时"当时为什么敢写"必须留在库里
      · 库层的部分唯一索引还在,同一个 AMZ 单号落到两条任务上会被直接拒绝
    """
    if not note or not note.strip():
        raise AdminRefused("NOTE_REQUIRED", "强制回填必须写明依据")
    t = _task(conn, task_id)
    if t["status"] != "manual":
        raise AdminRefused("BAD_STATUS", f"只有待人工能强制回填,当前是 {t['status']}")

    dup = conn.execute(
        "SELECT id FROM procure.tasks WHERE amazon_order_no = %s AND id <> %s",
        (amazon_order_no, task_id),
    ).fetchone()
    if dup:
        # 先查一次给出人话;库层的唯一索引仍然是最后一道闸。
        raise AdminRefused("ORDER_NO_TAKEN",
                           f"{amazon_order_no} 已经挂在任务 {dup['id']} 上了")

    conn.execute(
        """UPDATE procure.tasks
              SET status='purchased', amazon_order_no=%s,
                  error_code=NULL, error_detail=NULL,
                  purchased_at=COALESCE(purchased_at, now()),
                  claimed_by=NULL, claimed_at=NULL, updated_at=now()
            WHERE id = %s""",
        (amazon_order_no, task_id),
    )
    task_event.record(conn, task_id, "admin",
                      payload={"action": "force_backfill", "amazon_order_no": amazon_order_no,
                               "was_error_code": t["error_code"], "note": note,
                               "operator": operator, "assertion_skipped": True})
    return {"task_id": task_id, "status": "purchased"}


#: 这几个状态下不许改单。
#:
#: purchased / cancelled 好理解:货已经在路上或者这单已经作废,改库里的值只会让
#: 库和现实对不上,是在制造一个更难查的问题。
#:
#: **claimed 是补上的那个**,而它才是最危险的一个:插件此刻正拿着这一单的快照
#: 在亚马逊上下单。这时候改 ASIN,插件买的还是旧的那个,回填时 ASIN 断言不符 ——
#: 一张真花了钱的订单挂不到任何任务上,成了孤儿单;而任务停在待人工,
#: 界面还会热情地建议你「强制回填」或者「重置回队列」,后者就是再买一遍。
#: 改地址同理:插件填的是旧地址,库里写的是新地址,包裹寄到哪儿只有亚马逊知道。
_FROZEN_FOR_EDIT = ("claimed", "purchased", "cancelled")


def _why_frozen(status: str, action: str) -> str:
    if status == "claimed":
        return (f"这一单正被插件拍着(claimed),不能{action} —— "
                f"插件拿的是改之前的快照,改了会买错东西、或者寄错地方。"
                f"等它跑完,或者先让它超时转人工。")
    return f"{status} 的单不能{action}"


_ADDRESS_FIELDS = ("ship_name", "ship_phone", "ship_line1", "ship_city",
                   "ship_state", "ship_postcode")


def update_address(conn, task_id: int, fields: dict[str, str], *,
                   operator: str | None = None) -> dict[str, Any]:
    """输入:任务 id + 要改的收货字段 → 输出:{task_id, changed}。

    已下单的不给改 —— 货已经在路上了,改库里的地址只会让库和现实对不上,
    是在制造一个更难查的问题。
    """
    unknown = set(fields) - set(_ADDRESS_FIELDS)
    if unknown:
        raise AdminRefused("BAD_FIELD", f"不认识的字段:{sorted(unknown)}")
    if not fields:
        raise AdminRefused("NOTHING_TO_DO", "没有要改的字段")

    t = _task(conn, task_id)
    if t["status"] in _FROZEN_FOR_EDIT:
        raise AdminRefused("BAD_STATUS", _why_frozen(t["status"], "改地址"))

    before = conn.execute(
        f"SELECT {', '.join(_ADDRESS_FIELDS)} FROM procure.tasks WHERE id = %s", (task_id,),
    ).fetchone()

    sets = ", ".join(f"{k} = %({k})s" for k in fields)
    conn.execute(f"UPDATE procure.tasks SET {sets}, updated_at=now() WHERE id = %(task_id)s",
                 {**fields, "task_id": task_id})
    task_event.record(conn, task_id, "admin",
                      payload={"action": "update_address", "operator": operator,
                               "before": {k: before[k] for k in fields},
                               "after": fields})
    return {"task_id": task_id, "changed": sorted(fields)}


def update_asin(conn, task_id: int, old_asin: str, new_asin: str, *,
                operator: str | None = None) -> dict[str, Any]:
    """输入:任务 id + 旧 ASIN + 新 ASIN → 输出:{task_id, asin}。

    改 ASIN 会让 line_key(= sha256(上游单号|asin))与实际内容不再对应。
    line_key 的职责是「同一张上游行不会重复落库」,是导入期的去重键,
    不是内容摘要 —— 所以这里**不重算**它,只在事件里把这件事记下来。
    """
    t = _task(conn, task_id)
    if t["status"] in _FROZEN_FOR_EDIT:
        raise AdminRefused("BAD_STATUS", _why_frozen(t["status"], "改 ASIN"))

    row = conn.execute(
        "SELECT id FROM procure.task_products WHERE task_id = %s AND asin = %s",
        (task_id, old_asin),
    ).fetchone()
    if row is None:
        raise AdminRefused("ASIN_NOT_FOUND", f"这一单里没有 {old_asin}")

    conn.execute("UPDATE procure.task_products SET asin = %s WHERE id = %s", (new_asin, row["id"]))
    task_event.record(conn, task_id, "admin",
                      payload={"action": "update_asin", "from": old_asin, "to": new_asin,
                               "operator": operator, "line_key_unchanged": True})
    return {"task_id": task_id, "asin": new_asin}


def release(conn, task_id: int, *, operator: str | None = None) -> dict[str, Any]:
    """输入:任务 id → 输出:{task_id, status}。pending → ready。

    落库与放行分开,是因为中间这一格有用:护栏参数(限价、交期上限)在这里还能改,
    改完再放出去。厂商面板也有这么一格(待审核 0),但他们实测 0 条 —— 导入后直接
    就是待拍单,那一格形同虚设。我们把它保留成一个真闸口。
    """
    t = _task(conn, task_id)
    if t["status"] != "pending":
        raise AdminRefused("BAD_STATUS", f"只有待放行能放行,当前是 {t['status']}")
    conn.execute("UPDATE procure.tasks SET status='ready', updated_at=now() WHERE id = %s",
                 (task_id,))
    task_event.record(conn, task_id, "admin",
                      payload={"action": "release", "operator": operator})
    return {"task_id": task_id, "status": "ready"}


def batch_reset(conn, task_ids: list[int], *, operator: str | None = None) -> dict[str, Any]:
    """输入:一批任务 id → 输出:{done, skipped, failed} 三份逐条清单。

    **这个接口不接受 acknowledged,永远不接受。**

    单条重置那道 `NEEDS_ACK` 闸拦的是「这一单可能已经在 Amazon 上真下成了」,
    而回执的含义是**有人去那个买家号的订单页看过了**。一批 30 单给一个总的
    「已确认」,那句话就成了假的 —— 没人一单一单看过 30 个订单页。
    真让它接受,这个按钮就从「省点击」变成「一键重复下单 30 次」。

    所以这里的规矩是:能重的都重了,不能重的**原样报回来**,让人逐条去点。
    报回来的那几条带上错误码与「越没越过下单点」,人一眼能看出该先去哪儿确认 ——
    后者是因为这两件事**不是同一件**:码在 POSSIBLY_ORDERED 里是一种,
    码看着人畜无害(PLUGIN_INTERNAL)而下单按钮已经点过了是另一种。

    一条失败不牵连其它 —— 每条各自提交。批量动作里最难查的就是
    「前 12 条成了、第 13 条炸了、后面 17 条没跑」,而界面只说了一句「失败」。
    """
    done: list[int] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []

    for task_id in task_ids:
        try:
            reset_to_queue(conn, task_id, acknowledged=False, operator=operator)
            done.append(task_id)
        except AdminRefused as exc:
            row = conn.execute(
                "SELECT upstream_order_no, status, error_code, may_have_ordered "
                "  FROM procure.tasks WHERE id = %s",
                (task_id,)).fetchone()
            item = {
                "task_id": task_id,
                "upstream_order_no": row["upstream_order_no"] if row else None,
                "status": row["status"] if row else None,
                "error_code": row["error_code"] if row else None,
                # 被跳过的那几条要说清是**因为什么**被跳过的:一条错误码在
                # RETRYABLE 里、却因为越过下单点被拦下的单,只报错误码的话,
                # 看的人第一反应是「这不就是重一下就过的那种吗,系统是不是抽了」。
                "may_have_ordered": bool(row["may_have_ordered"]) if row else False,
                "code": exc.code,
                "message": exc.message,
            }
            # NEEDS_ACK 不是「失败」,是「这一条得你亲自去看」—— 界面要分开说,
            # 混进失败里会让人以为系统出了问题,于是重试,于是绕过那道闸。
            (skipped if exc.code == "NEEDS_ACK" else failed).append(item)

    return {"done": done, "skipped": skipped, "failed": failed,
            "counts": {"done": len(done), "skipped": len(skipped), "failed": len(failed)}}
