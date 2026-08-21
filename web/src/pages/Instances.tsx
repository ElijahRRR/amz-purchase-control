/** 买家号 / 插件实例。回答一个问题:现在有几台机器真的在拍单。
 *
 * 判活是有时限的,所以这一页定时刷。一个停在「在线」不动的绿点比没有灯更坏 ——
 * 那正是「看起来有护栏、实际防不住」的样子。
 */

import { useEffect, useState } from "react";
import { CopyText } from "@/components/CopyText";
import { Card, CardHead } from "@/components/ui/card";
import { Tag, type Tone } from "@/components/ui/tag";
import { api } from "@/lib/api";
import { cn, shortTime } from "@/lib/utils";
import type { InstanceRow } from "@/types";

const LIVENESS: Record<InstanceRow["liveness"], { label: string; tone: Tone; dot: string }> = {
  online: { label: "在线", tone: "solid-emerald", dot: "bg-emerald-500" },
  // 失联用琥珀不用红:机器没心跳不等于出事,但也确实不能派单给它。
  stale: { label: "失联", tone: "dashed-amber", dot: "bg-amber-500" },
  paused: { label: "暂停", tone: "solid-zinc", dot: "bg-zinc-400" },
  never: { label: "未连过", tone: "dashed-zinc", dot: "bg-zinc-300" },
};

export default function InstancesPage() {
  const [rows, setRows] = useState<InstanceRow[] | null>(null);
  const [stale, setStale] = useState<number>(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await api.instances();
      if (!alive) return;
      if (r.ok) { setRows(r.data.items); setStale(r.data.stale_seconds); setErr(null); }
      else setErr(r.kind === "transport" ? `连不上服务端:${r.message}` : `${r.code} · ${r.message}`);
    };
    void tick();
    const id = window.setInterval(tick, 10_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // 还没回来 / 首次就失败时 rows 是 null。硬写 0 的话,「在线 0」跟
  // 「真的一台都没在线」长得一模一样 —— 而这两件事的处置完全不同。
  const online = rows ? rows.filter((r) => r.liveness === "online").length : null;

  return (
    <>
      <div className="h-12 shrink-0 bg-white border-b border-zinc-100 flex items-center gap-3 px-4">
        <span className="text-[13px] font-medium">买家号</span>
        <span className="text-xs text-zinc-500">
          在线 <span className="num text-zinc-900">{online ?? "—"}</span> / {rows?.length ?? "—"}
        </span>
        <span className="ml-auto text-xs text-zinc-400">
          超过 {stale || "—"} 秒没心跳算失联 · 每 10 秒刷新
        </span>
      </div>

      <div className="flex-1 p-4 min-h-0 overflow-auto">
        {err && (
          <div className="mb-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm- text-red-700">
            {err} —— 下面这些数字是上一次读到的,不代表现在
          </div>
        )}
        <Card className="overflow-hidden">
          <CardHead right={<span className="text-xs text-zinc-400">
            派单只会派给「在线且未暂停」的买家号
          </span>}>买家号 · 实例</CardHead>

          <table className="w-full">
            <thead>
              <tr className="bg-zinc-50 border-b border-zinc-200">
                {["买家号", "站点", "实例", "插件版本", "最后心跳", "队列待拍",
                  "待人工", "今日已拍", "日上限", "状态", "可派单"].map((h, i) => (
                  <th key={h} className={cn(
                    "h-th px-3 text-2xs font-medium uppercase tracking-wider text-zinc-500 whitespace-nowrap",
                    // 只有数字列右对齐:数字右对齐是为了让位数对齐着看,
                    // 时间和文字右对齐只会在中间留一条空沟。
                    i >= 5 && i <= 8 ? "text-right" : "text-left",
                  )}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows?.map((r) => {
                const L = LIVENESS[r.liveness];
                return (
                  <tr key={r.env_id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50">
                    <td className="px-3 h-row text-xs">
                      <span className="flex items-center gap-1.5">
                        <span className={cn("w-2 h-2 rounded-full shrink-0", L.dot)} />
                        {r.env_code}
                      </span>
                    </td>
                    <td className="px-3 text-xs text-zinc-500">{r.marketplace}</td>
                    <td className="px-3">
                      <CopyText value={r.instance_uid} className="id text-xs+" icon={false} />
                    </td>
                    <td className="px-3 id text-xs+ text-zinc-500">{r.plugin_version ?? "—"}</td>
                    <td className="px-3 id text-xs+ text-zinc-500">
                      {r.last_seen_at ? shortTime(r.last_seen_at) : "从未"}
                    </td>
                    <td className="px-3 num">{r.queue_depth}</td>
                    <td className={cn("px-3 num", r.manual_count > 0 && "text-violet-700 font-medium")}>
                      {r.manual_count}
                    </td>
                    <td className="px-3 num">{r.purchased_today}</td>
                    <td className="px-3 num text-zinc-500">
                      {/* 0 是「不限」,不是「一单都不许拍」。这两个意思差得远,
                          界面上写清楚,别让人去猜一个裸 0。 */}
                      {r.daily_cap === 0 ? "不限" : r.daily_cap}
                    </td>
                    <td className="px-3"><Tag tone={L.tone}>{L.label}</Tag></td>
                    <td className="px-3 text-xs">
                      {/* 「已到日上限」这一支以前永远走不到 ——
                          服务端的 dispatchable 只看在线,不看 daily_cap,与真正
                          那道闸(task_queue.CLAIM_SQL)分叉着。现在两边算同一件事了。 */}
                      {r.dispatchable
                        ? <span className="text-emerald-700">可派</span>
                        : <span className={r.at_daily_cap ? "text-amber-700" : "text-zinc-400"}>
                            {r.liveness === "paused" ? "已暂停"
                             : r.at_daily_cap ? "已到日上限"
                             : r.liveness === "online" ? "在线但不可派" : "没有心跳"}
                          </span>}
                    </td>
                  </tr>
                );
              })}
              {rows === null && (
                <tr><td colSpan={12} className="h-20 text-center text-xs text-zinc-400">
                  {err ? "读不到买家号列表" : "读取中…"}
                </td></tr>
              )}
              {rows?.length === 0 && (
                <tr><td colSpan={12} className="h-20 text-center text-xs text-zinc-400">
                  还没有买家号 —— 先在库里建 procure.buyer_envs,再让插件连上来
                </td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
