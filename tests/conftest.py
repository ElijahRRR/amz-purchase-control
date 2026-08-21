"""测试夹具:每个测试用例一个干净的库(建库 → 用完丢弃)。

需要一个可连的 PostgreSQL 17。用 AMZ_TEST_ADMIN_DSN 指向管理库(默认 dbname=postgres),
测试会在其上 CREATE DATABASE / DROP DATABASE。连不上就整体 skip。
"""

import os
import uuid

import pytest

from registry import paths


def _admin_dsn() -> str:
    return os.environ.get("AMZ_TEST_ADMIN_DSN", "dbname=postgres")


@pytest.fixture(scope="session")
def _psycopg():
    return pytest.importorskip("psycopg")


@pytest.fixture()
def conn(_psycopg):
    """输入:无 → 输出:已建好表的 psycopg 连接(dict_row);用完删库。"""
    psycopg = _psycopg
    dbname = f"amz_test_{uuid.uuid4().hex[:12]}"
    try:
        admin = psycopg.connect(_admin_dsn(), autocommit=True)
    except Exception as exc:  # 没有可用数据库时整体跳过,不算失败
        pytest.skip(f"连不上 PostgreSQL({_admin_dsn()}): {exc}")
    try:
        admin.execute(f'CREATE DATABASE "{dbname}"')
    finally:
        admin.close()

    base = _admin_dsn().replace("dbname=postgres", f"dbname={dbname}")
    os.environ["AMZ_PG_DSN"] = base
    schema = (paths.repo_root() / "refdata" / "schema.sql").read_text(encoding="utf-8")

    from psycopg.rows import dict_row

    c = psycopg.connect(base, row_factory=dict_row)
    c.execute(schema)
    c.commit()
    try:
        yield c
    finally:
        c.close()
        admin = psycopg.connect(_admin_dsn(), autocommit=True)
        try:
            admin.execute(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)')
        finally:
            admin.close()


@pytest.fixture()
def seed(conn):
    """输入:conn → 输出:(env_id, instance_id, [task_id...]) 三元组。"""
    env = conn.execute(
        "INSERT INTO procure.buyer_envs (code) VALUES ('env-172') RETURNING id"
    ).fetchone()
    inst = conn.execute(
        """INSERT INTO procure.plugin_instances (buyer_env_id, instance_uid)
           VALUES (%s,'inst-A') RETURNING id""",
        (env["id"],),
    ).fetchone()
    task_ids = []
    for i in range(3):
        t = conn.execute(
            """INSERT INTO procure.tasks
                 (line_key, upstream_order_no, buyer_env_id, ship_name, ship_phone,
                  ship_line1, ship_city, ship_state, ship_postcode, price_cap, status)
               VALUES (%s,%s,%s,'Name','5550001','1 Main St','Santa Ana','CA','92707',
                       12.50,'ready')
               RETURNING id""",
            (f"key-{i}", f"UP-{i}", env["id"]),
        ).fetchone()
        conn.execute(
            """INSERT INTO procure.task_products (task_id, asin, quantity)
               VALUES (%s,'B0FB3VS68J',1)""",
            (t["id"],),
        )
        task_ids.append(t["id"])
    conn.commit()
    return env["id"], inst["id"], task_ids


@pytest.fixture()
def client(conn, monkeypatch):
    """输入:conn → 输出:FastAPI TestClient,复用测试库连接。

    覆盖 server.deps.conn_ctx,让路由用同一条测试连接(否则路由会另开连接连到
    默认库,测试之间互相污染)。
    """
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from server import app as app_module
    from server import deps

    def _override():
        # 必须复刻 registry.db.pg_conn 的事务语义:正常提交、异常回滚。
        # 否则「路由里写完库再 raise」这类 bug 在测试里会假通过 ——
        # 真实环境下那次写会被 pg_conn 的 rollback 吞掉(2026-08-21 实跑发现)。
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise

    app_module.app.dependency_overrides[deps.conn_ctx] = _override
    try:
        yield TestClient(app_module.app)
    finally:
        app_module.app.dependency_overrides.clear()
