# PostgreSQL 数据库设计

> 本机 **PostgreSQL 17**，库名 `amz_purchase`。三个 schema，职责互不越界。
> **本文档是唯一的表结构事实来源**：任何建表/改表必须先改这里。
> 可执行同步产物是 `refdata/schema.sql`（幂等），执行走 `python cli.py db_init`。
> 连接只准通过 `registry/db.py`。

## Schema 总览

| schema | 职责 | 写入者 |
|---|---|---|
| `procure` | 采购域：买家号、插件实例、采购任务、商品行、事件流 | `erp_sync` / `server` / `task_sweep` |
| `logistics` | 物流域：运单与轨迹 | `server`（插件回传）/ `shipment_sync` |
| `ops` | 运行域：运行记录、游标 | `cli.py` 与各 workflow |

## 设计约定

- 主键一律 `bigint GENERATED ALWAYS AS IDENTITY`，**不用 SERIAL**
- 封闭集用 `text` + 行内注释，**不用 `CREATE TYPE ... AS ENUM`**
  （枚举类型改值要 `ALTER TYPE`，跨环境迁移麻烦；兄弟项目 `WalmartAPI-Contral` 全库 0 个 enum）
- 时间一律 `timestamptz`，存 UTC
- **金额一律 `numeric`**，不存带货币符号的字符串
  （厂商系统全存字符串，还出现过 `"￥1,234\n(￥0)"` 这种二段式）
- 建表脚本幂等（`IF NOT EXISTS`），可重复执行

---

## procure — 采购域

### `procure.buyer_envs` — 买家号 = 防关联浏览器环境

一个环境 = 一条产能通道，绑定一个 Amazon 账号与一个代理出口。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint identity | |
| `code` | text UNIQUE | 环境名，如 `env-172` |
| `marketplace` | text | 首期恒为 `US` |
| `amazon_customer_id` | text | 这个买家号**应该**是哪个 Amazon 账号。插件从页面 HTML 里抠出来(`customerId:"A…"`)随心跳上报,**为空时首次上报即写入**;已经有值而插件报上来的不一样时**不覆盖**,认领时直接拒(`INSTANCE_ACCOUNT_MISMATCH`)。**身份仍然是买家号环境本身**,这一列是对账 + 登错号拦截,不拿它去派单、也不拿它当主键。改它只有一条路:运营台买家号页的「以这个为准」(写 `procure.env_events`,带 operator) |
| `status` | text | `active` / `paused` / `blocked` / `retired`（封闭集） |
| `daily_cap` | integer | 日单量上限，`0` = 不限 |
| `expected_card_last4` | text | **这个买家号该刷哪张卡**的后四位。留空 = 这一道不校验（与 `tasks.require_fba` 同一形态：闸门可关，但关不关是库里的数据说了算，不是代码里的默认值）。填了之后，结算页读到的卡尾号与它不符即 `PAYMENT_METHOD_UNEXPECTED`，**在下单之前拦下**。只校验、不替买家号切卡——改支付配置是人的动作，不是拍单流程的动作。**改这一列不留痕**：`task_events` 挂在 `task_id` 上，这张表套不进去，而 `buyer_envs` 眼下整张表都没有审计流（`daily_cap`、`status` 同样没有），所以「谁在什么时候关掉了这个买家号的支付校验」目前答不出来 |
| `note` | text | |
| `created_at` / `updated_at` | timestamptz | |

### `procure.plugin_instances` — 插件实例

登记身份用。**不发凭据**（所有者决定不做鉴权）。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint identity | |
| `buyer_env_id` | bigint FK | 所属环境 |
| `instance_uid` | text UNIQUE | 插件首次启动生成并持久化 |
| `plugin_version` | text | |
| `last_seen_at` | timestamptz | 心跳更新 |
| `login_state` | text | `ok` / `signed_out` / `unknown`（封闭集）。这台机器的浏览器 profile 里那个 Amazon 账号**此刻还在不在登录态**。插件读导航栏判定后随心跳上报，**不读 Cookie**。默认 `unknown` |
| `login_checked_at` | timestamptz | 上一次真的读过页面判定登录态的时刻。`login_state` 单独看是不够的：一个三天前读到的 `ok` 和一分钟前读到的 `ok` 不是一回事 |
| `amazon_customer_id` | text | **这台机器此刻登着的那个 Amazon 账号**。插件在登录探测那一步顺手从页面 HTML 抠出来(`flow/dom/parse.readCustomerId`),随心跳上报。与 `buyer_envs.amazon_customer_id`(这个买家号**应该**是谁)是两列,**不是一列** —— 两列不一样才判得出「这台机器登错号了」。不传 = 这一轮没有新消息(保留旧值),与 `login_state` 同一条规则 |

