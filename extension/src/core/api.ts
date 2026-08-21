/** 与服务端说话的**唯一**出口。
 *
 * 这一层是照着厂商插件的四个坑反着写的(深度分析 §5.3):
 *
 *  1. **必须有超时。** 厂商全文件 AbortController 命中 0 次,服务端 hang 住则整个
 *     循环无限阻塞,UI 无提示、无法取消。
 *  2. **业务码必须校验。** 厂商只有一个端点判 code===200,其余即使返回
 *     {code:500,msg:"订单不存在"} 也算成功,日志打出「订单状态更新成功: 订单不存在」。
 *  3. **网络失败 ≠ 空结果。** 厂商 getNeedSyncOrders 失败返回 null,调用点当成
 *     「没有需要同步的订单」,运维看日志会以为系统正常。这里用 kind 把两者分开,
 *     调用方**必须**分别处理。
 *  4. **非幂等的写不重试。** 厂商对 4xx/5xx/JSON 解析错一视同仁地重试,
 *     服务端已写入但响应超时时会重复写。
 */

import type { Envelope } from "./types.js";

export type ApiResult<T> =
  | { ok: true; data: T }
  /** 服务端明确说不行:有业务码,状态已经定了 */
  | { ok: false; kind: "business"; code: string; message: string }
  /** 根本没说上话:超时、断网、响应不是 JSON。**状态未知**,不能当成"没有" */
  | { ok: false; kind: "transport"; message: string };

export interface ApiOptions {
  baseUrl: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

async function once<T>(
  path: string,
  body: unknown,
  opts: ApiOptions,
): Promise<ApiResult<T>> {
  const url = opts.baseUrl.replace(/\/+$/, "") + path;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, kind: "transport", message: describe(e) };
  }

  let env: Envelope<T>;
  try {
    env = (await res.json()) as Envelope<T>;
  } catch {
    // 响应不是 JSON —— 可能是反代吐的 HTML 错误页。这不是业务失败,是没说上话。
    return { ok: false, kind: "transport", message: `HTTP ${res.status} 响应不是 JSON` };
  }

  if (!env.ok) {
    return {
      ok: false,
      kind: "business",
      code: env.error?.code ?? `HTTP_${res.status}`,
      message: env.error?.message ?? `HTTP ${res.status}`,
    };
  }
  // 注意:data 可以是 null 且仍然 ok —— /claim 没单可派就是这种。
  return { ok: true, data: env.data as T };
}

function describe(e: unknown): string {
  if (e instanceof DOMException && e.name === "TimeoutError") return "请求超时";
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 写操作:一次就是一次,不重试。
 *
 * complete / fail / release / guard-check 都是非幂等的,重试可能造成重复写。
 */
export function post<T>(path: string, body: unknown, opts: ApiOptions) {
  return once<T>(path, body, opts);
}

/** 幂等操作(注册、心跳)才允许重试一次。 */
export async function postIdempotent<T>(
  path: string,
  body: unknown,
  opts: ApiOptions,
): Promise<ApiResult<T>> {
  const first = await once<T>(path, body, opts);
  // 只有"没说上话"才重试。服务端明确拒绝就是拒绝,再问一遍答案一样。
  if (first.ok || first.kind === "business") return first;
  return once<T>(path, body, opts);
}
