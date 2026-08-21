/** 与 server/schemas.py 一一对应。加字段先改那边,再改这里。 */

export interface Envelope<T> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
}

export type TaskStatus =
  | "pending" | "ready" | "claimed" | "purchased" | "exception" | "manual" | "cancelled";

export interface TaskProduct {
  asin: string;
  quantity: number;
  image_url: string | null;
  actual_unit_price: string | null;
}

export interface TaskRow {
  id: number;
  line_key: string;
  upstream_order_no: string;
  marketplace: string;
  status: TaskStatus;
  ship_name: string;
  ship_phone: string;
  ship_line1: string;
  ship_city: string;
  ship_state: string;
  ship_postcode: string;
  price_cap: string;
  actual_total: string | null;
  actual_shipping: string | null;
  actual_tax: string | null;
  payment_last4: string | null;
  delivery_date: string | null;
  amazon_order_no: string | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  purchased_at: string | null;
  env_code: string;
  amazon_customer_id: string | null;
  /** 「详细」密度那一行照厂商面板做,8 组字段里有物流。列表直接带出来,
   *  免得一屏 50 行去拉 50 次详情 —— 何况行是虚拟滚动的,滚一下又是一批。 */
  carrier: string | null;
  tracking_no: string | null;
  shipment_status: Shipment["status"];
  products: TaskProduct[] | null;
}

export interface SearchOut {
  items: TaskRow[];
  total: number;
  page: number;
  page_size: number;
  by_order_number: boolean;
  missing_order_numbers: string[];
}

export interface TaskEvent {
  kind: "claimed" | "step" | "guard_block" | "error" | "purchased"
      | "released" | "assert_failed" | "admin" | "shipment";
  code: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  instance_uid: string | null;
}

export interface ShipmentEvent {
  happened_at: string | null;
  /** 解析不出时间时的兜底:Amazon 原文。**不丢** —— 解析规则会变,原文不会。 */
  raw_day: string | null;
  raw_time: string | null;
  description: string | null;
  city: string | null;
  state_code: string | null;
  /** 0 = 最新。服务端照原样给,不在那边翻转。 */
  seq: number;
}

export interface Shipment {
  carrier: string | null;
  tracking_no: string | null;
  tracking_url: string | null;
  status: "not_shipped" | "in_transit" | "delivered" | "cancelled" | null;
  delivered_at: string | null;
  events?: ShipmentEvent[];
}

/** 详情接口返回的东西。
 *
 *  **不能直接 extends TaskRow**:TaskRow 里的 carrier / tracking_no /
 *  shipment_status 是列表那条 SQL 用 LATERAL 拼出来的,`_DETAIL_SQL` 是
 *  `SELECT t.*`,那三列压根不在 procure.tasks 上,详情里根本没有。
 *  照 TaskRow 继承的话,类型系统会承诺三个运行时是 undefined 的非空字段 ——
 *  哪天有人照着类型写 `t.carrier.toUpperCase()`,编译器一句话不说,线上白屏。
 *  物流在详情里走 `shipment` 那个对象。 */
export interface TaskDetail extends Omit<TaskRow, "carrier" | "tracking_no" | "shipment_status"> {
  ship_country: string;
  max_delivery_days: number;
  delivery_raw: string | null;
  claimed_by_uid: string | null;
  /** 当初谁执行的。**不是** claimed_by —— 那是在途指针,落终态就清空了。 */
  executed_by_uid: string | null;
  events: TaskEvent[];
  shipment: Shipment | null;
}

export interface InstanceRow {
  env_id: number;
  env_code: string;
  marketplace: string;
  env_status: string;
  amazon_customer_id: string | null;
  daily_cap: number;
  instance_uid: string | null;
  plugin_version: string | null;
  last_seen_at: string | null;
  last_seen_age_seconds?: number;
  queue_depth: number;
  manual_count: number;
  purchased_today: number;
  liveness: "never" | "online" | "stale" | "paused";
  /** 今天拍满了配额。`daily_cap = 0` 表示不限,那时永远是 false。 */
  at_daily_cap: boolean;
  /** 与 task_queue.CLAIM_SQL 那道真闸算同一件事:在线**且**没到日上限。 */
  dispatchable: boolean;
}

