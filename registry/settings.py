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


def heartbeat_stale_seconds() -> int:
    """输入:无 → 输出:多久没心跳算离线(秒)。

    插件默认 20 秒一次心跳,连续三次没到才判离线 —— 一次网络抖动不该让运营
    看到一排红点,那样红点就不再有意义了。

    这个值在设计画布上曾标着「等 admin 列表接口落地时一起定」,现在定了。
    """
    return int(os.environ.get("AMZ_HEARTBEAT_STALE_SEC", "60"))


def admin_page_size_max() -> int:
    """输入:无 → 输出:后台列表单页最大条数。

    厂商面板给了 1000~5000 条每页的选项,那不是给人看的,是给浏览器上刑的。
    """
    return int(os.environ.get("AMZ_ADMIN_PAGE_SIZE_MAX", "200"))
