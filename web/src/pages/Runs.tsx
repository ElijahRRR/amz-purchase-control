/** 工作流运行记录。回答一个问题:**该跑的昨天到底跑了没有**。
 *
 * 这一页的重心不在「跑过的都成功了吗」,而在两种更难发现的失败:
 *  1. **一条从来没跑过**。它在「最近运行」列表里根本不出现 —— 没有行就没有痕迹。
 *     所以上面那排卡片按 workflows/ 目录列全,没跑过的也占一格并且标红。
 *  2. **开跑了没了下文**。进程被杀(容器回收、OOM、机器重启)会留下一行停在
 *     running。它跟「正在跑」长得一样,但处置相反:一个是等它,一个是去查它。
 *
 * task_sweep 是全项目唯一必须挂定时的一条 —— 它悄悄停了,claimed 的任务
 * 会一直堆着,而队列看起来一切正常。
 */

import { useEffect, useState } from "react";
import { Card, CardHead } from "@/components/ui/card";
import { Tag, type Tone } from "@/components/ui/tag";
import { api } from "@/lib/api";
import { cn, fullTime, shortTime } from "@/lib/utils";
import type { RunsOut, WorkflowRun } from "@/types";

/** 「多久以前」。这一页看的就是新鲜度,绝对时间反而要在脑子里做一次减法。 */
function ago(sec: number | null): string {
  if (sec === null) return "从未跑过";
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

function dur(sec: number): string {
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

function runTone(r: WorkflowRun | null, scheduled = true): { tone: Tone; label: string } {
  // 从没跑过:该定时的标红,按需跑的只是灰着说一句「按需跑」。
  if (!r) return scheduled
    ? { tone: "solid-red", label: "从未跑过" }
    : { tone: "dashed-zinc", label: "按需跑" };
  if (r.stuck) return { tone: "solid-violet", label: "开跑后没了下文" };
  if (r.status === "running") return { tone: "dashed-amber", label: "正在跑" };
  if (r.status === "failed") return { tone: "solid-red", label: "失败" };
  return { tone: "solid-emerald", label: "成功" };
}

export default function RunsPage() {
  const [data, setData] = useState<RunsOut | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await api.runs();
      if (!alive) return;
      if (r.ok) { setData(r.data); setErr(null); }
      else setErr(r.kind === "transport" ? `连不上服务端:${r.message}` : `${r.code} · ${r.message}`);
    };
    void tick();
    const id = window.setInterval(tick, 15_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const cards = data?.by_workflow ?? [];

  return (
    <>
      <div className="h-12 shrink-0 bg-white border-b border-zinc-100 flex items-center gap-3 px-4">
        <span className="text-[13px] font-medium">工作流记录</span>
        <span className="text-xs text-zinc-500">
          共 <span className="num text-zinc-900">{data?.items.length ?? "—"}</span> 次运行
        </span>
        <span className="ml-auto text-xs text-zinc-400">
          停在「正在跑」超过 {data ? Math.floor(data.stuck_after_seconds / 60) : "—"} 分钟
          就算没了下文 · 每 15 秒刷新
        </span>
      </div>

      <div className="flex-1 p-4 min-h-0 overflow-auto flex flex-col gap-4">
        {err && (
          <div className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm- text-red-700">
            {err}
          </div>
        )}

        {/* 按 workflows/ 目录列全。没跑过的也占一格 —— 「没有行」才是最该看见的那种。 */}
        <div className="grid gap-3" style={{
          gridTemplateColumns: `repeat(${Math.max(1, Math.min(cards.length, 4))}, minmax(0,1fr))`,
        }}>
          {cards.map((c) => {
            const t = c.overdue && c.last && !c.last.stuck
              ? { tone: "solid-red" as Tone, label: "太久没跑" }
              : runTone(c.last, c.scheduled);
            // 只有真该管的才变红。`overdue` 由服务端按「这条该不该定时」算,
            // 界面不自己猜 —— 猜错的代价是一格永远红着的卡片。
            const bad = c.overdue || c.last?.stuck || c.last?.status === "failed";
            return (
              <Card key={c.workflow}
                    className={cn("px-4 py-3 flex flex-col gap-1.5",
                                  bad && "border-red-200 bg-red-50/40")}>
                <div className="flex items-center gap-2">
                  <span className="id text-xs text-zinc-800">{c.workflow}</span>
                  <span className="ml-auto"><Tag tone={t.tone}>{t.label}</Tag></span>
                </div>
                <div className="font-mono text-lg font-semibold tabular-nums text-zinc-900">
                  {ago(c.age_seconds)}
                </div>
                <div className="text-xs+ text-zinc-400 leading-relaxed truncate"
                     title={c.last?.summary ?? ""}>
                  {c.last?.summary
                   ?? (c.scheduled ? "库里没有这条工作流的任何一行运行记录"
                                   : "按需跑,没跑过不算异常")}
                </div>
                {c.scheduled && (
                  <div className={cn("text-xs+ leading-relaxed",
                                     c.overdue ? "text-red-700" : "text-zinc-500")}>
                    该每 {Math.floor((c.expected_seconds ?? 0) / 3600)} 小时至少跑一次
                    {c.overdue && " —— 它停了,claimed 的任务会一直堆着,而队列看起来一切正常"}
                  </div>
                )}
              </Card>
            );
          })}
        </div>

        <Card className="overflow-hidden">
          <CardHead right={<span className="text-xs text-zinc-400">最近 60 次,新的在前</span>}>
            运行流水
          </CardHead>
          <table className="w-full">
            <thead>
              <tr className="bg-zinc-50 border-b border-zinc-200">
                {["工作流", "开跑", "耗时", "触发", "状态", "摘要"].map((h, i) => (
                  <th key={h} className={cn(
                    "h-th px-3 text-2xs font-medium uppercase tracking-wider text-zinc-500 whitespace-nowrap",
                    i === 2 ? "text-right" : "text-left",
                  )}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.items.map((r) => {
                const t = runTone(r);
                return (
                  <tr key={r.id} className={cn("border-b border-zinc-100 last:border-0",
                                               r.stuck && "bg-violet-50/50")}>
                    <td className="px-3 h-row id text-xs+ text-zinc-800">{r.workflow}</td>
                    <td className="px-3 id text-xs+ text-zinc-500" title={fullTime(r.started_at)}>
                      {shortTime(r.started_at)}
                    </td>
                    <td className="px-3 num">{dur(r.seconds)}</td>
                    <td className="px-3 text-xs text-zinc-500">{r.operator ?? "—"}</td>
                    <td className="px-3"><Tag tone={t.tone}>{t.label}</Tag></td>
                    {/* 失败时 summary 是 traceback,一行放不下也不截断成看不懂的一截,
                        用等宽字体让它可读,鼠标停上去看全文。 */}
                    <td className={cn("px-3 py-1.5 text-xs text-zinc-600 max-w-0",
                                      r.status === "failed" && "font-mono text-2xs text-red-700")}>
                      <div className="truncate" title={r.summary ?? ""}>{r.summary ?? "—"}</div>
                    </td>
                  </tr>
                );
              })}
              {data?.items.length === 0 && (
                <tr><td colSpan={6} className="h-20 text-center text-xs text-zinc-400">
                  一次都还没跑过 —— 运行记录由 cli.py 写,跑一条试试:
                  <span className="id ml-1">python cli.py task_sweep</span>
                </td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
