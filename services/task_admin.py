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
        "SELECT id, status, error_code, amazon_order_no FROM procure.tasks WHERE id = %s",
        (task_id,),
    ).fetchone()
    if row is None:
        raise AdminRefused("TASK_NOT_FOUND", f"任务 {task_id} 不存在")
    return dict(row)


def reset_to_queue(conn, task_id: int, *, acknowledged: bool = False,
                   operator: str | None = None) -> dict[str, Any]:
    """输入:任务 id(+ 是否已确认过)→ 输出:{task_id, status}。

    exception 可以直接重置。manual 要看是什么原因转过来的:
    如果错误码属于「可能已经在 Amazon 上真下了单」那一类,重置就是让下一个实例
    把同一单再买一遍 —— 必须先有人去买家号里确认过,acknowledged 就是那一步的回执。
    """
    t = _task(conn, task_id)
    if t["status"] not in ("exception", "manual"):
        raise AdminRefused("BAD_STATUS", f"只有拍单异常/待人工能重置,当前是 {t['status']}")

    risky = t["status"] == "manual" and t["error_code"] in error_codes.POSSIBLY_ORDERED
    if risky and not acknowledged:
        raise AdminRefused(
            "NEEDS_ACK",
            f"{t['error_code']} 意味着这一单可能已经真下成了。"
            f"请先去买家号里确认没有这一单,再带 acknowledged 重置。",
        )

    conn.execute(
        """UPDATE procure.tasks
              SET status='ready', error_code=NULL, error_detail=NULL,
                  claimed_by=NULL, claimed_at=NULL, updated_at=now()
            WHERE id = %s""",
        (task_id,),
    )
    task_event.record(conn, task_id, "admin",
                      payload={"action": "reset_to_queue", "from": t["status"],
                               "was_error_code": t["error_code"],
                               "acknowledged": acknowledged, "operator": operator})
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
    if t["status"] in ("purchased", "cancelled"):
        raise AdminRefused("BAD_STATUS", f"{t['status']} 的单不能改地址")

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
    if t["status"] in ("purchased", "cancelled"):
        raise AdminRefused("BAD_STATUS", f"{t['status']} 的单不能改 ASIN")

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
