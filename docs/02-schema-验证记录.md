# Schema 与队列的实测记录

> 环境：PostgreSQL **17.11**（与 `WalmartAPI-Contral` 对齐）
> 对象：`refdata/schema.sql`、`services/task_queue.py`、`cli.py`

## 当前状态（P0 完成时）

| 验证项 | 结果 |
|---|---|
| `cli.py db_init` 建库 | ✅ 9 张表（procure 5 / logistics 2 / ops 2） |
| 重复执行（幂等） | ✅ 第二次执行同样返回 9 张表，无报错 |
| `--dry-run` 不触库 | ✅ 只报将执行的文件与字节数 |
| 未知工作流 | ✅ 在跑第一步**之前**报错退出（exit 1），不会跑到一半才发现 |
| `ops.runs` 留痕 | ✅ 每次执行写一行，含 workflow / status / summary |
| pytest | ✅ **17 passed** |

复现：

```bash
createdb amz_purchase
python cli.py db_init                       # 建库
python cli.py db_init                       # 再跑一次,验证幂等
export AMZ_TEST_ADMIN_DSN="dbname=postgres"
python -m pytest -q                         # 17 passed
```

---

## P1 实测（2026-08-21）

起真实 uvicorn + PostgreSQL 17，用 `tools/mock_plugin.py` 跑四个场景（全程不碰 Amazon）：

| 场景 | 终态 | error_code | 单号 |
|---|---|---|---|
| happy | `purchased` | — | `111-0000001-0000001` |
| over_cap（实付 99.00 > 限价 12.50） | `manual` | `PRICE_CAP_EXCEEDED` | — |
| oos（缺货） | `exception` | `OUT_OF_STOCK` | — |
| wrong_asin（订单卡 ASIN 不符） | `manual` | `ORDER_NO_AMBIGUOUS` | **未写入** |

pytest：**74 passed**。

### 实跑抓到一个 pytest 假通过的 bug

第一轮实跑时，`wrong_asin` 场景的任务**卡死在 `claimed`**，本该是 `manual`。

根因：`complete` 路由的 ASIN 断言失败路径先调 `task_queue.fail()` 写「转 manual」，
再 `raise HTTPException(409)`。而 `registry/db.py` 的 `pg_conn` 遇异常会 rollback ——
刚写的状态被一起回滚了。

**pytest 当时是通过的**，因为测试夹具把裸连接直接交给路由，没有复刻 `pg_conn`
的「正常提交、异常回滚」语义。夹具给了假象。

两处都修了：

1. 路由改成 `return JSONResponse(status_code=409, ...)`，不再 raise
2. `tests/conftest.py` 的 `client` 夹具改为复刻 `pg_conn` 事务语义，
   这类 bug 以后在测试里就能暴露

由此立的铁律（已写进 `CLAUDE.md`）：**路由里只要已经写过库，就不许再
`raise HTTPException`**。

> 这条和本文档下面那条历史结论是同一类问题：**测试/护栏「看起来覆盖了」比没覆盖更危险**。
> 一个是 `NOT EXISTS` 让人以为防住了并发，一个是夹具让人以为测过了回滚路径。

---

## 历史结论：一句 `NOT EXISTS` 挡不住并发（v0.2 → v0.3 已移除该需求，结论保留）

设计 v0.2 曾把租约简化成「`status='claimed'` + 认领 SQL 里一句 `NOT EXISTS` 检查该环境
有没有在执行的任务」，用来实现跨实例互斥。**实测证明这是错的。**

READ COMMITTED 下每个事务读自己的快照，**看不见对方未提交的写**。两个并发认领会双双
通过 `NOT EXISTS`，再被 `SKIP LOCKED` 分到**不同的两条**任务上：

```
[B] BEGIN → 认领 task 2 → COMMIT
[A] BEGIN → 认领 task 1 → COMMIT

claimed 任务数(同一环境) = 2      ❌
```

