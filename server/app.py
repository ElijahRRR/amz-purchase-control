"""FastAPI 应用:插件的 HTTP 入口。

铁律 1:server/ 与 workflows/ 同层,都是入口。这里只做请求校验 + 调 services,
**不写业务判断**,**不 import workflows**。

启动:python -m uvicorn server.app:app --host 127.0.0.1 --port 8781
不做鉴权(所有者定稿),默认只监听本机。
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from registry import paths
from server.routes import admin, instances, shipments, tasks

app = FastAPI(title="amz-purchase-control", version="0.1.0")
app.include_router(instances.router)
app.include_router(tasks.router)
app.include_router(shipments.router)
app.include_router(admin.router)


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


# ── 运营台前端 ──────────────────────────────────────────────────────────
#
# 开发时不走这里:`npm run dev` 起 Vite,由它把 /v1 代理到本进程
# (走代理而不是开 CORS —— 这个服务不做鉴权、只监听 127.0.0.1,
#  给它加一个宽松的跨域白名单是白送风险面)。
#
# 生产就是 `npm run build` 出来的静态文件,由这里挂上。
# 没 build 过就不挂,并且**说出来** —— 静默挂一个 404 的根路径会让人
# 以为服务坏了,其实只是前端没构建。
_WEB_DIST = paths.repo_root() / "web" / "dist"

if _WEB_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=_WEB_DIST / "assets"), name="assets")

    @app.get("/")
    def _index():
        return FileResponse(_WEB_DIST / "index.html")
else:
    @app.get("/")
    def _no_web():
        return JSONResponse(status_code=503, content={
            "ok": False, "data": None,
            "error": {"code": "WEB_NOT_BUILT",
                      "message": "运营台还没构建。cd web && npm install && npm run build;"
                                 "开发期直接用 npm run dev(它会把 /v1 代到本进程)。"},
        })