> **为什么登录态挂在实例上，不挂在 `buyer_envs` 上。** 登录态存在于**浏览器 profile**
> 里，而 profile 属于跑着插件的那台机器，不属于库里那条买家号记录。挂到 `buyer_envs`
> 还会把两件不同的事混进同一列：`status='paused'` 是**人**把这个号停了（处置是去问为什么停），
> `login_state='signed_out'` 是**机器**报上来的「这个浏览器被登出了」（处置是去那台机器上重新登录）。
> 混成一列之后，界面上就分不出该找谁。
>
> **`unknown` 不是 `ok`。** 读不到导航栏（页面没渲染完、Amazon 改版、插件是旧版从不上报）
> 一律是 `unknown`，不许当成"应该没问题"。认领那道闸只拦 `signed_out` ——
> 拦 `unknown` 会让任何一个还没来得及做首次检查的新实例永远领不到单；
> 但界面上 `unknown` 必须与 `ok` 长得不一样（「登录态存疑」 vs 「已登录」），
> 否则就成了这个项目反复栽过的那种「两种不同的情况渲染出同一个结果」。
>
> **写这一列有一条规则:`unknown` 不许把 `signed_out` 洗掉,只有 `ok` 能解封。**
> 心跳不传是「这一轮没有新消息」（保留原值），传 `unknown` 是「读了、读不出来」——
> 而读不出来恰恰是被登出时的常见现象（Amazon 弹验证码、探测页没加载出来）。
> 让它覆盖的话,一次读失败就能把闸门重新打开,运营台上那一行也从红色变回灰色。
> 规则的唯一定义处是 `services/instance._KEEPS_OLD_LOGIN_STATE`，
> `login_checked_at` 跟着同一个条件走 —— 值和它的时刻永远一起动。
>
> **「登错号」是第二条轴,而它不是一列存下来的布尔。** 判据是
> `buyer_envs.amazon_customer_id`(该是谁)与 `plugin_instances.amazon_customer_id`
> (此刻登着谁)两个值一比,唯一定义处 `services/instance.account_state()`,
> 认领闸(`task_queue.claim`)与运营台买家号页调的是同一个函数。
> **刻意不存一位 `account_mismatch`**:存下来的那一位要在四个地方被清
> (插件换回正确的号、运营点「以这个为准」、买家号那一列被改、实例被换),
> 漏清任何一处的表现都是**闸门永远关着、这个买家号从此一单也派不出去**,
> 而界面上写的还是「登录的不是这个买家号」—— 一个已经不成立的理由。
> 两个值现算不会陈旧:换回正确的号,下一次心跳这道闸自己就开了。

