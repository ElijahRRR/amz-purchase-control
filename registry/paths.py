"""路径接线盒(铁律 3:任何绝对路径只准从这里取)。"""

import os
from pathlib import Path


def data_root() -> Path:
    """输入:无 → 输出:数据根目录(env AMZ_DATA_ROOT 覆盖,默认 ~/.amz-purchase)。

    .env、日志、导出文件都在这个目录下,不进 git。
    """
    return Path(os.environ.get("AMZ_DATA_ROOT", Path.home() / ".amz-purchase"))


def env_file() -> Path:
    """输入:无 → 输出:.env 文件路径(chmod 600,永远不进 git)。"""
    return data_root() / ".env"


def log_dir() -> Path:
    """输入:无 → 输出:日志目录。"""
    return data_root() / "logs"


def repo_root() -> Path:
    """输入:无 → 输出:仓库根目录(用于定位 refdata/schema.sql 这类仓内资源)。"""
    return Path(__file__).resolve().parent.parent
