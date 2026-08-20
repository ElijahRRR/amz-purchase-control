"""配置接线盒(铁律 3:任何可调参数只准从这里取,不准散落在业务代码里)。"""

import os


def claim_timeout_minutes() -> int:
    """输入:无 → 输出:claimed 超时分钟数,超过则由 task_sweep 转 manual。

    插件领走任务后若这么久还没回传,判定为异常中断。保守起见转 manual 而不是
    退回 ready —— 插件可能已经在 Amazon 上真下了单,只是没来得及回传。
    """
    return int(os.environ.get("AMZ_CLAIM_TIMEOUT_MIN", "15"))


def server_host() -> str:
    """输入:无 → 输出:HTTP 服务监听地址(默认仅本机,不做鉴权的前提)。"""
    return os.environ.get("AMZ_SERVER_HOST", "127.0.0.1")


def server_port() -> int:
    """输入:无 → 输出:HTTP 服务端口。"""
    return int(os.environ.get("AMZ_SERVER_PORT", "8781"))
