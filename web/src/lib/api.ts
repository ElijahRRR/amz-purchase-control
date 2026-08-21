/** 与服务端说话的唯一出口。
 *
 * 与插件那一侧同一条规矩:**「没说上话」不能当成「没有数据」**。
 * 两者分成 kind,调用方必须分别处理 —— 界面上「查不到」和「服务挂了」
 * 是完全不同的两句话,混成一句会让人去上游翻一个其实好好的单子。
 */

import { getOperator } from "@/lib/operator";
import type {
  BatchResetOut, Envelope, ErrorStats, InstanceRow, Meta, RunsOut, SearchOut, SearchReq,
  Summary, TaskDetail,
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

/** 人工动作统一带上操作人,不靠每个调用点自己记得传 ——
 *  漏传的那一次正好是以后要查的那一次。
 *  调用点显式传了就用它的(目前没有这种调用点,留着是为了不堵死)。 */
const act = <T>(path: string, body: Record<string, unknown> = {}) =>
  post<T>(path, { operator: getOperator(), ...body });

/** CSV 导出。走 fetch 拿 blob 再触发下载,不是一个 <a href> ——
 *  筛选条件是一整个对象,塞不进 query string 而不出岔子(批量单号可能有几百个)。
 *
 *  服务端导的是**整个筛选结果**,不是当前这一页。只导一页是最阴的那种错:
 *  表看着完整、其实少了后面几千行,拿去对账会得出一个错的结论。
 */
export async function downloadTasksCsv(req: SearchReq): Promise<string | null> {
  try {
    const res = await fetch("/v1/admin/tasks/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) return `导出失败:HTTP ${res.status}`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const p = (n: number) => String(n).padStart(2, "0");
    const d = new Date();
    // 文件名用纯 ASCII:中文名在下载、转发邮件、丢到 Windows 共享盘的路上
    // 各有各的编码坑,而这个名字唯一的用处是让人分得清哪次导的。
    a.download = `tasks-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
               + `-${p(d.getHours())}${p(d.getMinutes())}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 会在某些浏览器里赶在下载真正开始之前把 blob 收掉。
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  } catch (e) {
    return `导出失败:${e instanceof Error ? e.message : String(e)}`;
  }
}

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

  releaseTask: (id: number) => act<{ status: string }>(`/v1/admin/tasks/${id}/release`),
  resetTask: (id: number, acknowledged: boolean) =>
    act<{ status: string }>(`/v1/admin/tasks/${id}/reset`, { acknowledged }),
  forceBackfill: (id: number, amazon_order_no: string, note: string) =>
    act<{ status: string }>(`/v1/admin/tasks/${id}/force-backfill`, { amazon_order_no, note }),
  /** 批量重置。**没有 acknowledged 参数,服务端也不接受** —— 一批 30 单给一个
   *  总的「已确认」,那句话是假的:没人一单一单看过 30 个订单页。
   *  能重的都重,不能重的原样报回来让人逐条去点。 */
  batchReset: (task_ids: number[]) =>
    act<BatchResetOut>("/v1/admin/tasks/batch-reset", { task_ids }),
  updateAddress: (id: number, fields: Record<string, string>) =>
    act<{ changed: string[] }>(`/v1/admin/tasks/${id}/address`, fields),
  updateAsin: (id: number, old_asin: string, new_asin: string) =>
    act<{ asin: string }>(`/v1/admin/tasks/${id}/asin`, { old_asin, new_asin }),
};
