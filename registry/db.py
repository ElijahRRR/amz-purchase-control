"""数据库连接唯一入口。

工程规范(对齐 WalmartAPI-Contral):禁止在其他任何文件自行 psycopg.connect。
业务数据连 PostgreSQL 17 库 amz_purchase(三 schema 见 docs/db_schema.md)。
"""

import contextlib
import os


def pg_dsn() -> str:
    """输入:无 → 输出:PostgreSQL DSN(env AMZ_PG_DSN 覆盖,默认本机 socket 连 amz_purchase)。"""
    return os.environ.get("AMZ_PG_DSN", "dbname=amz_purchase")


@contextlib.contextmanager
def pg_conn(autocommit: bool = False):
    """输入:(可选 autocommit)→ 输出:psycopg 连接上下文;总是 close。

    默认事务模式:正常退出 commit,异常 rollback。

    用法:
        with db.pg_conn() as conn:
            conn.execute("INSERT ...", (...,))
    """
    import psycopg

    conn = psycopg.connect(pg_dsn(), autocommit=autocommit, row_factory=_dict_row())
    try:
        yield conn
        if not autocommit:
            conn.commit()
    except BaseException:
        if not autocommit:
            conn.rollback()
        raise
    finally:
        conn.close()


def _dict_row():
    """输入:无 → 输出:psycopg dict_row 工厂(查询结果按列名取,不按位置)。

    按位置取列是 WalmartAPI-Contral 分析里反复出现的错位来源,这里从连接层就断掉。
    """
    from psycopg.rows import dict_row

    return dict_row