export interface SearchReq {
  status?: string | null;
  env_code?: string | null;
  date_field?: "created" | "purchased";
  date_from?: string | null;
  date_to?: string | null;
  order_numbers?: string[];
  asin?: string | null;
  page?: number;
  page_size?: number;
}

/** `GET /v1/admin/meta` 的返回。
 *
 * 封闭集连标签一起由服务端下发,前端**不存副本** —— 这个项目已经因为
 * 「两份副本悄悄分叉」栽过两次(厂商的 subTotal/subtotal、我们自己的 docs 目录树)。
 * 想加一个状态,改 services/vocab.py 一处就够。
 */
export interface Meta {
  task_status: { labels: Record<string, string>; tone: Record<string, string> };
  shipment_status: { labels: Record<string, string>; tone: Record<string, string> };
  event_kind: { labels: Record<string, string>; tone: Record<string, string> };
  error_code: {
    labels: Record<string, string>;
    retryable: string[];
    to_manual: string[];
    /** 业务性拦截:重试没用,处置是改单或放弃。 */
    business_blocked: string[];
    /** 「可能已经下单」—— 这一组的处置方式跟其它失败**相反**:
     *  不能直接退回队列重拍,得先去亚马逊看一眼。它是 to_manual 的子集。 */
    possibly_ordered: string[];
    /** 有没有真的做了自动重试。为 false 时界面**不许**说「系统自己会再试」——
     *  那会让运营把一桶其实没人管的单晾在那儿。 */
    auto_retry_implemented: boolean;
  };
}

export interface Summary {
  /** 七个状态一个都不少,空桶是 0 —— 「异常 0」正是运营最想看到的那句话。 */
  by_status: Record<TaskStatus, number>;
  /** 顶栏两个数字是全局的,不跟着筛选走。 */
  purchased_today: number;
  queue_depth: number;
}

export interface ErrorStatItem {
  code: string;
  n: number;
  by_env: Record<string, number>;
}

export interface ErrorStats {
  items: ErrorStatItem[];
  trend: { day: string; code: string; n: number }[];
  /** 窗口里的每一天,**由服务端给**。前端不自己拼日期 ——
   *  前端拼的是浏览器本地日期,trend 里的 day 走的是 PostgreSQL 会话时区,
   *  两者不一致时(库在 UTC、人在东八区)对不上号的点会被静默丢掉,
   *  折线上那天变成 0,而 0 跟「那天确实一件没出」长得一模一样。 */
  days: string[];
  total: number;
}

export interface WorkflowRun {
  id: number;
  workflow: string;
  params: Record<string, unknown> | null;
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "failed";
  summary: string | null;
  operator: string | null;
  seconds: number;
  /** 停在 running 又超时:不是「在跑」,是「开跑后再没消息」。
   *  这两种的处置相反 —— 一个是等它,一个是去查它。 */
  stuck: boolean;
}

export interface RunsOut {
  items: WorkflowRun[];
  /** 真的总数。`items` 只是最近 `limit` 条 —— 拿 items.length 当总数的话,
   *  它会永远停在 60,而一个不动的计数器比没有计数器更坏。 */
  total: number;
  limit: number;
  /** 每条工作流的最后一次运行。**从没跑过的也在里面**(last 为 null)——
   *  一条从没跑过的 task_sweep 在「最近运行」列表里是看不见的,
   *  而那恰恰是最该报警的情况。 */
  by_workflow: {
    workflow: string;
    last: WorkflowRun | null;
    age_seconds: number | null;
    /** 这条该不该定时跑。按需跑的从没跑过是正常的 —— 把它也标红
     *  会把人训练成忽略红色,等真该报警时那一格红得跟旁边一模一样。 */
    scheduled: boolean;
    expected_seconds: number | null;
    overdue: boolean;
  }[];
  stuck_after_seconds: number;
}

export interface BatchResetOut {
  done: number[];
  /** 「这一条得你亲自去看」—— 可能已经真下过单,不是失败。界面上要跟 failed 分开说。 */
  skipped: { task_id: number; upstream_order_no: string | null; status: string | null;
             error_code: string | null; code: string; message: string }[];
  failed: { task_id: number; upstream_order_no: string | null; status: string | null;
            error_code: string | null; code: string; message: string }[];
  counts: { done: number; skipped: number; failed: number };
}
