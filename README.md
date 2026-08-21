# amz-purchase-control

Amazon 采购自动化:**服务端派单 + 浏览器插件在防关联环境内执行**。

- 服务端 Python 3.12 / FastAPI / PostgreSQL 17 / psycopg 3(裸 SQL,无 ORM)
- 插件 Chrome MV3(TypeScript + Vite)
- 首期仅 US 站,不做鉴权(服务默认只监听 127.0.0.1)

设计对标的是一套在产的厂商插件(小蜜蜂 AMZ 采购助手 v2.4.1,12,963 单规模),
它的源码级分析在 `AMZ-Purchase-Assistant/docs/`。这套系统的很多判断是**照着它的缺陷反着做的**,
每一处都在代码注释里标了出处。

## 一条单子的一生

```
上游 ERP
   │  cli.py task_intake  /  POST /v1/admin/tasks/import
   ▼
pending ──放行──► ready ──插件认领──► claimed
                                        │
                        ┌───────────────┼───────────────┐
                        ▼               ▼               ▼
                    purchased        exception        manual
                   (单号已回填)      (可重置回队列)   (需人工确认)
                        │
                        │  插件另一条流:物流同步
                        ▼
              logistics.shipments + shipment_events
```

插件那一侧:清车 → 商品页(库存/FBA)→ 加购 → 回读购物车 → 去结算 → 填地址 →
读结算页 → **服务端护栏裁决** → 下单 → 读订单卡 → **ASIN 断言** → 回填。

## 快速开始

```bash
# 1. 建库
createdb amz_purchase
python cli.py db_init

# 2. 跑测试(需要一个可连的 PostgreSQL 17;连不上会整体 skip)
export AMZ_TEST_ADMIN_DSN="dbname=postgres"
python -m pytest -q                       # 122 条

# 3. 起服务
python -m uvicorn server.app:app --host 127.0.0.1 --port 8781

# 4. 建一个买家号,再把上游采购行灌进来
psql amz_purchase -c "INSERT INTO procure.buyer_envs (code) VALUES ('env-172')"
python cli.py task_intake --dry-run -p file=rows.json    # 先空跑看拒收清单
python cli.py task_intake -p file=rows.json -p release=1

# 5. 用模拟插件跑闭环(不碰 Amazon)
python tools/mock_plugin.py --scenario happy
python tools/mock_plugin.py --scenario over_cap    # 超限价被拦
python tools/mock_plugin.py --scenario wrong_asin  # 订单卡 ASIN 不符,转人工

# 6. 插件侧
cd extension && npm install
npm run typecheck && npm run build        # → dist/,可加载进 Chrome
npm run test:dom                          # 65 条 DOM 解析断言(不需要服务端)
npm run smoke                             # 用插件自己的 Loop/runTask 跑闭环
node tools/smoke.mjs --scenario happy --ship in_transit
```

`rows.json` 的形状见 `server/schemas.IntakeReq`,或直接照 `tests/test_task_intake.py` 里的 `_row()`。

## 验到了什么、没验到什么

| | 状态 |
|---|---|
| 服务端全部端点、状态流转、护栏裁决、封闭集校验 | ✅ 122 条 pytest,跑在真 PostgreSQL 17 上 |
| 插件与服务端的时序(认领 → 执行 → 护栏 → 回填 → 失败清车) | ✅ 8 个场景实跑,跑的是插件自己的 `Loop`/`runTask` |
| 物流同步时序 | ✅ 实跑 |
| DOM 解析层(选择器是否按报告的语义在读) | ✅ 65 条断言,对着按报告造的夹具跑 |
| **真实 Amazon 页面** | ❌ **从未跑过**。这里没有可登录的买家号 |

最后一行是这套系统眼下最大的未知。夹具能保证「报告里记着的选择器,我们确实按它们的语义在读」,
但 Amazon 的真实 DOM 一定和夹具有出入。**第一次开 live 档之前,请在一个可弃的买家号上手动跑一单。**

插件默认是 `off` 档(只注册与心跳,不认领),就是为了不让人不小心跑起来。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `AMZ_PG_DSN` | `dbname=amz_purchase` | 数据库连接串 |
| `AMZ_DATA_ROOT` | `~/.amz-purchase` | .env / 日志 / 锁文件所在目录 |
| `AMZ_CLAIM_TIMEOUT_MIN` | `15` | 领走多久没回传判为异常中断(转 manual,**不**退回队列) |
| `AMZ_HEARTBEAT_STALE_SEC` | `60` | 多久没心跳算离线(插件 20 秒一次,连续三次没到) |
| `AMZ_ADMIN_PAGE_SIZE_MAX` | `200` | 后台列表单页上限 |
| `AMZ_SHIPMENT_RESYNC_MIN` | `360` | 同一条物流多久之后才值得再同步 |
| `AMZ_SHIPMENT_BATCH` | `20` | 一次给插件多少条待同步的单 |
| `AMZ_SERVER_HOST` / `AMZ_SERVER_PORT` | `127.0.0.1` / `8781` | HTTP 监听 |

