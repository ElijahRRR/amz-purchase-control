/** 18 个错误码 —— 封闭集,与 docs/01-系统设计.md §4 一字不差。
 *
 * 写成联合类型而不是 string:拼错的码编译期就炸,不会等到服务端拒收。
 * 厂商那套 18 处失败全写成 status=99 加一句自由中文,没法按原因统计、
 * 也没法建处置 SOP(分析 §6.1)。
 */

export const ERROR_CODES = [
  "OUT_OF_STOCK",
  "QTY_UNAVAILABLE",
  "ADD_TO_CART_FAILED",
  "BUNDLE_PRODUCT",
  "NOT_FBA",
  "CART_MISMATCH",
  "ADDRESS_FORM_TIMEOUT",
  "ADDRESS_STATE_UNMATCHED",
  "ADDRESS_SUGGESTION_BLOCKED",
  "PRICE_CAP_EXCEEDED",
  "DELIVERY_TOO_LATE",
  "DELIVERY_UNPARSEABLE",
  "CHECKOUT_TIMEOUT",
  "ORDER_CONFIRM_TIMEOUT",
  "ORDER_NO_AMBIGUOUS",
  "CAPTCHA_ENCOUNTERED",
  "CLAIM_TIMEOUT",
  "PLUGIN_INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 界面标签。界面上只出现中文,英文码降为旁边的灰色小字(docs/03 §3.9)。 */
export const ERROR_LABEL: Record<ErrorCode, string> = {
  OUT_OF_STOCK: "商品无货",
  QTY_UNAVAILABLE: "数量不可选",
  ADD_TO_CART_FAILED: "加购后未跳转",
  BUNDLE_PRODUCT: "捆绑商品",
  NOT_FBA: "非 Amazon 配送",
  CART_MISMATCH: "购物车与任务不符",
  ADDRESS_FORM_TIMEOUT: "地址表单超时",
  ADDRESS_STATE_UNMATCHED: "州匹配失败",
  ADDRESS_SUGGESTION_BLOCKED: "地址不可投递",
  PRICE_CAP_EXCEEDED: "实付超限价",
  DELIVERY_TOO_LATE: "交期超限",
  DELIVERY_UNPARSEABLE: "交期无法解析",
  CHECKOUT_TIMEOUT: "结算页超时",
  ORDER_CONFIRM_TIMEOUT: "未见确认页",
  ORDER_NO_AMBIGUOUS: "单号对不上",
  CAPTCHA_ENCOUNTERED: "命中验证码",
  CLAIM_TIMEOUT: "认领超时未回传",
  PLUGIN_INTERNAL: "插件内部异常",
};

/** 可自动重试:页面慢或结构没等到,重置回待拍单即可。 */
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "ADD_TO_CART_FAILED",
  "CART_MISMATCH",
  "ADDRESS_FORM_TIMEOUT",
  "CHECKOUT_TIMEOUT",
  "PLUGIN_INTERNAL",
]);

/** 必须转人工,禁止自动重试。
 *
 * 前三个的共同点是**可能已经在 Amazon 上真下了单**,重试就是重复下单;
 * 后四个是护栏拦截与风控,重试多少次结果都一样,要人来裁决。
 */
export const TO_MANUAL: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "ORDER_CONFIRM_TIMEOUT",
  "ORDER_NO_AMBIGUOUS",
  "CLAIM_TIMEOUT",
  "PRICE_CAP_EXCEEDED",
  "DELIVERY_TOO_LATE",
  "DELIVERY_UNPARSEABLE",
  "CAPTCHA_ENCOUNTERED",
]);

export function toManual(code: ErrorCode): boolean {
  return TO_MANUAL.has(code);
}

export function label(code: string): string {
  return ERROR_LABEL[code as ErrorCode] ?? code;
}
