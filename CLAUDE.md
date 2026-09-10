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
- **替买家号切换支付卡**(所有者定稿 2026-09-09 ①)。买家号配了
  `buyer_envs.expected_card_last4` 时,插件在读完结算页、报护栏**之前**点开
  Amazon 的支付选择页把卡换过去;留空 = 不校验也不切,一步都不做。
  **先切后验,验在服务端** —— 切是插件的动作,校验仍然只在 `price_guard`:
  插件说「我切成了」不算数,服务端拿它切完**重新读到**的尾号自己判。
  这条边界不许动:把校验搬进插件就是把闸门交给被管的一方。
  切换全程 fail-closed(payselect 页的判据是全仓可信度最低的一档,厂商自己
  承认那一页只有截图没有 DOM 样本),任何一步判据不满足就不点确认,
  抛 `PAYMENT_METHOD_UNEXPECTED` 并说清停在哪一步。展开见 docs/01 §5.3。
- **不复用地址簿里已有的地址,每单新建。**(所有者定稿 2026-09-09 ②)
  复用要在几十条地址文本里比对出「就是这一条」,比对写松一点就寄错人;新建的代价只是
  地址簿会长大(厂商样本里已经攒到 55 条)。`SEL.address.editNth` 因此已删,
  `addNew` 那条选择器的注释写着这个决定与它的代价;要改这条先改这里。
- **下单前默认没有人工确认。**(所有者定稿 2026-09-09 ③)不是「暂时没接」——是定下来的默认行为:
  插件领到单、过了护栏就直接下单。**做成可设置项**(插件配置 `confirmBeforeOrder`,
  默认 `false`,面板上一个按钮就能开)。开着的时候等待**必须有界**且上界与服务端的
  认领超时对齐,到点清车退回队列;**「到点没人按」与「人按了取消」是两件事**,
  事件流里的文案与 `payload.state` 分开写 —— 合成一条的话,一台没人守的机器会一直
  产出「有人按了取消」,看的人以为有人在把关。展开见 `docs/01-系统设计.md` §8.3。
- **订单可能不经本系统采购,但要由本系统同步物流。**(所有者定稿 ④)
  上游那张表里填了 AMZ 单号的行 = 「外部下单」:落库即 `purchased` +
  `purchase_source='external'`,**不经拍单、不经护栏**,直接进物流同步队列。
  它**没有限价**(库里那一列 NOT NULL,落一个 `0` 占位)——
  界面与导出对它一律写「外部下单,不适用」,**不许渲染成「限价 0.00,未超」**:
  那是一句护栏从没做过的结论。回写时这种单只写物流三列 ——
  采购状态与单号是上游自己填的,写回去轻则把它填的东西抄给它看一遍,
  重则**把它填的单号清掉**。展开与状态迁移表见 `docs/01-系统设计.md` §10。
- **`buyer_envs.amazon_customer_id` 不是身份,是对账 + 登错号拦截。**
  身份仍然是买家号环境(`buyer_envs.code`)。这一列为空时由插件首次上报写入;
  已有值而插件报上来的不一样 → **不覆盖**,认领时拒
  (`INSTANCE_ACCOUNT_MISMATCH`,形状照 `INSTANCE_SIGNED_OUT`,**不是**回「没有单」)。
  已有值而这台机器**从没报过** → 同样拒(`INSTANCE_ACCOUNT_UNVERIFIED`),
  因为最容易登错号的正是新装 / 新 profile 那一刻;它会自己好 ——
  服务端在心跳回执里主动要一次登录探测。
  判据现算不存,唯一定义处 `services/task_queue.account_state`。见 `docs/01` §11。

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