### `procure.tasks` — 采购任务

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint identity | |
| `line_key` | text UNIQUE | `sha256("上游单号|asin1xN,asin2xM")` 十六进制，ASIN 排序后拼。**一条 task = 一张上游订单 = 一次 Amazon 下单**，里面可以有多个商品，所以键必须覆盖整个商品集合——只拿其中一个 ASIN 在多商品时没有答案，含糊的唯一键比没有唯一键更糟：它会让同一张上游订单在某些组合下重复落库，而看代码的人以为有去重。生成在 `services/task_intake.line_key()` |
| `upstream_order_no` | text | 上游订单号，便于人工追溯 |
| `buyer_env_id` | bigint FK | 派给哪个买家号 |
| `marketplace` | text | 首期恒为 `US` |
| `status` | text | 见下方状态机（封闭集） |
| `purchase_source` | text | **这一单是谁买的**:`plugin`(本系统的插件拍的,默认)/ `external`(上游自己在别处下的单,只是把 AMZ 单号填进了那张表 —— 不经拍单、不经护栏,直接进物流同步)/ `manual_backfill`(人在运营台按「强制回填」写进去的)。封闭集,标签在 `services/vocab.PURCHASE_SOURCE_LABELS`。**必须有这一列**:三种来源的处置完全不同 —— 外部单的 `price_cap` 是个占位的 0,渲染成「限价 0.00 未超」就是编了一句护栏从没做过的结论;回写时外部单的采购状态与AMZ 单号**是上游自己填的**,写回去等于把上游填的东西又抄给它看一遍。默认 `plugin`:老库里那些单确实都是插件拍的 |
| `ship_*` | text | 收货信息，下发给插件填表 |
| `price_cap` | numeric(12,2) | **限价**。由上游 ERP 算好下发，本系统只取用不计算。护栏拿**这一单的货款**（`goods_total`）跟它比，不是拿「这张卡实际扣了多少」比。NOT NULL,所以 `purchase_source='external'` 的行落一个 `0` 进来 —— **那不是「限价 0」,是「这一单没有限价这回事」**:界面与导出对 external 一律显示「外部下单,不适用」,不许渲染成「未超」(判据只有一处:`services/task_query.over_cap` 与 `web/src/lib/utils.capVerdict`) |
| `max_delivery_days` | smallint | 交期上限，默认 7 |
| `require_fba` | boolean | 这一单要不要求 Amazon 自营发货，默认 `true`。**必须有这一列**：在此之前它只是 `GuardsOut` 里一个 `= True` 的默认值，路由压根没往 `price_guard.adjudicate` 传，于是「可关的闸」是个恒为真的常量——照文档去配置它的人会发现改哪儿都不生效，而界面上那道闸一直亮着 |
| `claimed_by` | bigint FK | 在途：被哪个实例领走 |
| `claimed_at` | timestamptz | 在途：领走时间，超时清扫依据 |
| `amazon_order_no` | text | 回填的 Amazon 订单号 |
| `actual_total` / `actual_shipping` / `actual_tax` | numeric(12,2) | 结算页实测金额。`actual_total` 是**这张卡要扣的钱**——礼品卡抵扣之后它会变小，甚至是 `0.00` |
| `gift_card_amount` | numeric(12,2) | 结算页上礼品卡/余额抵扣掉的金额。`NULL` = 这一单没有礼品卡抵扣。**认出抵扣行却读不出金额时不写 0**——那会把「抵扣了 0 元」和「不知道抵扣了多少」渲染成同一个数，而后者根本不许下单 |
| `goods_total` | numeric(12,2) | **这一单的货款** = `actual_total` + `gift_card_amount`。护栏比的就是它。服务端在 guard-check 那一步自己算一遍并落库，不采信插件算好的那个数 |
| `payment_last4` | text | 支付卡后四位，对账用 |
| `delivery_date` | date | 服务端解析后的交期 |
| `delivery_raw` | text | Amazon 原始文案，**保留供复核**（解析失败时的唯一线索） |
| `purchased_at` | timestamptz | |
| `error_code` | text | 结构化错误码，见 `01-系统设计.md` §4 |
| `error_detail` | text | |
| `retry_count` | integer | **系统**自动重试过几次（`workflows/task_retry.py` 每重一次 +1）。人工重置不计数——那一下背后有人在看，不该占掉机器的自动次数；但也不清零——清零等于让下一个点重置的人不知不觉又送出 N 次自动重拍。上限是「这一单一生里被自动重拍几次」，不是每轮几次。默认 `0` |
| `may_have_ordered` | boolean | **这一单越过下单点了没有。** 插件在 `placeOrder()` **之前**置位 `mayHaveOrdered` 并立刻上报一条 `kind='step'`、`payload.may_have_ordered=true` 的事件，服务端收到就把这一列置 `true`（追加事件与置位在**同一事务**里——分开写的话，事件写进去了、置位回滚了，库里就会有一条说着「点了下单按钮」而闸门认不出来的任务）。**只增不减**：重置回队列不清它，「这一单曾经花过钱」是既成事实，不会因为它又排回队列而变回没花过。默认 `false` |

**索引：**

| 索引 | 用途 |
|---|---|
| `idx_tasks_ready` (buyer_env_id, created_at) WHERE status='ready' | 认领扫描 |
| `idx_tasks_claimed` (claimed_at) WHERE status='claimed' | 超时清扫 |
| `uq_tasks_amazon_order_no` UNIQUE (amazon_order_no) WHERE NOT NULL | 同一 Amazon 单号不可能落到两条任务上——回填写错时库层直接拒绝 |

**状态机：**

```
[erp_sync 落库]
      │
      ▼
   pending ──放行──→ ready ──插件认领──→ claimed
                       ▲                   │
                       │                   ├─ 下单成功 ──→ purchased（终态）
                       │                   ├─ 结构化失败 ─→ exception
                       └── release ────────┤
                                           ├─ 可能已下单 ─→ manual
                                           └─ 超时未回传 ─→ manual（CLAIM_TIMEOUT）
```

