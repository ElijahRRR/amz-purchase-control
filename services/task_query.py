"""后台列表与详情的查询。

只读。写操作在 services/task_admin.py。

筛选条件的取舍逐条记在 docs/03-运营台字段对照.md §1 —— 那是照厂商面板
9 个筛选做的对照,谁要谁不要都有理由。
"""

import re
from datetime import date
from typing import Any

from registry import settings

#: Amazon 单号形态。运营手里的表两种号混排是常态,粘进来自动分流,
#: 不该逼人先分好类再贴。
AMZ_ORDER_RE = re.compile(r"^\d{3}-\d{7}-\d{7}$")

_LIST_SQL = """
SELECT t.id, t.line_key, t.upstream_order_no, t.marketplace, t.status,
       t.ship_name, t.ship_city, t.ship_state, t.ship_postcode,
       t.price_cap, t.actual_total, t.amazon_order_no,
       t.error_code, t.error_detail,
       t.created_at, t.purchased_at,
       e.code AS env_code,
       (SELECT json_agg(json_build_object('asin', p.asin, 'quantity', p.quantity,
                                          'image_url', p.image_url,
                                          'actual_unit_price', p.actual_unit_price)
                        ORDER BY p.id)
          FROM procure.task_products p WHERE p.task_id = t.id) AS products
  FROM procure.tasks t
  JOIN procure.buyer_envs e ON e.id = t.buyer_env_id
 WHERE {where}
 ORDER BY t.{order_col} DESC NULLS LAST, t.id DESC
 LIMIT %(limit)s OFFSET %(offset)s
"""

_COUNT_SQL = """
SELECT count(*) AS n
  FROM procure.tasks t
  JOIN procure.buyer_envs e ON e.id = t.buyer_env_id
 WHERE {where}
"""


def split_order_numbers(raw: str | list[str] | None) -> tuple[list[str], list[str]]:
    """输入:粘进来的一沓单号(每行一个)→ 输出:(AMZ 单号, 上游单号) 两组。

    形如 111-xxxxxxx-xxxxxxx 的按 AMZ 单号查,其余按上游单号查。
    """
    if raw is None:
        return [], []
    lines = raw.splitlines() if isinstance(raw, str) else list(raw)
    amz, upstream = [], []
    for line in lines:
        s = line.strip()
        if not s:
            continue
        (amz if AMZ_ORDER_RE.match(s) else upstream).append(s)
    return amz, upstream


