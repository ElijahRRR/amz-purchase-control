-- amz_purchase 建库脚本(幂等,可重复执行)。
-- 事实来源是 docs/db_schema.md:改表先改文档,再同步本文件。
-- 执行方式:python cli.py db_init(唯一入口;也可 psql -d amz_purchase -f 本文件)
-- 目标版本:PostgreSQL 17

CREATE SCHEMA IF NOT EXISTS procure;
CREATE SCHEMA IF NOT EXISTS logistics;
CREATE SCHEMA IF NOT EXISTS ops;

-- ── procure:采购域 ──────────────────────────────────────────────────────

-- 买家号 = 防关联浏览器环境。一个环境 = 一条产能通道
CREATE TABLE IF NOT EXISTS procure.buyer_envs (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code               text NOT NULL UNIQUE,          -- 环境名,如 'env-172'
    marketplace        text NOT NULL DEFAULT 'US',
    amazon_customer_id text,                          -- 插件从页面提取,仅作对账
    status             text NOT NULL DEFAULT 'active',
                                  -- active / paused / blocked / retired(封闭集)
    daily_cap          integer NOT NULL DEFAULT 0,    -- 0 = 不限
    note               text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

-- 插件实例:登记身份用,不发凭据(所有者决定:不做鉴权)
CREATE TABLE IF NOT EXISTS procure.plugin_instances (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    buyer_env_id   bigint NOT NULL REFERENCES procure.buyer_envs(id),
    instance_uid   text NOT NULL UNIQUE,              -- 插件首次启动生成并持久化
    plugin_version text,
    last_seen_at   timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plugin_instances_env
    ON procure.plugin_instances (buyer_env_id);

-- 采购任务
CREATE TABLE IF NOT EXISTS procure.tasks (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    line_key          text NOT NULL UNIQUE,   -- sha256(上游单号|asin) 十六进制
    upstream_order_no text NOT NULL,          -- 上游订单号,便于人工追溯
    buyer_env_id      bigint NOT NULL REFERENCES procure.buyer_envs(id),
    marketplace       text NOT NULL DEFAULT 'US',

    status            text NOT NULL DEFAULT 'pending',
        -- pending   已落库,未放行
        -- ready     可被认领
        -- claimed   已被实例领走,正在执行(在途态:供超时清扫与可观测)
        -- purchased 下单成功,单号已回填
        -- exception 失败,带 error_code
        -- manual    需人工介入
        -- cancelled
        -- (封闭集)

    -- 收货信息(下发给插件填表)
    ship_name         text NOT NULL,
    ship_phone        text NOT NULL,
    ship_line1        text NOT NULL,
    ship_city         text NOT NULL,
    ship_state        text NOT NULL,
    ship_postcode     text NOT NULL,
    ship_country      text NOT NULL DEFAULT 'US',

    -- 护栏输入(price_cap 由上游 ERP 算好下发,本系统只取用不计算)
    price_cap         numeric(12,2) NOT NULL,
    max_delivery_days smallint NOT NULL DEFAULT 7,

    -- 在途
    claimed_by        bigint REFERENCES procure.plugin_instances(id),
    claimed_at        timestamptz,

    -- 执行结果
    amazon_order_no   text,
    actual_total      numeric(12,2),
    actual_shipping   numeric(12,2),
    actual_tax        numeric(12,2),
    payment_last4     text,
    delivery_date     date,
    delivery_raw      text,                   -- Amazon 原始文案,保留供复核
    purchased_at      timestamptz,

    error_code        text,                   -- 见 docs/01-系统设计.md §4
    error_detail      text,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
-- 认领扫描
CREATE INDEX IF NOT EXISTS idx_tasks_ready
    ON procure.tasks (buyer_env_id, created_at) WHERE status = 'ready';
-- 超时清扫
CREATE INDEX IF NOT EXISTS idx_tasks_claimed
    ON procure.tasks (claimed_at) WHERE status = 'claimed';
-- 同一个 Amazon 单号不可能落到两条任务上(回填写错时在库层直接拒绝)
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_amazon_order_no
    ON procure.tasks (amazon_order_no) WHERE amazon_order_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS procure.task_products (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id           bigint NOT NULL REFERENCES procure.tasks(id) ON DELETE CASCADE,
    asin              text NOT NULL,
    quantity          integer NOT NULL CHECK (quantity > 0),
    actual_unit_price numeric(12,2),          -- 结算页实测,回传后填
    image_url         text
);
CREATE INDEX IF NOT EXISTS idx_task_products_task
    ON procure.task_products (task_id);

-- 事件流:只追加。替代厂商系统那一个 failContent 自由文本字段
CREATE TABLE IF NOT EXISTS procure.task_events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id     bigint NOT NULL REFERENCES procure.tasks(id) ON DELETE CASCADE,
    instance_id bigint REFERENCES procure.plugin_instances(id),
    kind        text NOT NULL,   -- claimed / step / guard_block / error / purchased /
                                 -- released / assert_failed / admin(封闭集)
                                 -- admin = 人在后台动的手,与插件跑出来的结果区分开
    code        text,            -- kind 为 error/guard_block 时必填
    payload     jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_events_task
    ON procure.task_events (task_id, created_at);

-- ── logistics:物流域 ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS logistics.shipments (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id      bigint NOT NULL REFERENCES procure.tasks(id) ON DELETE CASCADE,
    carrier      text,
    tracking_no  text,
    tracking_url text,
    status       text,   -- not_shipped / in_transit / delivered / cancelled(封闭集)
    delivered_at timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shipments_task
    ON logistics.shipments (task_id);

CREATE TABLE IF NOT EXISTS logistics.shipment_events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shipment_id bigint NOT NULL REFERENCES logistics.shipments(id) ON DELETE CASCADE,
    happened_at timestamptz,     -- 已归一化
    raw_day     text,            -- Amazon 原文,解析失败时的兜底
    raw_time    text,
    description text,
    city        text,
    state_code  text,
    seq         integer NOT NULL -- 0 = 最新
);
CREATE INDEX IF NOT EXISTS idx_shipment_events_shipment
    ON logistics.shipment_events (shipment_id, seq);

-- ── ops:运行域 ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ops.runs (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow    text NOT NULL,
    params      jsonb,
    started_at  timestamptz NOT NULL,
    finished_at timestamptz,
    status      text NOT NULL,   -- running / success / failed(封闭集)
    summary     text,
    operator    text             -- manual / cron / web(封闭集)
);

CREATE TABLE IF NOT EXISTS ops.cursors (
    name       text PRIMARY KEY,
    value      text,
    updated_at timestamptz NOT NULL DEFAULT now()
);