当时的修复是一条部分唯一索引：

```sql
CREATE UNIQUE INDEX uq_tasks_one_claimed_per_env
    ON procure.tasks (buyer_env_id) WHERE status = 'claimed';
```

同样并发下 B 被数据库拒绝并回滚，`claimed = 1`。

**v0.3 起这条需求不存在了**——所有者确认同一买家号不会在两处同时登录拍单，跨实例互斥
整体删除，索引与 `NOT EXISTS` 一并移除。

结论仍然值得留档，因为它是一条通用教训：

> **「看起来有护栏、实际防不住」比没有护栏更危险。**
> 留着那句 `NOT EXISTS` 会让人以为已经防住了。这和厂商那套 50% 价格护栏是同一种毛病——
> 它比较的是结账页自身的两个数，看着像涨价保护，实际发现不了涨价。
>
> 所以：要么真防住（约束落到数据库），要么明确写清「这里不防，因为前提是 X」。
> `services/task_queue.py` 的模块 docstring 采用了后者。

---

## 全链路实跑(2026-08-21,空库起)

按 README 的快速开始从一个**全新的库**走了一遍,验的是「文档写的步骤真能跑通」,
以及各层拼起来之后行为是否还对。环境:PostgreSQL 17 + uvicorn + 插件自己的
`Loop`/`runTask`(页面动作走模拟驱动,不碰 Amazon)。

```
createdb amz_fresh → cli.py db_init → 9 张表
建 env-172 → cli.py task_intake(5 行,1 行 price_cap=0)
```

| 步骤 | 结果 |
|---|---|
| `task_intake --dry-run` | 5 行 → 将新增 4,拒收 1(`#4 UP-F900: price_cap 必须大于 0`) |
| `task_intake` 真跑 | 新增 4,拒收 1 —— **与空跑逐字一致** |
| 认领 → 拍单(happy) | `purchased`,单号已回填 |
| 超限价 | `manual` / `PRICE_CAP_EXCEEDED` |
| 订单卡 ASIN 不符 | `manual` / `ORDER_NO_AMBIGUOUS`,**单号未写入** |
| 下单后未见确认页 | `manual` / `ORDER_CONFIRM_TIMEOUT` |
| 物流同步 | `delivered`,4 条轨迹,`delivered_at` 已落 |

后台接口(curl 直打):

| 动作 | 结果 |
|---|---|
| 状态桶计数 | manual 3 / purchased 1 / exception 0 / ready 0 |
| 批量单号(上游号 + AMZ 号 + 一个查不到的) | 盖过状态桶,命中 2,`missing_order_numbers` 报出那一个 |
| 实例判活 | `env-172 online 可派单=True 队列=0 今日=1 待人工=3`,阈值 60 秒 |
| 详情 | 商品 1 / 事件 9 / 物流无,事件类型序列完整 |
| 重置一条 `ORDER_CONFIRM_TIMEOUT` | **拒绝**:`NEEDS_ACK` |
| 带 `acknowledged` 再来 | `ready` |
| 强制回填不写说明 | **拒绝**:`NOTE_REQUIRED` |
| 强制回填一个已被占用的单号 | **拒绝**:`ORDER_NO_TAKEN`,并指出挂在哪条任务上 |
| 强制回填正常 | `purchased`,事件里留下 `assertion_skipped: true` + 说明 + 操作人 |

### 这一轮验到的、单元测试验不到的东西

**空跑与真跑逐字一致。** 这一条只有整条链路跑起来才看得出来 ——
`dry_run` 与 `ingest` 是两个函数,单元测试里各自都对,但「同一份输入进去,
人看到的两段输出是不是同一回事」得端到端才成立。之前它们**不一致**过
(空跑不查库,少报了一行拒收),那时两边的单元测试都是绿的。

