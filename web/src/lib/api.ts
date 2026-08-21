/** 与服务端说话的唯一出口。
 *
 * 与插件那一侧同一条规矩:**「没说上话」不能当成「没有数据」**。
 * 两者分成 kind,调用方必须分别处理 —— 界面上「查不到」和「服务挂了」
 * 是完全不同的两句话,混成一句会让人去上游翻一个其实好好的单子。
 */

import type {
  Envelope, ErrorStats, InstanceRow, Meta, RunsOut, SearchOut, SearchReq, Summary,
  TaskDetail,
} from "@/types";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "business"; code: string; message: string }
  | { ok: false; kind: "transport"; message: string };

const TIMEOUT_MS = 15_000;

async function call<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof DOMException && e.name === "TimeoutError"
      ? "请求超时" : e instanceof Error ? e.message : String(e);
    return { ok: false, kind: "transport", message: msg };
  }

  let env: Envelope<T>;
  try {
    env = (await res.json()) as Envelope<T>;
  } catch {
    return { ok: false, kind: "transport", message: `HTTP ${res.status} 响应不是 JSON` };
  }
  if (!env.ok) {
    return {
      ok: false, kind: "business",
      code: env.error?.code ?? `HTTP_${res.status}`,
      message: env.error?.message ?? `HTTP ${res.status}`,
    };
  }
  return { ok: true, data: env.data as T };
}

/** 空值不进 query string —— `?env_code=` 与「没传」在服务端是两回事,
 *  前者会被当成一个叫空串的买家号,查出零条来。 */
const qs = (o: Record<string, unknown>) =>
  new URLSearchParams(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => [k, String(v)]),
  ).toString();

const post = <T>(path: string, body: unknown) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  searchTasks: (req: SearchReq) => post<SearchOut>("/v1/admin/tasks/search", req),
  taskDetail: (id: number) => call<TaskDetail>(`/v1/admin/tasks/${id}`),
  meta: () => call<Meta>("/v1/admin/meta"),
  summary: (q: { env_code?: string | null; date_field?: string;
                 date_from?: string | null; date_to?: string | null }) =>
    call<Summary>(`/v1/admin/summary?${qs(q)}`),
  errorStats: (q: { date_from?: string | null; date_to?: string | null }) =>
    call<ErrorStats>(`/v1/admin/error-stats?${qs(q)}`),
  runs: () => call<RunsOut>("/v1/admin/runs"),
  instances: () => call<{ stale_seconds: number; items: InstanceRow[] }>("/v1/admin/instances"),

  releaseTask: (id: number) => post<{ status: string }>(`/v1/admin/tasks/${id}/release`, {}),
  resetTask: (id: number, acknowledged: boolean, operator?: string) =>
    post<{ status: string }>(`/v1/admin/tasks/${id}/reset`, { acknowledged, operator }),
  forceBackfill: (id: number, amazon_order_no: string, note: string, operator?: string) =>
    post<{ status: string }>(`/v1/admin/tasks/${id}/force-backfill`,
                             { amazon_order_no, note, operator }),
  updateAddress: (id: number, fields: Record<string, string>, operator?: string) =>
    post<{ changed: string[] }>(`/v1/admin/tasks/${id}/address`, { ...fields, operator }),
  updateAsin: (id: number, old_asin: string, new_asin: string, operator?: string) =>
    post<{ asin: string }>(`/v1/admin/tasks/${id}/asin`, { old_asin, new_asin, operator }),
};
