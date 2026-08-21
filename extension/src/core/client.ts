/** 每个服务端端点一个方法。路径与请求体只在这里出现一次。 */

import { post, postIdempotent, type ApiOptions, type ApiResult } from "./api.js";
import type { ErrorCode } from "./codes.js";
import type { GuardCheckOut, LineItem, RegisterOut, Task } from "./types.js";

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

  heartbeat(): Promise<ApiResult<{ alive: boolean }>> {
    return postIdempotent("/v1/instances/heartbeat", { instance_uid: this.instanceUid }, this.opts);
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
    actual_total: string;
    actual_shipping?: string;
    actual_tax?: string;
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
    events: Array<Record<string, unknown>>;
  }): Promise<ApiResult<{ shipment_id: number; events: number; status: string | null }>> {
    return post("/v1/shipments/sync", { instance_uid: this.instanceUid, ...body }, this.opts);
  }

  release(taskId: number): Promise<ApiResult<{ task_id: number; status: string }>> {
    return post("/v1/tasks/" + taskId + "/release", { instance_uid: this.instanceUid }, this.opts);
  }
}
