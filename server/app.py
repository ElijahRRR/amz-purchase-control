"""FastAPI 应用:插件的 HTTP 入口。

铁律 1:server/ 与 workflows/ 同层,都是入口。这里只做请求校验 + 调 services,
**不写业务判断**,**不 import workflows**。

启动:python -m uvicorn server.app:app --host 127.0.0.1 --port 8781
不做鉴权(所有者定稿),默认只监听本机。
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse

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
# 生产就是 `npm run build` 出来的静态文件,由这里发出去。
#
# **每次请求都看一眼磁盘,不在 import 时定死。**
# 定死的话:先起服务、再 npm run build,刷新浏览器仍然是「还没构建」,
# 而提示让你去做的正是你刚做完的那件事 —— 你得先知道要重启服务才想得通。
# 这个服务是本机开发/运维用的,一次 stat 换掉这种坑,划算得离谱。
_WEB_DIST = paths.repo_root() / "web" / "dist"


def _not_built() -> JSONResponse:
    return JSONResponse(status_code=503, content={
        "ok": False, "data": None,
        "error": {"code": "WEB_NOT_BUILT",
                  "message": "运营台还没构建。cd web && npm install && npm run build;"
                             "开发期直接用 npm run dev(它会把 /v1 代到本进程)。"},
    })


@app.get("/assets/{path:path}", include_in_schema=False)
def _asset(path: str):
    """构建产物。文件名带内容哈希,所以可以放心让浏览器长期缓存。"""
    target = (_WEB_DIST / "assets" / path).resolve()
    # 路径穿越:`../../etc/passwd` 这类。这个服务只监听 127.0.0.1、
    # 前面也没有反向代理,但一个照着 URL 拼路径的读文件接口不该靠部署方式来兜底。
    if not target.is_file() or not target.is_relative_to((_WEB_DIST / "assets").resolve()):
        raise HTTPException(404, detail="asset not found")
    return FileResponse(target, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/", include_in_schema=False)
def _index():
    index = _WEB_DIST / "index.html"
    if not index.is_file():
        return _not_built()
    # index.html 不能缓存:里面写着带哈希的资源名,缓存住它等于把新版本挡在门外。
    return FileResponse(index, headers={"Cache-Control": "no-store"})