## 接口

| | |
|---|---|
| `POST /v1/instances/register` `/heartbeat` | 实例注册与心跳 |
| `POST /v1/tasks/claim` | 按买家号认领一单 |
| `POST /v1/tasks/{id}/events` | 执行步骤上报(只追加) |
| `POST /v1/tasks/{id}/guard-check` | **护栏裁决在服务端**,插件只报数 |
| `POST /v1/tasks/{id}/complete` `/fail` `/release` | 落终态 |
| `POST /v1/shipments/pending` `/sync` | 物流同步 |
| `POST /v1/admin/tasks/import` `/search` · `GET /{id}` | 落库与查询 |
| `POST /v1/admin/tasks/{id}/release` `/reset` `/force-backfill` `/address` `/asin` | 五个人工动作 |
| `GET /v1/admin/instances` | 买家号与判活 |

## 几条贯穿全项目的判断

**护栏裁决在服务端,插件只报数。** 把闸门交给被管的一方,闸门就不成其为闸门。
另一个好处是改护栏不用发新插件版本 —— 厂商的护栏写死在插件里,改一次要全员升级。

**点下单那一刻起,禁止退回队列。** `mayHaveOrdered` 在 `placeOrder()` **之前**置位:
点击过程中崩了,我们同样不知道单下没下成。一旦置位,任何失败都转人工。
这是整套设计里唯一一处「宁可卡住也不自动往前走」的地方 —— 别处失败都能重试,
只有花过钱的那步不能猜。

**不确定就不写。** 回填前拿订单卡上的 ASIN 跟本单断言,不符就**不写单号**。
厂商是「先写进去,再在界面上打个红叉给你看」;写错的单号会把别人的订单挂到这条任务上,
后面对账、物流、退款全跟着错。

**失败必上报、必清车。** 每条终止路径都走同一个出口,不存在「只写本地日志」的分支。
厂商插件有 30+ 条只写日志的失败路径,且多数不清车,一次失败连带废掉下一单。

**「看起来有护栏、实际防不住」比没有护栏更危险。** 这条在本项目里反复出现,每次都记进了文档:
- 厂商接口返回 `priceCheck` 字段,前端模板 0 处引用
- 我们自己的 `task_event` 曾写着「错误码是封闭集」,却只校验了 kind、从没校验过 code
- 我们自己的 `task_intake --dry-run` 曾只做字段校验、不查库,空跑报 1 行会拒、真跑拒了 2 行
- pytest 曾**假通过**一条回滚 bug,因为测试夹具没有复刻 `pg_conn` 的事务语义

**不申请 `cookies` 权限。** 登录态留在浏览器 profile 里,不读也不上传。
这不是暂缓,是架构选择:服务端因此无法脱离操作员的浏览器独立下单 —— 这正是不想具备的能力。

## 文档

| | |
|---|---|
| `CLAUDE.md` | 项目总纲与铁律,开工前必读 |
| `docs/01-系统设计.md` | 架构、数据模型、**19 个错误码**、护栏、插件时序 |
| `docs/db_schema.md` | 表结构唯一事实来源(改表先改它) |
| `docs/02-schema-验证记录.md` | 建表与认领算法的实测记录 |
| `docs/03-运营台字段对照.md` | 厂商面板 8 组字段 → 我们的库,逐条取舍 |
| `design/` | 设计画布源文件(5 块画板)+ 离线渲染自检工具 |
| `extension/README.md` | 插件:三档模式、离线验证、写进代码的几条规矩 |

## 进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | registry + schema.sql + cli.py + services/task_queue | ✅ |
| P1 | server/ 全部端点 + mock 插件 | ✅ |
| P2 | 插件骨架:注册/心跳/认领/上报,三档运行模式 | ✅ |
| P3 | 真实 Amazon 驱动 + DOM 解析层离线验证 | ✅ 代码完成,**未在真实 Amazon 上跑过** |
| P4 | 运营台接口:列表/批量单号/五个人工动作/实例判活 | ✅ |
| P5 | 物流同步 | ✅ |
| — | 任务落库(上游 → procure.tasks) | ✅ |
| 下一步 | 运营台 Web 前端(设计画布已就绪,代码未写) | 待办 |
| 下一步 | 上游 ERP 真实接口(现走文件投放) | 待办 |
