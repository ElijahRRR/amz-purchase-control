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
