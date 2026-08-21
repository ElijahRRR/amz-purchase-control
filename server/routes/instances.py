"""实例注册与心跳。"""

from fastapi import APIRouter, Depends, HTTPException

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
    if not instance.heartbeat(conn, instance_uid=req.instance_uid):
        raise HTTPException(404, detail={"code": "INSTANCE_NOT_REGISTERED",
                                         "message": f"实例未注册:{req.instance_uid}"})
    return schemas.Envelope(ok=True, data={"alive": True})
