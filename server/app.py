"""FastAPI 应用:插件的 HTTP 入口。

铁律 1:server/ 与 workflows/ 同层,都是入口。这里只做请求校验 + 调 services,
**不写业务判断**,**不 import workflows**。

启动:python -m uvicorn server.app:app --host 127.0.0.1 --port 8781
不做鉴权(所有者定稿),默认只监听本机。
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from server.routes import instances, shipments, tasks

app = FastAPI(title="amz-purchase-control", version="0.1.0")
app.include_router(instances.router)
app.include_router(tasks.router)
app.include_router(shipments.router)


@app.exception_handler(HTTPException)
def _envelope_error(request, exc: HTTPException):
    """把 HTTPException 统一裹成 {ok:false, error:{code,message}}。

    插件侧只需要认一种响应形状。
    """
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail:
        body = {"ok": False, "data": None, "error": detail}
    else:
        body = {"ok": False, "data": None,
                "error": {"code": f"HTTP_{exc.status_code}", "message": str(detail)}}
    return JSONResponse(status_code=exc.status_code, content=body)


@app.get("/health")
def health():
    return {"ok": True, "data": {"status": "up"}, "error": None}
