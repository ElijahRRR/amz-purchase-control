"""插件实例登记与心跳。

不发凭据、不做鉴权(所有者定稿)。instance_uid 由插件首次启动生成并持久化,
服务端按它认人;重复注册幂等。
"""

from typing import Any


def register(conn, *, env_code: str, instance_uid: str, plugin_version: str | None) -> dict[str, Any]:
    """输入:连接 + 环境名 + 实例唯一号(+插件版本)→ 输出:实例 dict(含 buyer_env_id)。

    环境不存在时抛 LookupError —— 买家号必须先在后台登记,插件不能凭空创建产能通道。
    """
    env = conn.execute(
        "SELECT id, status FROM procure.buyer_envs WHERE code = %s", (env_code,)
    ).fetchone()
    if env is None:
        raise LookupError(f"买家号环境不存在:{env_code}")

    row = conn.execute(
        """
        INSERT INTO procure.plugin_instances (buyer_env_id, instance_uid, plugin_version,
                                              last_seen_at)
        VALUES (%(env_id)s, %(uid)s, %(ver)s, now())
        ON CONFLICT (instance_uid) DO UPDATE
           SET buyer_env_id   = EXCLUDED.buyer_env_id,
               plugin_version = EXCLUDED.plugin_version,
               last_seen_at   = now()
        RETURNING id, buyer_env_id, instance_uid, plugin_version
        """,
        {"env_id": env["id"], "uid": instance_uid, "ver": plugin_version},
    ).fetchone()
    row["env_status"] = env["status"]
    return row


def heartbeat(conn, *, instance_uid: str) -> bool:
    """输入:连接 + 实例唯一号 → 输出:是否找到该实例。"""
    row = conn.execute(
        """UPDATE procure.plugin_instances SET last_seen_at = now()
            WHERE instance_uid = %s RETURNING id""",
        (instance_uid,),
    ).fetchone()
    return row is not None


def resolve(conn, instance_uid: str) -> dict[str, Any] | None:
    """输入:连接 + 实例唯一号 → 输出:{id, buyer_env_id, env_status};不存在返回 None。"""
    return conn.execute(
        """
        SELECT i.id, i.buyer_env_id, e.status AS env_status
          FROM procure.plugin_instances i
          JOIN procure.buyer_envs e ON e.id = i.buyer_env_id
         WHERE i.instance_uid = %s
        """,
        (instance_uid,),
    ).fetchone()


LIST_SQL = """
SELECT e.id            AS env_id,
       e.code          AS env_code,
       e.marketplace,
       e.status        AS env_status,
       e.amazon_customer_id,
       e.daily_cap,
       i.instance_uid,
       i.plugin_version,
       i.last_seen_at,
       (SELECT count(*) FROM procure.tasks t
         WHERE t.buyer_env_id = e.id AND t.status = 'ready')     AS queue_depth,
       (SELECT count(*) FROM procure.tasks t
         WHERE t.buyer_env_id = e.id AND t.status = 'manual')    AS manual_count,
       (SELECT count(*) FROM procure.tasks t
         WHERE t.buyer_env_id = e.id AND t.status = 'purchased'
           AND t.purchased_at >= date_trunc('day', now()))       AS purchased_today
  FROM procure.buyer_envs e
  LEFT JOIN LATERAL (
        SELECT * FROM procure.plugin_instances pi
         WHERE pi.buyer_env_id = e.id
         ORDER BY pi.last_seen_at DESC NULLS LAST, pi.id DESC
         LIMIT 1
  ) i ON TRUE
 ORDER BY e.code
"""


def list_with_liveness(conn, *, stale_seconds: int) -> list[dict]:
    """输入:连接 + 判活阈值 → 输出:每个买家号一行,带 liveness。

    liveness 是**算出来的**,不是库里的列:
      never   从来没注册过插件(上游建了买家号,机器上还没装)
      online  心跳还新鲜
      stale   有过心跳但超过阈值 —— 可能是关了机器,也可能是插件崩了
      paused  运营手动停的,或买家号被风控停用。停止派单,已领的单不动

    暂停用「停」而不是「坏」来表达:停着不等于坏了,两者的处置方式完全不同。
    """
    out = []
    for r in conn.execute(LIST_SQL).fetchall():
        row = dict(r)
        if row["env_status"] != "active":
            liveness = "paused"
        elif row["last_seen_at"] is None:
            liveness = "never"
        else:
            age = conn.execute(
                "SELECT EXTRACT(EPOCH FROM (now() - %s))::int AS s", (row["last_seen_at"],)
            ).fetchone()["s"]
            row["last_seen_age_seconds"] = age
            liveness = "online" if age <= stale_seconds else "stale"
        row["liveness"] = liveness
        row["dispatchable"] = liveness == "online"
        out.append(row)
    return out
