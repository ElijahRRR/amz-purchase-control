"""实例注册与心跳。"""

from fastapi import APIRouter, Depends, HTTPException

from registry import settings
from server import schemas
from server.deps import conn_ctx
from services import instance

router = APIRouter(prefix="/v1/instances", tags=["instances"])


@router.post("/register")
def register(req: schemas.RegisterReq, conn=Depends(conn_ctx)) -> schemas.Envelope:
    try:
        row = instance.register(
            conn, env_code=req.env_code, instance_uid=req.instance_uid,
            plugin_version=req.plugin_version,
        )
    except LookupError as exc:
        raise HTTPException(404, detail={"code": "ENV_NOT_FOUND", "message": str(exc)})
    return schemas.Envelope(ok=True, data={
        "instance_id": row["id"],
        "buyer_env_id": row["buyer_env_id"],
        "env_status": row["env_status"],
    })


@router.post("/heartbeat")
def heartbeat(req: schemas.HeartbeatReq, conn=Depends(conn_ctx)) -> schemas.Envelope:
    """心跳,顺带收登录态、回一句「该不该去复检登录态」。

    `login_check_due` 是服务端给插件的回话:这个买家号有单在等,而上次读页面
    已经超过 `AMZ_LOGIN_RECHECK_MIN` 分钟了,下一轮认领前去读一次导航栏。
    策略放在服务端是因为它可调、且「有没有单在等」只有服务端知道 ——
    插件要自己问出这件事,唯一的办法是先认领一单,而先认领恰恰是要避免的动作。
    """
    row = instance.heartbeat(
        conn,
        instance_uid=req.instance_uid,
        login_state=req.login_state,
        recheck_minutes=settings.login_recheck_minutes(),
    )
    if row is None:
        raise HTTPException(404, detail={"code": "INSTANCE_NOT_REGISTERED",
                                         "message": f"实例未注册:{req.instance_uid}"})
    return schemas.Envelope(ok=True, data={
        "alive": True,
        # 把服务端最终记下的那一位回给插件。插件报什么、服务端记什么,
        # 两边对不上时(比如插件是旧版根本不报)在日志里一眼看得出来。
        "login_state": row["login_state"],
        "login_check_due": row["login_check_due"],
    })