**拒绝路径不改库。** `NEEDS_ACK` / `NOTE_REQUIRED` / `ORDER_NO_TAKEN` 三条拒绝之后,
任务状态原样不动。这一点在路由层是靠「拒绝判定一律发生在写库之前」保证的,
而不是靠事务回滚 —— 后者在 `pg_conn` 的语义下会把同一次请求里**更早的**写也一起吞掉
(见本文档上面那条 2026-08-21 的记录)。

**留痕能追到人。** 强制回填这个动作在库里留下的是:谁(operator)、
凭什么(note)、跳过了什么闸(assertion_skipped)、原来卡在哪个码(was_error_code)。
事后追责时这四样缺一不可。

---

## 登录态实测（2026-09-06）

起真实 uvicorn（8791）+ PostgreSQL 17，用插件自己的 `Loop`/`runTask` 跑
`--scenario login_lost`（模拟「跑到一半这个买家号被登出」）：

| 验证项 | 结果 |
|---|---|
| 执行中发现被登出（未越过下单点） | 任务回到 `ready`，`error_code` **为空** —— 不是拍单异常 |
| 事件流 | `claimed` → 三条 `step` → **`step`「登录态失效，退回队列」** → `released` |
| 登录态上报（心跳） | `plugin_instances.login_state = signed_out`，`login_checked_at` 落时刻 |
| 插件下一轮 | `{"kind":"signed-out"}` —— 自己就不认领了，不去刷服务端 |
| 绕过插件直接认领 | HTTP 409 `INSTANCE_SIGNED_OUT`，**不是**「没有单」 |
| `GET /v1/admin/instances` | `login_state=signed_out` / `login_blocks_dispatch=true` / `dispatchable=false`，而 `liveness` 仍是 `online` |
| 之后再报一次 `unknown`（2026-09-06 复核补） | 库里仍是 `signed_out`、`login_checked_at` 不动，认领仍 409。**只有 `ok` 能解封** |
| 之后切「模拟」档跑一轮（同上） | 模拟驱动报的是 `unknown`（它一次页面都没读过），库里仍是 `signed_out`，认领仍 409 |

`/v1/admin/instances` 那一行是这一整件事的要害：**心跳正常、机器却一单也跑不了**，这两条轴必须分开显示。

pytest：**247 passed**（新增 15 条：心跳落库 / 不传不覆盖 / **unknown 不许洗掉 signed_out** /
**unknown 照样盖掉 ok** / 封闭集 422 / 被登出仍可心跳 / 认领被拒且不动任务 / 恢复后能派 /
unknown 不拦 / 运营台与真闸一致 / 没有实例时归一成 unknown / 复检节奏 /
**六处封闭集一致** / meta 下发 / 「刻意不新增错误码」这个决定）。

### DOM 断言「证明有用」的那一步

解析层新增 27 条断言（共 **109 条**）。断言本身也要验：把判据一条条改坏，看它们是不是真的转红。

| 改坏什么 | 结果 |
|---|---|
| 读不到判据时兜底成 `ok` | ✗ 4 条转红（两张无导航栏的夹具 + 认不出的账户入口 + 非英文问候语） |
| 不挑可见节点（直接 `querySelector`） | ✗ 2 条转红，而且是**两个方向都错**：已登录判成已登出，已登出判成已登录 |
| 要求 `#nav-item-signout` 可见 | ✗ 1 条转红（真实页面上它在 `display:none` 的账户浮层里） |
| 文案不再当否决票（先看 signout） | ✗ 1 条转红（模板残留的 signout 会盖过「Hello, sign in」） |
| URL 判据兜底成 `false`（`isSignInUrl` 恒假） | ✗ 4 条转红 |
| URL 判据写成 `startsWith`（很容易顺手写成的那一种） | ✗ 3 条转红 |
| URL 命中时返回 `ok`（把最硬那一条反过来） | ✗ 1 条转红 |
| 去掉 `guardLogin` 里那次「换一张页面再问」的兜底 | ✗ 1 条转红（被 XFO 挡住的结算 frame 判不出已登出） |
| 兜底改成「读不到就算被登出」 | ✗ 1 条转红（购物车页明说还登着，却仍然下了结论） |

