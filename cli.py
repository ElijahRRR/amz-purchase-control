#!/usr/bin/env python3
"""cli.py — 全项目唯一命令行入口。

    python cli.py <workflow> [<workflow> ...] [-p key=value ...] [--dry-run]

统一负责(workflow 文件里不做这些):
  加载 <DATA_ROOT>/.env → flock 单实例锁 → 写 ops.runs 运行记录 → 执行 run(params)
  → 退出码(0 成功 / 1 失败 / 3 已有实例在跑)。

串联:workflow 位置参数可给多个,按顺序跑,**前一个失败就不跑后面的**。
这是本项目实现「链」的唯一方式 —— workflow 之间禁止互相 import。

执行语义:**缺省即真跑**,要空跑加 --dry-run。
(理由同 WalmartAPI-Contral:进了调度之后,「缺省 dry-run」只会让那条链每天
空转而且报成功,比误跑更难发现。)
⚠ 但「AI 改完代码必须先 --dry-run,人眼确认输出后才跑真的」这条纪律不取消。
"""

import argparse
import contextlib
import fcntl
import importlib
import json
import os
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

from registry import paths

EXIT_OK, EXIT_FAIL, EXIT_LOCKED = 0, 1, 3


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="cli.py", description="amz-purchase-control 唯一入口")
    p.add_argument("workflow", nargs="+", help="工作流名(可多个,按顺序串联)")
    p.add_argument("-p", "--param", action="append", default=[],
                   help="参数 key=value;只给某一步用 工作流名:key=value")
    p.add_argument("--dry-run", action="store_true", help="空跑,不产生副作用")
    return p.parse_args(argv)


def _split_params(raw: list[str], workflow: str) -> dict:
    """输入:原始 -p 列表 + 当前工作流名 → 输出:该工作流的参数 dict。"""
    out: dict[str, str] = {}
    for item in raw:
        if "=" not in item:
            raise SystemExit(f"参数格式应为 key=value,收到:{item!r}")
        key, value = item.split("=", 1)
        if ":" in key:
            target, key = key.split(":", 1)
            if target != workflow:
                continue
        out[key] = value
    return out


def _load_env() -> None:
    """输入:无 → 输出:无(把 <DATA_ROOT>/.env 读进环境变量)。"""
    env_path = paths.env_file()
    if not env_path.exists():
        return
    from dotenv import load_dotenv

    load_dotenv(env_path)


@contextlib.contextmanager
def _single_instance(workflow: str):
    """输入:工作流名 → 输出:文件锁上下文;拿不到锁抛 BlockingIOError。

    同一工作流不允许并发跑两份 —— 半成品数据比慢更可怕。
    """
    lock_dir = paths.data_root() / "locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    fh = open(lock_dir / f"{workflow}.lock", "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        with contextlib.suppress(Exception):
            fcntl.flock(fh, fcntl.LOCK_UN)
        fh.close()


def _open_run(workflow: str, params: dict, started_at) -> int | None:
    """输入:运行信息 → 输出:ops.runs 的 id(数据库不可用时 None,不阻断执行)。

    **开跑就写一行 `running`**,不是等跑完再补一行。

    早先是跑完才 INSERT 的,后果是:进程中途被杀(容器回收、OOM、机器重启)
    就一行都不写 —— 一次挂死的运行在库里跟「从来没跑过」一模一样。
    偏偏 task_sweep 是全项目唯一必须挂定时的那一条,它挂死正是最该被看见的事。
    schema 里 status 的封闭集本来就写着 running,只是从来没人写过这个值。

    现在中途被杀会留下一行停在 running 的记录,运营台那一页把它标成
    「开跑后再没消息」—— 有痕迹才查得动。
    """
    from registry import db

    try:
        with db.pg_conn() as conn:
            row = conn.execute(
                """
                INSERT INTO ops.runs (workflow, params, started_at, status, operator)
                VALUES (%s, %s, %s, 'running', %s)
                RETURNING id
                """,
                (workflow, json.dumps(params, ensure_ascii=False), started_at,
                 os.environ.get("AMZ_OPERATOR", "manual")),
            ).fetchone()
            return row["id"] if isinstance(row, dict) else row[0]
    except Exception:
        return None


def _close_run(run_id: int | None, workflow: str, params: dict, started_at,
               status: str, summary: str | None):
    """输入:_open_run 给的 id + 结果 → 输出:无(数据库不可用时不阻断执行)。

    开跑那一行没写成(库当时连不上)时补一行完整的 —— 宁可有一行 finished_at
    与 started_at 都对得上的记录,也不要因为开头没记上就把整次运行丢掉。
    """
    from registry import db

    with contextlib.suppress(Exception):
        with db.pg_conn() as conn:
            if run_id is not None:
                conn.execute(
                    """UPDATE ops.runs SET finished_at = now(), status = %s, summary = %s
                        WHERE id = %s""",
                    (status, summary, run_id),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO ops.runs (workflow, params, started_at, finished_at,
                                          status, summary, operator)
                    VALUES (%s, %s, %s, now(), %s, %s, %s)
                    """,
                    (workflow, json.dumps(params, ensure_ascii=False), started_at,
                     status, summary, os.environ.get("AMZ_OPERATOR", "manual")),
                )


def _run_one(workflow: str, params: dict) -> tuple[bool, str]:
    """输入:工作流名 + 参数 → 输出:(是否成功, 结果摘要)。"""
    started_at = datetime.now(timezone.utc)
    try:
        module = importlib.import_module(f"workflows.{workflow}")
    except ModuleNotFoundError as exc:
        # import 失败不写 ops.runs:它压根没开始跑,记一行「失败」会把
        # 「代码有问题」和「这次运行出错了」混成同一件事。
        return False, f"找不到工作流 {workflow}:{exc}"
    run_id = _open_run(workflow, params, started_at)
    try:
        summary = module.run(params) or "(无摘要)"
        _close_run(run_id, workflow, params, started_at, "success", summary)
        return True, summary
    except Exception:
        detail = traceback.format_exc(limit=6)
        _close_run(run_id, workflow, params, started_at, "failed", detail)
        return False, detail


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv if argv is not None else sys.argv[1:])
    _load_env()

    # 打错工作流名要在跑第一步之前就发现,不要跑到一半才报
    for name in args.workflow:
        if not (Path(__file__).parent / "workflows" / f"{name}.py").exists():
            print(f"✗ 未知工作流:{name}", file=sys.stderr)
            return EXIT_FAIL

    for name in args.workflow:
        params = _split_params(args.param, name)
        params["dry_run"] = args.dry_run
        try:
            with _single_instance(name):
                ok, summary = _run_one(name, params)
        except BlockingIOError:
            print(f"✗ {name} 已有实例在跑,停链", file=sys.stderr)
            return EXIT_LOCKED
        prefix = "✓" if ok else "✗"
        print(f"{prefix} {name}: {summary}", file=sys.stdout if ok else sys.stderr)
        if not ok:
            return EXIT_FAIL
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
