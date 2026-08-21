# amz-purchase-control 项目总纲

> 每个会话开工前必读。本项目做的事:**服务端派单 + 浏览器插件在防关联环境内执行 Amazon 采购**。
> 完整设计见 `docs/01-系统设计.md`,表结构见 `docs/db_schema.md`。
> 工程约定对齐兄弟项目 `WalmartAPI-Contral`。

## 三条铁律(任何代码不得违反)

1. **依赖只准自上而下,严禁反向。**
   ```
   cli.py   ─┐
             ├─→ workflows ─┐
   server/  ─┘              ├─→ services ─→ api ─→ registry
                            │
   ```
   `server/` 与 `workflows/` 同层,**两者都是入口**:都可以调 services 和 api;
   `server` 不准 import `workflows`,任何层不准 import 入口层。
   让 server 去调 workflow 会把 HTTP 接口和调度链焊死。

2. **api 层只做外部接口适配,不写业务判断。**
   出现「如果价格超过限价就…」这类逻辑说明放错层了,应上移到 services。

3. **一切路径、DSN、可调参数只准从 registry 取。**
   任何文件出现硬编码的绝对路径、数据库地址、超时数字,都是违规。

## 业务前提(所有者定稿,设计据此简化)

- **同一买家号不会在两处同时登录拍单。** 因此不做跨实例并发互斥:无租约表、
  无顾问锁、无 per-env 唯一索引。`SKIP LOCKED` 保留,但它只避免行锁排队,
  **不承担正确性职责**。
- **`claimed` 是在途标记,不是锁。** 职责只有两个:让 `task_sweep` 发现
  「领走后再没消息」的任务;让后台看清此刻哪些任务在执行。
- **`price_cap` 由上游 ERP 算好下发**,本系统只取用,不计算。
- **首期只做 US 站。**

## 安全铁律

- **不申请 `cookies` 权限,不上传买家 Cookie。** 登录态留在浏览器 profile 里。
  这不是"暂缓",是架构选择 —— 服务端因此无法脱离操作员浏览器独立下单,这正是
  不想具备的能力。
- **失败必上报、必清车。** 任何终止执行的路径都要调 `/fail` 或 `/release`,
  不允许只写本地日志;`/fail` 之后插件必须清空购物车再释放。
  (厂商插件有 30+ 条只写日志的失败路径,且多数不清车,一次失败连带废掉下一单。)
- **`ORDER_CONFIRM_TIMEOUT` 一律转 manual,不自动重试。** 这种失败意味着
  「可能已经在 Amazon 上真下了单」,重试就是重复下单。
- **路由里只要已经写过库,就不许再 `raise HTTPException`。**
  `registry/db.py` 的 `pg_conn` 遇异常会 rollback,那次写会被一起吞掉。
  要返回错误状态码就 `return JSONResponse(status_code=..., content=...)`。
  (2026-08-21 实跑发现:`complete` 的 ASIN 断言失败路径先写「转 manual」再 raise,
  结果任务卡死在 `claimed`。pytest 当时是**假通过** —— 测试夹具直接给裸连接、
  不复刻 rollback 语义。夹具已修成与 `pg_conn` 一致。)
- **缺省即真跑,空跑加 `--dry-run`。** 改完代码第一次必须先 `--dry-run`,
  人眼确认输出再跑真的。

## 工程规范

- **入口唯一**:命令行走 `python cli.py <workflow>`;插件走 `server/`。
  cli.py 统一负责 加载 .env → flock 单实例锁 → 写 `ops.runs` → 执行 → 退出码。
- **workflow 形态**:每文件只暴露 `run(params) -> str`(结果摘要),不含 argparse,
  不自行处理锁/记录。串联靠 `python cli.py a b c`,**禁止 workflow 互相 import**。
- **数据库连接唯一入口**:只准通过 `registry/db.py`,禁止自行 `psycopg.connect`。
  连接已挂 `dict_row`,**查询结果按列名取,不按位置**。
- **services 新增积木前先通读现有函数确认无重复**;每个函数 docstring 第一行
  写清「输入什么 → 输出什么」。
- **改表流程**:先改 `docs/db_schema.md` → 同步 `refdata/schema.sql` → `cli.py db_init`。
  schema.sql 必须保持幂等(`IF NOT EXISTS`)。
- **表设计约定**:主键一律 `bigint GENERATED ALWAYS AS IDENTITY`(不用 SERIAL);
  封闭集用 `text` + 行内注释(**不用 `CREATE TYPE ... AS ENUM`**);
  时间一律 `timestamptz` 存 UTC;金额一律 `numeric`,不存带货币符号的字符串。
- **错误码是封闭集**,定义在 `docs/01-系统设计.md` §4,由 `services/task_event.py`
  校验。禁止新增自由文本作为失败原因。
- 密钥不进 git:真配置在 `<AMZ_DATA_ROOT>/.env`(chmod 600),仓库里只出现变量名。

## 目录速查

```
cli.py          命令行唯一入口(锁/运行记录/dry-run)
server/         FastAPI 应用,插件的 HTTP 入口(只做请求校验 + 调 services)
workflows/      每文件一个 run(),对应一条可调度的业务链
                db_init / task_intake(上游采购行落库) / task_sweep(认领超时清扫)
services/       跨入口复用的业务积木(先查重再新增)
api/            外部系统适配(上游 ERP、通知)
registry/       接线盒:db.py(连接) paths.py(路径) settings.py(可调参数)
refdata/        schema.sql —— docs/db_schema.md 的可执行幂等镜像
docs/           01-系统设计.md / 02-schema-验证记录.md / db_schema.md
extension/      Chrome MV3 插件(TypeScript + Vite)
tests/          pytest;需要一个可连的 PostgreSQL 17,连不上则整体 skip
```

## 跑测试

```bash
export AMZ_TEST_ADMIN_DSN="dbname=postgres"   # 指向管理库,测试会建/删临时库
python -m pytest -q
```

插件侧自检(不碰 Amazon,要先起服务端):

```bash
cd extension && npm install
npm run typecheck && npm run build      # 打出 dist/,可直接加载进 Chrome
npm run smoke                           # 用插件自己的 Loop/runTask 跑一遍闭环
npm run test:dom                        # DOM 解析层对着夹具跑(不需要服务端)
node tools/smoke.mjs --scenario wrong_asin
```