改回去之后 109 条全绿。第二行那个双向失败是夹具里那些干扰项(隐藏的反向导航模板)
挣来的 —— 没有干扰项的话,写松了的实现照样一路绿灯。

**后三行是 2026-09-06 复核补上的。** 在那之前，被注释和文档称作"最硬"的 URL 判据
**一条断言都没有**：把 `readLoginState` 的第一句反过来写成 `return "ok"`，97 条
全绿；给 `LoginState` 加一个 `"captcha"` 并从这一句返回它，typecheck、97 条 DOM、
13 条 pytest 也全绿。原因是所有夹具都走 `setContent`，页面 URL 永远是
`about:blank`，这条判据在测试里根本走不到。现在它收成一处定义
（`parse.isSignInUrl`，用它的有五处），测试用 Playwright 的 route 拦截把夹具
**真的放在 `/ap/signin` 上**打开——不联网，但 URL 是真的。

### 执行中掉线:被 X-Frame-Options 挡住的那条兜底（2026-09-06 复核补）

原先 `guardLogin` 的两条判据，在它的**头号场景**里可能一条都读不到：Amazon 登录页
普遍带 `X-Frame-Options: DENY`，结算 iframe 被 302 过去之后浏览器拒绝渲染它。
这个前提在 Chromium 141 上实测过：

| 那一帧 | 正常加载时 | 被 XFO 挡住之后 |
|---|---|---|
| `contentDocument` | 拿得到 | **null**（`frame.doc()` 抛错） |
| `contentWindow.location.href` | 读得到 | **抛 SecurityError**（`frame.url()` 返回 `""`） |

于是「URL 落在登录页」和「DOM 说已登出」都不成立，照旧报 `CHECKOUT_TIMEOUT`——
「被登出」和「页面慢」又长成同一个样子，而这正是这一整件事要修的东西。

现在两条都读不到时换一张购物车页再问一次（未登录也渲染导航栏、不会被 XFO 挡）。
DOM 测试造出的就是这个局面：route 拦截给 `/ap/signin` 真发一顶 `X-Frame-Options: DENY`
的帽子，把 iframe 导过去，先断言"两条判据确实读不到"（否则后面那条证明不了任何事），
再让 `guardLogin` 去判。两个方向都有断言：购物车页说已登出 → 抛 `LoginLostError`；
购物车页说还登着 → **不下结论**，由调用方原本的错误码去说。

**仍然没验到的是最后一环:Amazon 的登录页到底发不发 XFO、真机上会不会 302 到别处。**
第一次真机验证时专门看一眼:登出后跑一单，事件流里出现的是「登录态失效，退回队列」
还是 `CHECKOUT_TIMEOUT`。

**仍然没被盯住的**（写在这里，是为了读表的人不会以为"全都被盯着"）：

- `AmazonDriver.readLoginState` 里那两处 URL 判据的调用点——它要开一张真的购物车页，
  离线验不了。盯住的是它与 `guardLogin` 共用的那一处判据定义（`parse.isSignInUrl`），
  以及 `readLoginState`（解析层那个）对它的两处使用。
- service worker 里那条心跳重发路径（登录态被服务端连续拒绝 3 次就丢弃）。
  `src/background/service-worker.ts` 一进模块就调 `chrome.*`，Node 里驱动不起来，
  `npm run smoke` 走的是 `Loop`，不经过它。这条上限是**推演出来的，不是验过的**。
- 封闭集的六份现在有 pytest 盯着（改坏 `server/schemas.py` 的 Literal → 4 条转红；
  改坏 `parse.ts` 的 `LoginState` → 1 条转红），这一条是被盯住的。