def search(
    conn,
    *,
    status: str | None = None,
    env_code: str | None = None,
    date_field: str = "created",
    date_from: date | None = None,
    date_to: date | None = None,
    order_numbers: list[str] | None = None,
    asin: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> dict[str, Any]:
    """输入:筛选条件 → 输出:{items, total, page, page_size, missing_order_numbers}。

    单号筛选一旦生效就**盖过状态桶与时间范围**:按号找单的人是来找特定几张单的,
    不是来做统计的。并且会把「一个都没匹配上的号」原样报回去 —— 厂商面板在这里
    是静默的,粘 100 个号回来 87 条,运营不会知道少了哪 13 个。
    """
    if date_field not in ("created", "purchased"):
        raise ValueError(f"date_field 只能是 created / purchased,收到 {date_field!r}")
    order_col = "created_at" if date_field == "created" else "purchased_at"

    page = max(1, page)
    page_size = max(1, min(page_size, settings.admin_page_size_max()))

    clauses = ["TRUE"]
    params: dict[str, Any] = {"limit": page_size, "offset": (page - 1) * page_size}

    amz, upstream = split_order_numbers(order_numbers)
    by_number = bool(amz or upstream)

    if by_number:
        clauses.append("(t.amazon_order_no = ANY(%(amz)s) OR t.upstream_order_no = ANY(%(upstream)s))")
        params["amz"] = amz
        params["upstream"] = upstream
    else:
        if status:
            clauses.append("t.status = %(status)s")
            params["status"] = status
        if env_code:
            clauses.append("e.code = %(env_code)s")
            params["env_code"] = env_code
        if date_from:
            clauses.append(f"t.{order_col} >= %(date_from)s")
            params["date_from"] = date_from
        if date_to:
            # 到日期的当天结束。用 < 次日零点而不是 <= 当日,免得漏掉当天下午的单。
            clauses.append(f"t.{order_col} < (%(date_to)s::date + 1)")
            params["date_to"] = date_to
        if date_field == "purchased":
            # 按采购时间筛,本来就是在问「哪些单已经买了」。没下过单的行不在这个维度上。
            clauses.append("t.purchased_at IS NOT NULL")

    if asin:
        clauses.append("EXISTS (SELECT 1 FROM procure.task_products p "
                       "WHERE p.task_id = t.id AND p.asin = %(asin)s)")
        params["asin"] = asin

    where = " AND ".join(clauses)
    items = conn.execute(_LIST_SQL.format(where=where, order_col=order_col), params).fetchall()
    total = conn.execute(_COUNT_SQL.format(where=where), params).fetchone()["n"]

    missing: list[str] = []
    if by_number:
        found = {r["amazon_order_no"] for r in items if r["amazon_order_no"]}
        found |= {r["upstream_order_no"] for r in items}
        missing = [n for n in (amz + upstream) if n not in found]

    return {
        "items": [dict(r) for r in items],
        "total": total,
        "page": page,
        "page_size": page_size,
        "by_order_number": by_number,
        "missing_order_numbers": missing,
    }


_DETAIL_SQL = """
SELECT t.*, e.code AS env_code, e.amazon_customer_id,
       i.instance_uid AS claimed_by_uid
  FROM procure.tasks t
  JOIN procure.buyer_envs e ON e.id = t.buyer_env_id
  LEFT JOIN procure.plugin_instances i ON i.id = t.claimed_by
 WHERE t.id = %(task_id)s
"""


def detail(conn, task_id: int) -> dict[str, Any] | None:
    """输入:任务 id → 输出:整单全貌(含商品、事件流、物流);不存在返回 None。"""
    row = conn.execute(_DETAIL_SQL, {"task_id": task_id}).fetchone()
    if row is None:
        return None
    out = dict(row)
    out["products"] = [dict(r) for r in conn.execute(
        "SELECT asin, quantity, actual_unit_price, image_url FROM procure.task_products "
        " WHERE task_id = %(task_id)s ORDER BY id", {"task_id": task_id}).fetchall()]
    # 事件带上是哪个实例干的。tasks.claimed_by 是**在途指针**,任务一落终态就清空 ——
    # 「此刻谁拿着」和「当初谁执行的」是两回事,后者属于历史,历史在事件流里。
    # 界面上那一格(买家号信息 · 认领实例)要的是后者。
    out["events"] = [dict(r) for r in conn.execute(
        """SELECT e.kind, e.code, e.payload, e.created_at, i.instance_uid
             FROM procure.task_events e
             LEFT JOIN procure.plugin_instances i ON i.id = e.instance_id
            WHERE e.task_id = %(task_id)s
            ORDER BY e.created_at, e.id""", {"task_id": task_id}).fetchall()]

    # 顺手给一个现成的:这一单是谁跑的。取最后一次认领的那个实例 ——
    # 重置回队列后被另一个实例领走的话,最后那次才算数。
    out["executed_by_uid"] = next(
        (e["instance_uid"] for e in reversed(out["events"])
         if e["kind"] == "claimed" and e["instance_uid"]), None)
    ship = conn.execute(
        "SELECT carrier, tracking_no, tracking_url, status, delivered_at "
        "  FROM logistics.shipments WHERE task_id = %(task_id)s ORDER BY id DESC LIMIT 1",
        {"task_id": task_id}).fetchone()
    out["shipment"] = dict(ship) if ship else None
    return out
