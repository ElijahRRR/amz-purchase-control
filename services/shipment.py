"""物流回传落库。

只存结构化事件,**不存整页 HTML** —— 厂商回传整页 HTML + 内联全站 CSS,
单请求可达 MB 级(分析 §A13)。要凭证时按需重抓。
"""

from typing import Any


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
                                             status, updated_at)
            VALUES (%(task_id)s, %(carrier)s, %(no)s, %(url)s, %(status)s, now())
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
