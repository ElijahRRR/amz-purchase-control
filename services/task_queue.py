"""任务队列:认领、释放、状态流转。

设计取舍(所有者定稿 2026-08-20):
  运营前提是「同一买家号不会在两处同时登录拍单」,因此**不做**跨实例的并发互斥
  (无租约表、无顾问锁、无 per-env 唯一索引)。SKIP LOCKED 保留,它只是避免行锁
  排队,不承担正确性职责。

  claimed 态保留,但职责不是「锁」而是「在途标记」:
    · 供 task_sweep 发现「领走后再没消息」的任务
    · 供后台看清此刻哪些任务在执行
"""

from typing import Any

from services import task_event

CLAIM_SQL = """
WITH candidate AS (
    SELECT t.id
    FROM procure.tasks t
    WHERE t.status = 'ready'
      AND t.buyer_env_id = %(env_id)s
    ORDER BY t.created_at
    FOR UPDATE OF t SKIP LOCKED
    LIMIT 1
)
UPDATE procure.tasks
   SET status = 'claimed',
       claimed_by = %(instance_id)s,
       claimed_at = now(),
       updated_at = now()
  FROM candidate
 WHERE procure.tasks.id = candidate.id
RETURNING procure.tasks.*
"""

PRODUCTS_SQL = """
SELECT asin, quantity FROM procure.task_products
 WHERE task_id = %(task_id)s ORDER BY id
"""

_TERMINAL = frozenset({"purchased", "exception", "manual", "cancelled"})


def claim(conn, env_id: int, instance_id: int) -> dict[str, Any] | None:
    """输入:连接 + 买家环境 id + 插件实例 id → 输出:任务 dict(含 products),无可派时 None。

    一条 SQL 完成「选中 + 置位」,不存在「选完还没置位」的窗口。
    """
    row = conn.execute(
        CLAIM_SQL, {"env_id": env_id, "instance_id": instance_id}
    ).fetchone()
    if row is None:
        return None
    row["products"] = conn.execute(PRODUCTS_SQL, {"task_id": row["id"]}).fetchall()
    task_event.record(conn, row["id"], "claimed", instance_id=instance_id)
    return row


def release(conn, task_id: int, instance_id: int | None = None) -> bool:
    """输入:连接 + 任务 id(+实例 id)→ 输出:是否成功退回 ready。

    插件主动放弃(不算失败)。只有仍处于 claimed 的任务才可退回 —— 已经流转到
    终态的任务不允许被一个迟到的 release 拉回队列。
    """
    row = conn.execute(
        """
        UPDATE procure.tasks
           SET status = 'ready', claimed_by = NULL, claimed_at = NULL, updated_at = now()
         WHERE id = %(task_id)s AND status = 'claimed'
        RETURNING id
        """,
        {"task_id": task_id},
    ).fetchone()
    if row is None:
        return False
    task_event.record(conn, task_id, "released", instance_id=instance_id)
    return True


def fail(
    conn,
    task_id: int,
    error_code: str,
    *,
    instance_id: int | None = None,
    detail: str | None = None,
    to_manual: bool = False,
) -> bool:
    """输入:连接 + 任务 id + 结构化错误码(+详情/是否转人工)→ 输出:是否写入成功。

    to_manual=True 用于「可能已经在 Amazon 上产生了订单」的场景(如下单后未见确认页),
    这类任务不能自动重试,必须人工确认。
    """
    status = "manual" if to_manual else "exception"
    row = conn.execute(
        """
        UPDATE procure.tasks
           SET status = %(status)s, error_code = %(code)s, error_detail = %(detail)s,
               claimed_by = NULL, claimed_at = NULL, updated_at = now()
         WHERE id = %(task_id)s AND status = 'claimed'
        RETURNING id
        """,
        {"task_id": task_id, "status": status, "code": error_code, "detail": detail},
    ).fetchone()
    if row is None:
        return False
    task_event.record(
        conn, task_id, "error", instance_id=instance_id, code=error_code,
        payload={"detail": detail, "to_manual": to_manual},
    )
    return True


def complete(
    conn,
    task_id: int,
    *,
    amazon_order_no: str,
    instance_id: int | None = None,
    totals: dict[str, Any] | None = None,
) -> bool:
    """输入:连接 + 任务 id + Amazon 订单号(+金额/交期)→ 输出:是否写入成功。

    totals 可含 actual_total / actual_shipping / actual_tax / payment_last4 /
    delivery_date / delivery_raw。
    """
    t = totals or {}
    row = conn.execute(
        """
        UPDATE procure.tasks
           SET status = 'purchased',
               amazon_order_no = %(order_no)s,
               actual_total    = %(actual_total)s,
               actual_shipping = %(actual_shipping)s,
               actual_tax      = %(actual_tax)s,
               payment_last4   = %(payment_last4)s,
               delivery_date   = %(delivery_date)s,
               delivery_raw    = %(delivery_raw)s,
               purchased_at    = now(),
               claimed_by = NULL, claimed_at = NULL, updated_at = now()
         WHERE id = %(task_id)s AND status = 'claimed'
        RETURNING id
        """,
        {
            "task_id": task_id,
            "order_no": amazon_order_no,
            "actual_total": t.get("actual_total"),
            "actual_shipping": t.get("actual_shipping"),
            "actual_tax": t.get("actual_tax"),
            "payment_last4": t.get("payment_last4"),
            "delivery_date": t.get("delivery_date"),
            "delivery_raw": t.get("delivery_raw"),
        },
    ).fetchone()
    if row is None:
        return False
    task_event.record(
        conn, task_id, "purchased", instance_id=instance_id,
        payload={"amazon_order_no": amazon_order_no, **t},
    )
    return True


def sweep_stale(conn, timeout_minutes: int) -> list[int]:
    """输入:连接 + 超时分钟数 → 输出:被转为 manual 的任务 id 列表。

    claimed 超时**不退回 ready**:插件可能已经在 Amazon 上真下了单,只是没来得及
    回传。自动重试会造成重复下单,所以一律转人工确认。
    """
    rows = conn.execute(
        """
        UPDATE procure.tasks
           SET status = 'manual', error_code = 'CLAIM_TIMEOUT',
               error_detail = %(detail)s, updated_at = now()
         WHERE status = 'claimed'
           AND claimed_at < now() - make_interval(mins => %(mins)s)
        RETURNING id
        """,
        {"mins": timeout_minutes, "detail": f"领取后 {timeout_minutes} 分钟无回传"},
    ).fetchall()
    ids = [r["id"] for r in rows]
    for tid in ids:
        task_event.record(conn, tid, "error", code="CLAIM_TIMEOUT")
    return ids
