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

#: 列表的「详细」密度照厂商那一行做:8 组字段竖着堆在各自格子里(所有者定稿,
#: 「这是订单详情,需要把它作为模板」)。那 8 组里有电话、地址、运费税费、
#: 信用卡尾号、物流单号 —— 都不在原来这条 SELECT 里。
#:
#: 所以这里一次把它们取全,而不是让列表渲染时按行去拉详情:
#: 一屏 50 行就是 50 个请求,而且行是虚拟滚动的,滚一下又是一批。
#: 宽一点的一次查询比 N 次窄查询便宜得多,50 行 × 30 列也就几十 KB。
_LIST_SQL = """
SELECT t.id, t.line_key, t.upstream_order_no, t.marketplace, t.status,
       t.ship_name, t.ship_phone, t.ship_line1,
       t.ship_city, t.ship_state, t.ship_postcode,
       t.price_cap, t.actual_total, t.actual_shipping, t.actual_tax,
       t.payment_last4, t.delivery_date, t.amazon_order_no,
       t.error_code, t.error_detail,
       t.created_at, t.purchased_at,
       e.code AS env_code, e.amazon_customer_id,
       s.carrier, s.tracking_no, s.status AS shipment_status,
       (SELECT json_agg(json_build_object('asin', p.asin, 'quantity', p.quantity,
                                          'image_url', p.image_url,
                                          'actual_unit_price', p.actual_unit_price)
                        ORDER BY p.id)
          FROM procure.task_products p WHERE p.task_id = t.id) AS products
  FROM procure.tasks t
  JOIN procure.buyer_envs e ON e.id = t.buyer_env_id
  -- 一单可能同步过多次轨迹,取最后一条。LATERAL 而不是普通 JOIN:
  -- 普通 JOIN 会把有两条 shipment 的任务在列表里裂成两行,总数也跟着虚高。
  LEFT JOIN LATERAL (
      SELECT carrier, tracking_no, status
        FROM logistics.shipments
       WHERE task_id = t.id ORDER BY id DESC LIMIT 1
  ) s ON TRUE
 WHERE {where}
 ORDER BY t.{order_col} DESC NULLS LAST, t.id DESC
 LIMIT %(limit)s OFFSET %(offset)s
"""

#: 算「哪些号一个都没匹配上」要看全量,不能看分页后的那一页 ——
#: 否则粘 60 个号、每页 50 条时,第 51~60 个命中项会被指着说查不到。
#: 这个字段存在的意义正是「别让运营以为都查到了」,反过来误报比不报更坏。
_FOUND_SQL = """
SELECT t.amazon_order_no, t.upstream_order_no
  FROM procure.tasks t
  JOIN procure.buyer_envs e ON e.id = t.buyer_env_id
 WHERE {where}
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
        hit = conn.execute(_FOUND_SQL.format(where=where), params).fetchall()
        found = {r["amazon_order_no"] for r in hit if r["amazon_order_no"]}
        found |= {r["upstream_order_no"] for r in hit}
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


_SUMMARY_SQL = """
SELECT t.status, count(*) AS n
  FROM procure.tasks t
  JOIN procure.buyer_envs e ON e.id = t.buyer_env_id
 WHERE {where}
 GROUP BY t.status
