"""物流回传落库。

只存结构化事件,**不存整页 HTML** —— 厂商回传整页 HTML + 内联全站 CSS,
单请求可达 MB 级(分析 §A13)。要凭证时按需重抓。
"""

from typing import Any

PENDING_SQL = """
SELECT t.id            AS task_id,
       t.amazon_order_no,
       t.upstream_order_no,
       s.tracking_url
  FROM procure.tasks t
  LEFT JOIN logistics.shipments s ON s.task_id = t.id
 WHERE t.buyer_env_id = %(env_id)s
   AND t.status = 'purchased'
   AND t.amazon_order_no IS NOT NULL
   -- 已签收/已取消的不再进队列:它们不会再变了
   AND (s.status IS NULL OR s.status NOT IN ('delivered', 'cancelled'))
   -- 刚同步过的先放放。Amazon 的轨迹一天更新不了几次,盯太紧只是白开 iframe
   AND (s.updated_at IS NULL
        OR s.updated_at < now() - make_interval(mins => %(resync_min)s))
 ORDER BY COALESCE(s.updated_at, t.purchased_at) NULLS FIRST
 LIMIT %(limit)s
"""


def pending(conn, *, env_id: int, resync_minutes: int, limit: int) -> list[dict[str, Any]]:
    """输入:买家号 + 重同步间隔 + 条数 → 输出:该买家号下待同步物流的单。

    只给这个买家号自己的单 —— 订单详情页只有登录着那个号才打得开。
    """
    return [dict(r) for r in conn.execute(
        PENDING_SQL, {"env_id": env_id, "resync_min": resync_minutes, "limit": limit}
    ).fetchall()]


def sync(conn, *, task_id: int, carrier: str | None, tracking_no: str | None,
         tracking_url: str | None, status: str | None,
         events: list[dict[str, Any]]) -> int:
    """输入:连接 + 任务 id + 运单信息 + 轨迹事件列表 → 输出:shipment id。

    同一任务重复回传按 task_id upsert;事件整批替换(Amazon 侧是全量快照,
    增量合并只会制造重复行)。events 按传入顺序编号,index 0 = 最新。
    """
    row = conn.execute(
        "SELECT id FROM logistics.shipments WHERE task_id = %s", (task_id,)
    ).fetchone()
    if row is None:
        row = conn.execute(
            """
            INSERT INTO logistics.shipments (task_id, carrier, tracking_no, tracking_url,
                                             status, delivered_at, updated_at)
            VALUES (%(task_id)s, %(carrier)s, %(no)s, %(url)s, %(status)s,
                    -- 首次同步时就已经签收的单也要落上签收时间。
                    -- 只在 UPDATE 分支填的话,「一次都没在途过、直接签收」的单
                    -- 永远拿不到 delivered_at,界面上那一栏就是空的。
                    CASE WHEN %(status)s = 'delivered' THEN now() END,
                    now())
            RETURNING id
            """,
            {"task_id": task_id, "carrier": carrier, "no": tracking_no,
             "url": tracking_url, "status": status},
        ).fetchone()
    else:
        conn.execute(
            """
            UPDATE logistics.shipments
               SET carrier = COALESCE(%(carrier)s, carrier),
                   tracking_no = COALESCE(%(no)s, tracking_no),
                   tracking_url = COALESCE(%(url)s, tracking_url),
                   status = COALESCE(%(status)s, status),
                   delivered_at = CASE WHEN %(status)s = 'delivered'
                                       THEN COALESCE(delivered_at, now())
                                       ELSE delivered_at END,
                   updated_at = now()
             WHERE id = %(id)s
            """,
            {"id": row["id"], "carrier": carrier, "no": tracking_no,
             "url": tracking_url, "status": status},
        )
    shipment_id = row["id"]

    conn.execute("DELETE FROM logistics.shipment_events WHERE shipment_id = %s", (shipment_id,))
    for seq, ev in enumerate(events):
        conn.execute(
            """
            INSERT INTO logistics.shipment_events
                   (shipment_id, raw_day, raw_time, description, city, state_code, seq)
            VALUES (%(sid)s, %(day)s, %(time)s, %(desc)s, %(city)s, %(state)s, %(seq)s)
            """,
            {"sid": shipment_id, "day": ev.get("raw_day"), "time": ev.get("raw_time"),
             "desc": ev.get("description"), "city": ev.get("city"),
             "state": ev.get("state_code"), "seq": seq},
        )
    return shipment_id
