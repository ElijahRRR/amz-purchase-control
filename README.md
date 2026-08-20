# amz-purchase-control

Amazon 采购自动化:**服务端派单 + 浏览器插件在防关联环境内执行**。

- 服务端 Python 3.12 / FastAPI / PostgreSQL 17 / psycopg 3(裸 SQL,无 ORM)
- 插件 Chrome MV3(TypeScript + Vite)
- 首期仅 US 站

## 快速开始

```bash
# 1. 建库
createdb amz_purchase
python cli.py db_init

# 2. 跑测试
export AMZ_TEST_ADMIN_DSN="dbname=postgres"
python -m pytest -q
```

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `AMZ_PG_DSN` | `dbname=amz_purchase` | 数据库连接串 |
| `AMZ_DATA_ROOT` | `~/.amz-purchase` | .env / 日志 / 锁文件所在目录 |
| `AMZ_CLAIM_TIMEOUT_MIN` | `15` | claimed 超时分钟数 |
| `AMZ_SERVER_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `AMZ_SERVER_PORT` | `8781` | HTTP 端口 |

## 文档

- `CLAUDE.md` —— 项目总纲与铁律,开工前必读
- `docs/01-系统设计.md` —— 架构、数据模型、错误码、护栏、插件时序
- `docs/db_schema.md` —— 表结构唯一事实来源
- `docs/02-schema-验证记录.md` —— 建表与认领算法的实测记录

## 进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | registry + schema.sql + cli.py + services/task_queue | ✅ |
| P1 | server/ 全部端点 + mock 插件 | 待办 |
| P2 | 插件骨架 | 待办 |
| P3 | 拍单主流程 + 单号回填 | 待办 |
| P4 | 护栏 + erp_sync + task_sweep 接线 | 待办 |
| P5 | 物流同步 | 待办 |
