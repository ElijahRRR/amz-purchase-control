/** 每个服务端端点一个方法。路径与请求体只在这里出现一次。 */

import { post, postIdempotent, type ApiOptions, type ApiResult } from "./api.js";
import type { ErrorCode } from "./codes.js";
import type { GuardCheckOut, HeartbeatOut, LineItem, LoginState, RegisterOut, Task } from "./types.js";

export class Client {
  constructor(
    private readonly opts: ApiOptions,
    private readonly instanceUid: string,
  ) {}

  register(envCode: string, pluginVersion: string): Promise<ApiResult<RegisterOut>> {
    return postIdempotent<RegisterOut>("/v1/instances/register", {
      env_code: envCode,
      instance_uid: this.instanceUid,
      plugin_version: pluginVersion,
    }, this.opts);
  }

  /** 心跳,顺带把这一轮读到的登录态捎上去,并收回服务端那句「该不该复检」。
   *
   *  **不传 login_state = 这一轮没有新消息**,服务端原样保留库里那一位;
   *  传 unknown 才是「读了,但读不出来」。两者不是一回事:前者是沉默,
   *  后者是一个结论 —— 把沉默当成 unknown 会让一个已知被登出的买家号
   *  在 20 秒后自己"洗白"成存疑,然后重新被派单。
   *
   *  **unknown 也解不开 signed_out**:服务端只认 ok 这一个解封信号
   *  (services/instance._KEEPS_OLD_LOGIN_STATE)。所以读页面读失败时
   *  这里干脆不传 —— 见 background/loop.ensureLoginChecked 的 catch。
   *
   *  登录态从哪来:插件开一张 Amazon 页面读导航栏(flow/dom/parse.readLoginState)。
   *  **不读 Cookie** —— 插件没申请 cookies 权限,这是架构选择,不是暂缓。 */
  heartbeat(loginState?: LoginState): Promise<ApiResult<HeartbeatOut>> {
    return postIdempotent("/v1/instances/heartbeat", {
      instance_uid: this.instanceUid,
      ...(loginState ? { login_state: loginState } : {}),
    }, this.opts);
  }

  /** 注意返回 data 可以是 null:队列里没有属于本买家号的单。
   *  这**不是**错误 —— 而没说上话是 kind:"transport",两者绝不能混。 */
  claim(): Promise<ApiResult<Task | null>> {
    return post<Task | null>("/v1/tasks/claim", { instance_uid: this.instanceUid }, this.opts);
  }

  events(taskId: number, events: Array<{
    kind: "step" | "guard_block" | "error" | "assert_failed";
    code?: string;
    payload?: Record<string, unknown>;
  }>): Promise<ApiResult<{ recorded: number }>> {
    return post("/v1/tasks/" + taskId + "/events", {
      instance_uid: this.instanceUid,
      events,
    }, this.opts);
  }

  /** 护栏裁决在**服务端**。插件只负责把结算页读到的数报上去。
   *  「如果价格超过限价就…」这类判断放在插件里,等于把闸门交给被管的一方。 */
  guardCheck(taskId: number, reading: {
    /** 这张卡要扣的钱。礼品卡垫过之后它比货款小,全额抵扣时就是 "0.00"。 */
    actual_total: string;
    actual_shipping?: string;
    actual_tax?: string;
    /** 礼品卡/余额抵扣。amount 为 null = 认出抵扣行但读不出金额 ——
     *  服务端拒:货款基数算不出来就不下单。 */
    gift_card?: { applied: boolean; amount: string | null };
    /** 这一单的货款 = 实付 + 礼品卡抵扣。**服务端会自己再算一遍并以自己的为准**,
     *  这里报上去是为了让两边算的数不一致时看得见。 */
    goods_total?: string;
    /** 结算页选中的那张卡的后四位。买家号配了期望卡时服务端拿它比对,
     *  不符即 PAYMENT_METHOD_UNEXPECTED —— **在下单之前**。 */
    payment_last4?: string;
    line_items?: LineItem[];
    delivery_raws?: string[];
    is_fba?: boolean | null;
  }): Promise<ApiResult<GuardCheckOut>> {
    return post("/v1/tasks/" + taskId + "/guard-check", {
      instance_uid: this.instanceUid,
      ...reading,
    }, this.opts);
  }

  complete(taskId: number, body: {
    amazon_order_no: string;
    actual_total?: string;
    actual_shipping?: string;
    actual_tax?: string;
    payment_last4?: string;
    delivery_raw?: string;
    observed_asins: string[];
    /** 结算页读到的实测单价。「上游给的限价」与「实际每件多少钱」是两个数。 */
    line_items?: LineItem[];
  }): Promise<ApiResult<{ task_id: number; status: string }>> {
    return post("/v1/tasks/" + taskId + "/complete", {
      instance_uid: this.instanceUid,
      ...body,
    }, this.opts);
  }

  fail(taskId: number, body: {
    error_code: ErrorCode;
    detail?: string;
    to_manual: boolean;
    cart_cleared: boolean;
  }): Promise<ApiResult<{ task_id: number; status: string }>> {
    return post("/v1/tasks/" + taskId + "/fail", {
      instance_uid: this.instanceUid,
      ...body,
    }, this.opts);
  }

  shipmentPending(limit?: number): Promise<ApiResult<{
    items: Array<{ task_id: number; amazon_order_no: string;
                   upstream_order_no: string; tracking_url: string | null }>;
  }>> {
    return post("/v1/shipments/pending", { instance_uid: this.instanceUid, limit }, this.opts);
  }

  shipmentSync(body: {
    task_id: number;
    order_state?: "ok" | "cancelled" | "not_found";
    carrier?: string;
    tracking_no?: string;
    tracking_url?: string;
    status?: "not_shipped" | "in_transit" | "delivered" | "cancelled";
    /** Amazon 明说这会儿给不了轨迹。与「我们没解析出来」分开记。 */
    tracking_unavailable?: boolean;
    events: Array<Record<string, unknown>>;
  }): Promise<ApiResult<{ shipment_id: number; events: number; status: string | null }>> {
    return post("/v1/shipments/sync", { instance_uid: this.instanceUid, ...body }, this.opts);
  }

  release(taskId: number): Promise<ApiResult<{ task_id: number; status: string }>> {
    return post("/v1/tasks/" + taskId + "/release", { instance_uid: this.instanceUid }, this.opts);
  }
}
