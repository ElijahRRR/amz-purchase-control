/** 插件侧的契约类型,与 server/schemas.py 一一对应。
 *
 * 这里是**唯一**的一份。厂商那套「文档写 subTotal、插件发 subtotal」的字段错位
 * (深度分析 M7)就是靠多处副本产生的 —— 加字段先改 server/schemas.py,再改这里。
 */

/** 服务端统一信封。插件只需要认这一种响应形状。 */
export interface Envelope<T> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
}

export interface Shipping {
  name: string;
  phone: string;
  line1: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
}

export interface Product {
  asin: string;
  quantity: number;
}

export interface Guards {
  /** 上游 ERP 算好下发,插件只取用不计算。JSON 里是字符串,不转 number —— 钱不过浮点。 */
  price_cap: string;
  max_delivery_days: number;
  require_fba: boolean;
}

export interface Task {
  task_id: number;
  marketplace: string;
  shipping: Shipping;
  products: Product[];
  guards: Guards;
}

/** 买家号浏览器里的 Amazon 登录态。判定在 flow/dom/parse.readLoginState。
 *  与服务端 procure.plugin_instances.login_state 的封闭集一字不差。 */
export type LoginState = "ok" | "signed_out" | "unknown";

export interface HeartbeatOut {
  alive: boolean;
  /** 服务端最终记下的那一位(不是我们刚报的那一位 —— 没报时它是库里原来的值)。 */
  login_state: LoginState;
  /** 服务端的回话:这个买家号有单在等派,且上次读页面已经过了复检间隔,
   *  下一轮认领前去读一次导航栏。策略在服务端,改它不用发新插件版本。 */
  login_check_due: boolean;
}

export interface RegisterOut {
  instance_id: number;
  buyer_env_id: number;
  env_status: string;
}

export interface GuardCheckOut {
  allow: boolean;
  error_code: string | null;
  detail: string | null;
  delivery_date: string | null;
  /** 服务端最终采信的那条交期原文。回填时原样带回,别自己另挑一条。 */
  delivery_raw_used: string | null;
}

export interface LineItem {
  asin: string;
  unit_price: string;
  quantity: number;
}
