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
| `amazon_customer_id` | text | 插件从页面提取，**仅作对账**，不作身份判定 |
| `status` | text | `active` / `paused` / `blocked` / `retired`（封闭集） |
| `daily_cap` | integer | 日单量上限，`0` = 不限 |
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

### `procure.tasks` — 采购任务

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint identity | |
| `line_key` | text UNIQUE | `sha256(上游单号 \| asin)` 十六进制 |
| `upstream_order_no` | text | 上游订单号，便于人工追溯 |
| `buyer_env_id` | bigint FK | 派给哪个买家号 |
| `marketplace` | text | 首期恒为 `US` |
| `status` | text | 见下方状态机（封闭集） |
| `ship_*` | text | 收货信息，下发给插件填表 |
| `price_cap` | numeric(12,2) | **限价**。由上游 ERP 算好下发，本系统只取用不计算。结算页实付超过即不下单 |
| `max_delivery_days` | smallint | 交期上限，默认 7 |
| `claimed_by` | bigint FK | 在途：被哪个实例领走 |
| `claimed_at` | timestamptz | 在途：领走时间，超时清扫依据 |
| `amazon_order_no` | text | 回填的 Amazon 订单号 |
| `actual_total` / `actual_shipping` / `actual_tax` | numeric(12,2) | 结算页实测金额 |
| `payment_last4` | text | 支付卡后四位，对账用 |
| `delivery_date` | date | 服务端解析后的交期 |
| `delivery_raw` | text | Amazon 原始文案，**保留供复核**（解析失败时的唯一线索） |
| `purchased_at` | timestamptz | |
| `error_code` | text | 结构化错误码，见 `01-系统设计.md` §4 |
| `error_detail` | text | |

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

### `procure.task_products` — 商品行

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint identity | |
| `task_id` | bigint FK CASCADE | |
| `asin` | text | |
| `quantity` | integer CHECK > 0 | |
| `actual_unit_price` | numeric(12,2) | 结算页实测，回传后填 |
| `image_url` | text | |

### `procure.task_events` — 事件流（只追加）

替代厂商系统那**一个** `failContent` 自由文本字段。后台按 `task_id` 展开就是这条任务的
完整时间线。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint identity | |
| `task_id` | bigint FK CASCADE | |
| `instance_id` | bigint FK | |
| `kind` | text | `claimed` / `step` / `guard_block` / `error` / `purchased` / `released` / `assert_failed` / `admin`（封闭集，由 `services/task_event.py` 校验）。`admin` = 人在后台动的手，与插件跑出来的结果分开 |
| `code` | text | `kind` 为 `error` / `guard_block` 时**必填**；填什么受 `services/error_codes.py` 的封闭集校验 |
| `payload` | jsonb | |
| `created_at` | timestamptz | |

> `kind` 与「error 必须带 code」两条约束在应用层强制（`task_event.record()` 直接抛
> `ValueError`）。这是「失败必须机器可读」的落地点。

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