"""


def summary(
    conn,
    *,
    env_code: str | None = None,
    date_field: str = "created",
    date_from: date | None = None,
    date_to: date | None = None,
) -> dict[str, Any]:
    """输入:除状态外的筛选条件 → 输出:每个状态桶各有多少 + 今日已拍单。

    界面上那排状态筛选是带数字的。数字必须跟**其它筛选条件同步** ——
    选了 env-172 之后,「拍单异常 12」如果还是全局的 12,点进去只看到 3 条,
    运营会以为界面丢了单。所以这里接同一套 env/时间条件,只是不接 status。

    批量单号筛选生效时不该调这个:那时状态桶被盖过了,再显示一排数字是在
    邀请人去点一个点不动的东西。界面在那种情况下把整排藏起来。

    **每个状态都出现,空桶给 0**。SQL 的 GROUP BY 只会吐出有行的状态,
    照直用会让「拍单异常」在清零时从界面上消失 —— 而「异常 0」正是运营最想看到的
    那句话,让它消失等于把好消息也藏了。
    """
    from services import vocab

    if date_field not in ("created", "purchased"):
        raise ValueError(f"date_field 只能是 created / purchased,收到 {date_field!r}")
    order_col = "created_at" if date_field == "created" else "purchased_at"

    clauses = ["TRUE"]
    params: dict[str, Any] = {}
    if env_code:
        clauses.append("e.code = %(env_code)s")
        params["env_code"] = env_code
    if date_from:
        clauses.append(f"t.{order_col} >= %(date_from)s")
        params["date_from"] = date_from
    if date_to:
        clauses.append(f"t.{order_col} < (%(date_to)s::date + 1)")
        params["date_to"] = date_to
    if date_field == "purchased":
        clauses.append("t.purchased_at IS NOT NULL")

    rows = conn.execute(_SUMMARY_SQL.format(where=" AND ".join(clauses)), params).fetchall()
    by_status = {s: 0 for s in vocab.STATUS_LABELS}
    for r in rows:
        by_status[r["status"]] = r["n"]

    # 顶栏那两个数字是**全局**的,不跟着筛选走 —— 它们回答的是「今天整体怎么样」,
    # 筛掉一半再报数就不是那个问题的答案了。
    today = conn.execute(
        "SELECT count(*) AS n FROM procure.tasks "
        " WHERE status = 'purchased' AND purchased_at >= date_trunc('day', now())"
    ).fetchone()["n"]
    queue = conn.execute(
        "SELECT count(*) AS n FROM procure.tasks WHERE status = 'ready'"
    ).fetchone()["n"]

    return {"by_status": by_status, "purchased_today": today, "queue_depth": queue}


_ERROR_STATS_SQL = """
SELECT t.error_code, e.code AS env_code, count(*) AS n
  FROM procure.tasks t
  JOIN procure.buyer_envs e ON e.id = t.buyer_env_id
 WHERE t.error_code IS NOT NULL
   AND t.created_at >= %(date_from)s
   AND t.created_at < (%(date_to)s::date + 1)
 GROUP BY t.error_code, e.code
"""

_ERROR_TREND_SQL = """
SELECT date_trunc('day', t.created_at)::date AS day, t.error_code, count(*) AS n
  FROM procure.tasks t
 WHERE t.error_code IS NOT NULL
   AND t.created_at >= %(date_from)s
   AND t.created_at < (%(date_to)s::date + 1)
 GROUP BY 1, 2
 ORDER BY 1
"""


def error_stats(conn, *, date_from: date, date_to: date) -> dict[str, Any]:
    """输入:时间范围 → 输出:错误码分布(总数 / 分买家号 / 按天)。

    这一页要回答的是「最近在哪儿卡住」。所以三个切面都要:
    总数说明轻重,分买家号说明是不是某一台机器的问题(比如某个买家号被风控了),
    按天说明是一直这样还是昨天开始的 —— 后者往往对应一次亚马逊改版。

    只统计 `error_code` 非空的行。注意它**不等于**失败:走到 `manual` 的单也带码,
    那正是要看的重点。界面按 error_codes 的三个集合(可重试/转人工/可能已下单)分色。
    """
    rows = conn.execute(_ERROR_STATS_SQL, {"date_from": date_from, "date_to": date_to}).fetchall()

    totals: dict[str, int] = {}
    by_env: dict[str, dict[str, int]] = {}
    for r in rows:
        totals[r["error_code"]] = totals.get(r["error_code"], 0) + r["n"]
        by_env.setdefault(r["error_code"], {})[r["env_code"]] = r["n"]

    trend = [
        {"day": r["day"].isoformat(), "code": r["error_code"], "n": r["n"]}
        for r in conn.execute(_ERROR_TREND_SQL,
                              {"date_from": date_from, "date_to": date_to}).fetchall()
    ]
    return {
        "items": [{"code": c, "n": n, "by_env": by_env.get(c, {})}
                  for c, n in sorted(totals.items(), key=lambda kv: -kv[1])],
        "trend": trend,
        "total": sum(totals.values()),
    }
