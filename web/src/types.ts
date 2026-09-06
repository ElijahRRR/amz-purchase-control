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
  /** 这一单**正卡在发卡行验证页上等人**(插件报的最后一条 step 是「等待人工完成
   *  支付验证」)。与「拍单中」分开显示 —— 一排 claimed 里,这一条要有人去催
   *  操作员,其余的什么都不用做,而屏幕上它们原先长得一模一样。 */
  awaiting_manual_verification: boolean;
  /** 从什么时候开始等的。**不渲染成一个自己会走的秒表**:这一页不自动刷新,
   *  那样的数字看着是活的、其实停在上一次请求的那一刻。 */
  awaiting_since: string | null;
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
      | "released" | "assert_failed" | "admin" | "auto_retry" | "shipment";
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

export interface TaskSource {
  source: string;
  /** 飞书的 record_id。 */
  external_id: string;
  pushed_at: string | null;
  push_error: string | null;
  /** 上游把这一行删了。删了就不再重试。 */
  gone_at: string | null;
  /** 点进去看那一行。没配 AMZ_FEISHU_TABLE_URL 时是 null ——
   *  不拼一个点了没反应的链接。 */
  url: string | null;
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
  /** 这张任务对应上游(飞书)的哪几行。一张单在表里通常占几行。 */
  sources: TaskSource[];
  /** **系统**自动重拍过几次。人点的重置不计数(那一下背后有人在看),
   *  所以这个数是「机器替你试了几回」,配 meta.auto_retry.max 一起读。 */
  retry_count: number;
  /** 距上次变动过了多久(秒)。对 exception 的单,这就是「失败到现在多久」。
   *
   *  由**服务端**用库里的 now() 算好,不是前端拿浏览器时钟减出来的 ——
   *  自动重试选单量的是同一把尺子,两把尺子对不上的话,界面就会在
   *  「系统还会再试」和「太久了,系统不会碰它」之间说错话。 */
  updated_age_seconds: number;
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
  /** 浏览器 profile 里那个 Amazon 账号此刻还在不在登录态。插件读导航栏判的
   *  (**不读 Cookie**),随心跳报上来。与 liveness 是两条独立的轴:
   *  插件心跳一秒不落,浏览器照样可能已经被登出。 */
  login_state: "ok" | "signed_out" | "unknown";
  /** 上一次真的读过页面判登录态的时刻。没有这一列的话,一个三天前读到的
   *  「已登录」和一分钟前读到的长得一模一样。 */
  login_checked_at: string | null;
  /** 今天拍满了配额。`daily_cap = 0` 表示不限,那时永远是 false。 */
  at_daily_cap: boolean;
  /** 登录态这一项拦不拦派单(= login_state 为 signed_out)。
   *  服务端算的,与认领那道真闸同一个函数 —— 前端**不自己判**。 */
  login_blocks_dispatch: boolean;
  /** 与 task_queue.CLAIM_SQL 那道真闸算同一件事:在线、没到日上限、且没被登出。 */
  dispatchable: boolean;
  /** 最近 24 小时里这个买家号有几单**试着清车但没清动**。
   *
   *  清车是每一单的第一步,它失败通常意味着 Amazon 改了购物车页的结构 ——
   *  于是队列里的单会被一单一单打进「拍单异常」桶,而这一行原先是满格绿色的
   *  「在线 · 可派」。这一位在服务端一直有人写(/fail 的 cart_cleared),
   *  但在此之前没有任何地方读它。 */
  cart_fail_24h: number;
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
  /** 买家号浏览器的 Amazon 登录态。「登录态存疑」与「已登录」是两个词 ——
   *  读不到导航栏和读到了登录着,处置完全不同。 */
  login_state: { labels: Record<string, string>; tone: Record<string, string> };
  error_code: {
    labels: Record<string, string>;
    retryable: string[];
    to_manual: string[];
    /** 业务性拦截:重试没用,处置是改单或放弃。 */
    business_blocked: string[];
    /** 「可能已经下单」—— 这一组的处置方式跟其它失败**相反**:
     *  不能直接退回队列重拍,得先去亚马逊看一眼。它是 to_manual 的子集。 */
    possibly_ordered: string[];
  };
  /** 有界自动重试的现状。界面上凡是提到 RETRYABLE 那一组该怎么办的话,
   *  都必须照这三个值写:
   *   · `enabled=false` → 「需人工重置」。说「系统自己会再试」就是撒谎,
   *     运营会把一桶其实没人管的单晾在那儿
   *   · `enabled=true`  → 「系统最多自动重试 max 次」,再配上这一单已经试过几次
   *
   *  **前端不存副本、也不自己算「开没开」** —— 服务端读的是配置本身
   *  (services/task_retry.config()),与那条定时链选单读的是同一份。 */
  auto_retry: {
    enabled: boolean;
    max: number;
    backoff_min: number;
    /** 失败超过这么多分钟就**不再自动重**,交给人。
     *
     *  它决定的不是「什么时候重」,而是**会不会重** —— 所以凡是写着
     *  「不点它也会被放回队列」的地方都得先过这道闸,否则界面会对着一张
     *  系统永远不会碰的单许一个不会兑现的诺。 */
    max_age_min: number;
    /** 一轮最多重几条。只影响快慢(这一轮没轮到的下一轮还在),
     *  **不影响「会不会被重」,所以界面不拿它写承诺**。 */
    batch: number;
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