> **`claimed` 是在途标记，不是锁。** 运营前提是同一买家号不会在两处同时登录拍单，
> 因此不做跨实例互斥。`claimed` 的职责只有两个：让 `task_sweep` 发现「领走后再没消息」
> 的任务；让后台看清此刻哪些任务在执行。
>
> **超时不退回 `ready` 而是转 `manual`**：插件可能已经在 Amazon 上真下了单，只是没来得及
> 回传，自动重试就是重复下单。
>
> **外部下单是另一条进 `purchased` 的路**(所有者定稿 ④:订单可能不经本系统采购,
> 但要由本系统同步物流)。上游那张表里填了 AMZ 单号的行,落库即
> `status='purchased'` + `purchase_source='external'`,**不经 pending/ready/claimed,
> 也不经任何一道护栏** —— 它本来就没走过我们的结算页。已经在库里的任务后来
> 出现单号时按一张迁移表处置(哪几种状态转、哪几种一动不动),表在
> `docs/01-系统设计.md` §10;`claimed` 那一格**永远不动**,那是插件此刻正在拍的单。
>
> **`exception` → `ready` 有两条路，库里必须分得开**：人点的那一下走 `task_events.kind='admin'`，
> 系统自动重的走 `kind='auto_retry'`，`retry_count` 只被后者加。分不开的后果是事后没人答得上
> 「这一单是谁又放回队列的」——而这个问题在出现重复下单时是第一个要问的。
> 自动重试默认关（`AMZ_AUTO_RETRY_MAX=0`），且只吃 `RETRYABLE` 那一组，
> `POSSIBLY_ORDERED` 永远走不到这条路（见 `services/task_retry.py`）。
>
> **「可能已下单」这道闸判两样东西，不是一样**：`error_code ∈ POSSIBLY_ORDERED`
> **或** `may_have_ordered = true`。只判前者会漏掉一整类单——插件越过下单点之后
> 抛的是 `DriverError`（`run.ts` 的 catch 直接用它自己的码，不兜底成
> `ORDER_CONFIRM_TIMEOUT`），落库就是 `status=manual` + `error_code=PLUGIN_INTERNAL`：
> 状态说「要人裁决」，码说「重一下就过」。判码的那道闸放行，人点一下重置，
> 这张已经花过钱的单被再买一遍。
> **回到队列的每一条路各判一次,一共四条**:人工重置、批量重置、自动重试选单,
> 以及插件自己调的 `POST /v1/tasks/{id}/release`(越过下单点之后一律 409
> `POSSIBLY_ORDERED`,任务停在 `claimed` 等 `task_sweep` 转人工)。
> 第四条是最容易漏的一条,也是**唯一连人都没有**的:前三条至少还要人点一下。
> 展开见 `docs/01-系统设计.md` §5.4 —— 这里不重述细节,免得两份文档对同一道闸
> 给出不同的路数。

### `procure.task_products` — 商品行

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint identity | |
| `task_id` | bigint FK CASCADE | |
| `asin` | text | |
| `quantity` | integer CHECK > 0 | |
| `actual_unit_price` | numeric(12,2) | 结算页实测，回传后填 |
| `image_url` | text | |

### `procure.task_sources` — 任务 ↔ 上游那一行的对照

回写要知道「这张任务对应飞书里哪几行」。

**一张任务对多行**：飞书里通常一行一个商品，同一张上游订单占好几行，落库时被合并成
一张任务。回写时这几行都要写 —— 只写第一行的话，上游在表里看到的是「第一个商品有单号，
其余几个还没动静」，而它们本来就是同一次下单。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint identity | |
| `task_id` | bigint FK CASCADE | |
| `source` | text | 目前只有 `feishu`（封闭集） |
| `external_id` | text | 飞书的 `record_id` |
| `pushed_hash` | text | 上次回写过去的内容摘要。没变就不再写 |
| `pushed_at` | timestamptz | |
| `push_error` | text | 上次回写失败的原因（行被删了、单选没有这个选项……） |
| `gone_at` | timestamptz | 上游把这一行删了。删了就不再重试；下次拉单又看见它会自动清空 |
| `created_at` | timestamptz | |

> `UNIQUE (source, external_id)` —— 一行上游数据只能属于一张任务。
> 上游把某一行的单号改掉时，这一行会**改挂**到新任务上（`ON CONFLICT DO UPDATE`），
> 而不是报错：那是上游的合法操作。

### `procure.task_events` — 事件流（只追加）

