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
python -m pytest -q                       # 156 条

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
npm run test:dom                          # 68 条 DOM 解析断言(不需要服务端)
npm run smoke                             # 用插件自己的 Loop/runTask 跑闭环
node tools/smoke.mjs --scenario happy --ship in_transit

# 7. 运营台
cd web && npm install
npm run dev                               # → http://127.0.0.1:5173,/v1 由 Vite 代到 8781
npm run build                             # → web/dist,由 server/app.py 挂在 / 上
```

运营台**开发时用 `npm run dev`**(Vite 把 `/v1` 代到本机 8781),
**生产用 `npm run build`** 再直接开 <http://127.0.0.1:8781/>。
走代理而不是给服务端开 CORS:这个服务不做鉴权、只监听 127.0.0.1,
给它加一个宽松的跨域白名单是白送风险面。

没 build 过就开 `/` 会明确返回 `WEB_NOT_BUILT` 而不是一个 404 ——
静默 404 会让人以为服务坏了,其实只是前端没构建。

`rows.json` 的形状见 `server/schemas.IntakeReq`,或直接照 `tests/test_task_intake.py` 里的 `_row()`。

## 验到了什么、没验到什么

| | 状态 |
|---|---|
| 服务端全部端点、状态流转、护栏裁决、封闭集校验 | ✅ 156 条 pytest,跑在真 PostgreSQL 17 上 |
| 插件与服务端的时序(认领 → 执行 → 护栏 → 回填 → 失败清车) | ✅ 8 个场景实跑,跑的是插件自己的 `Loop`/`runTask` |
| 物流同步时序 | ✅ 实跑 |
| DOM 解析层(选择器是否按报告的语义在读) | ✅ 68 条断言,对着按报告造的夹具跑 |
| 运营台前端 | ✅ 真库 + 真服务 + 真浏览器跑过四页、详情弹窗、改地址、剪贴板、NEEDS_ACK 流程 |
| **真实 Amazon 页面** | ❌ **从未跑过**。这里没有可登录的买家号 |

最后一行是这套系统眼下最大的未知。夹具能保证「报告里记着的选择器,我们确实按它们的语义在读」,
但 Amazon 的真实 DOM 一定和夹具有出入。**第一次开 live 档之前,请在一个可弃的买家号上手动跑一单。**

插件默认是 `off` 档(只注册与心跳,不认领),就是为了不让人不小心跑起来。

## 运维:有一条必须挂上定时

`task_sweep` 是**唯一**一条必须被定时调起来的链。整套设计里 `CLAIM_TIMEOUT` 那条路
全靠它:插件领走一单之后崩了/被关了/机器睡了,任务会一直停在 `claimed`,
既不会自己回队列,也不会出现在任何一个人会去看的桶里 —— 它就那么**隐身**了。

```cron
*/5 * * * *  cd /path/to/amz-purchase-control && python cli.py task_sweep >> /var/log/amz/sweep.log 2>&1
```

跑之前先空跑一次看看会动到谁:

```bash
python cli.py task_sweep --dry-run
#   dry-run:1 条任务超过 15 分钟未回传,将转 manual
python cli.py task_sweep
#   清扫完成:1 条超时任务转 manual (id: [30])
```

超时的单转 **manual 而不是 ready** —— 插件那侧可能已经在 Amazon 上真下了单,
退回队列就是让下一个实例把同一单再买一遍。

每次 `cli.py` 调起的 workflow 都会:加 flock 单实例锁 → **开跑就往 `ops.runs`
写一行 `running`** → 执行 → 跑完把那一行 UPDATE 成 success/failed。
所以「上一次清扫是什么时候、扫到了什么」在库里查得到,不用翻日志文件,
运营台「工作流记录」那一页读的就是它。

开跑就写、而不是跑完补写,是为了让**中途被杀**留下痕迹:
容器回收、OOM、机器重启的话,跑完才写就一行都不写 ——
一次挂死的运行在库里跟「从来没跑过」一模一样。现在它会留下一行停在 `running`,
界面上标成「开跑后没了下文」,与「正在跑」分开显示(这两种的处置正好相反:
一个是等它,一个是去查它)。

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
| （库里）`buyer_envs.daily_cap` | `0` | 该买家号一天最多拍几单，`0` = 不限。闸门在认领的那条 SQL 里 |
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
| `POST /v1/admin/tasks/import` `/search` `/export` · `GET /{id}` | 落库、查询、导出 CSV(整个筛选结果,不只当前页) |
| `POST /v1/admin/tasks/{id}/release` `/reset` `/force-backfill` `/address` `/asin` | 五个人工动作 |
| `POST /v1/admin/tasks/batch-reset` | 批量重置。**不接受 acknowledged** —— 可能已下单的原样报回来,让人逐条去看 |
| `GET /v1/admin/instances` | 买家号与判活 |
| `GET /v1/admin/meta` | 封闭集连中文标签下发。**前端不存副本** |
| `GET /v1/admin/summary` | 状态桶计数(跟着 env/时间筛选走;顶栏两个数字保持全局) |
| `GET /v1/admin/error-stats` | 错误码分布:按码 / 按买家号 / 按天 |
| `GET /v1/admin/runs` | 工作流运行记录 |

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

**批量动作不替人做那个必须由人做的确认。** 批量重置**不接受 `acknowledged`**:
单条那道闸拦的是「这一单可能已经在 Amazon 上真下成了」,而回执的含义是
有人去那个买家号的订单页看过了。一批 30 单给一个总的「已确认」,那句话就是假的 ——
真让它接受,这个按钮就从「省点击」变成「一键重复下单 30 次」。
能重的都重,不能重的原样报回来,让人逐条去点。

**「看起来有护栏、实际防不住」比没有护栏更危险。** 这条在本项目里反复出现,每次都记进了文档:
- 厂商接口返回 `priceCheck` 字段,前端模板 0 处引用
- 我们自己的 `task_event` 曾写着「错误码是封闭集」,却只校验了 kind、从没校验过 code
- 我们自己的 `task_intake --dry-run` 曾只做字段校验、不查库,空跑报 1 行会拒、真跑拒了 2 行
- pytest 曾**假通过**一条回滚 bug,因为测试夹具没有复刻 `pg_conn` 的事务语义
- 19 个错误码看着是个三分的封闭分类,实际有 **7 个不在任何一组** —— 而且恰好是最常见的
  那几个(无货、非 FBA、地址不可投递)。照着分组建处置 SOP 的人会漏掉三分之一
- `RETRYABLE` 这一组**没有任何自动重试在消费它**:没有 workflow 把 `exception` 退回 `ready`。
  界面上因此不许写「系统自己会再试」—— 那会让人把一桶其实没人管的单晾在那儿
- `ops.runs` 曾是**只写不读**的:每跑一条 workflow 就写一行,全项目没有任何地方读它

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
| `web/README.md` | 运营台前端:四页、两种行密度、写进代码的十几条规矩 |

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
| P6 | 运营台 Web 前端:四页 + 点行弹出的订单详情 + 点击即复制 | ✅ |
| 下一步 | 上游 ERP 真实接口(现走文件投放) | 待办 —— 等对方给契约 |
| 下一步 | 自动重试:目前 `RETRYABLE` 那一组没有任何东西在消费它 | 待定 |