替代厂商系统那**一个** `failContent` 自由文本字段。后台按 `task_id` 展开就是这条任务的
完整时间线。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint identity | |
| `task_id` | bigint FK CASCADE | |
| `instance_id` | bigint FK | |
| `kind` | text | `claimed` / `step` / `guard_block` / `error` / `purchased` / `released` / `assert_failed` / `assert_skipped` / `admin` / `auto_retry` / `shipment`（封闭集，由 `services/task_event.py` 校验）。`admin` = 人在后台动的手，`auto_retry` = 定时任务干的——两者必须分得开，「谁把它放回队列的」在出现重复下单时是第一个要问的问题；`assert_failed` = 回填时 ASIN 断言**不符**（不写单号，转人工），`assert_skipped` = 一个 ASIN 都**没采到**（照旧回填）——这两件事的含义正好相反，混成一种就没法数「那道断言什么时候整体失效」；`shipment` = 物流同步结果，发生在 purchased 之后，混进 `step` 会让「这一单拍得顺不顺」的时间线被轨迹刷屏 |
| `code` | text | `kind` 为 `error` / `guard_block` 时**必填**；填什么受 `services/error_codes.py` 的封闭集校验 |
| `payload` | jsonb | |
| `created_at` | timestamptz | |

> `kind` 与「error 必须带 code」两条约束在应用层强制（`task_event.record()` 直接抛
> `ValueError`）。这是「失败必须机器可读」的落地点。

### `procure.env_events` — 买家号这一侧的事件流（只追加）

`task_events` 挂在 `task_id` 上，买家号身上发生的事套不进去 —— 于是
`buyer_envs` 整张表长期**没有任何审计流**（`daily_cap`、`status`、
`expected_card_last4` 改了都答不出「谁在什么时候改的」）。

这张表先把 `amazon_customer_id` 那一条补上：它有一个**人可以点的动作**
（买家号页的「以这个为准」），而那个动作会把一道认领闸打开 ——
一个能打开闸门的按钮，按完之后库里一个字都不留，是这个项目不该有的东西。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint identity | |
| `buyer_env_id` | bigint FK CASCADE | |
| `instance_id` | bigint FK | 是哪台机器报上来的（人工动作时为空） |
| `kind` | text | `customer_id_seen`（这个买家号第一次被认出账号）/ `customer_id_mismatch`（报上来的账号与库里的不一样，认领已被拒）/ `customer_id_override`（人点了「以这个为准」）。封闭集，由 `services/instance.record_env_event()` 校验，标签在 `services/vocab.ENV_EVENT_LABELS` |
| `payload` | jsonb | 至少带 `expected` / `reported` 两个值和 `operator` |
| `created_at` | timestamptz | |

> **`mismatch` 每次心跳只记一条,不是每次都记。** 一台登错号的机器 20 秒一次心跳，
> 无条件追加的话这张表一天多 4300 行，而它们说的是同一件事；真正要留痕的是
> **这件事第一次发生**和**有人做了处置**。判据是「上一条 `mismatch` 里的 `reported`
> 与这次一样就不记」。
>
> **`expected_card_last4` 还没接进来** —— 那是另一件事（要连同 `daily_cap`、
> `status` 一起想清楚谁写、写什么）。这里写明白，免得下一个人看见这张表
> 就以为买家号的每一次改动都有记录。

---

## logistics — 物流域

### `logistics.shipments`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint identity | |
| `task_id` | bigint FK CASCADE | |
| `carrier` / `tracking_no` / `tracking_url` | text | |
| `status` | text | `not_shipped` / `in_transit` / `delivered` / `cancelled`（封闭集） |
| `delivered_at` | timestamptz | |

### `logistics.shipment_events`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint identity | |
| `shipment_id` | bigint FK CASCADE | |
| `happened_at` | timestamptz | 已归一化 |
| `raw_day` / `raw_time` | text | Amazon 原文，解析失败时的兜底 |
| `description` / `city` / `state_code` | text | |
| `seq` | integer | `0` = 最新 |

> **不存 `trackingHtml`。** 厂商回传整页 HTML + 内联全站 CSS，单请求可达 MB 级。
> 这里只存结构化事件，要凭证时按需重抓。

---

## ops — 运行域

### `ops.runs` — 运行记录

`cli.py` 每次执行写一行。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint identity | |
| `workflow` | text | |
| `params` | jsonb | |
| `started_at` / `finished_at` | timestamptz | |
| `status` | text | `running` / `success` / `failed`（封闭集） |
| `summary` | text | `run()` 返回的摘要，失败时是 traceback |
| `operator` | text | `manual` / `cron` / `web`（封闭集） |

### `ops.cursors` — 增量游标

| 列 | 类型 | 说明 |
|---|---|---|
| `name` | text PK | 如 `erp_sync:last_id` |
| `value` | text | |
| `updated_at` | timestamptz | |
