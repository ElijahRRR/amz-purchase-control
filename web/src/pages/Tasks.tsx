/** 任务队列。整个控制台的主界面。
 *
 * 筛选条的取舍照 docs/03-运营台字段对照.md §1 —— 那是对着厂商面板 9 个筛选做的,
 * 谁要谁不要都有理由。这里落到界面上的是:状态桶、创建/采购二选一的时间维度、
 * 买家号、批量单号、ASIN。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, List, RotateCcw } from "lucide-react";
import { TaskTable, type Density } from "@/components/TaskTable";
import { TaskDetailModal } from "@/components/TaskDetail";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { api, downloadTasksCsv } from "@/lib/api";
import { useMeta } from "@/lib/meta";
import { cn } from "@/lib/utils";
import type {
  BatchResetOut, InstanceRow, SearchOut, SearchReq, Summary, TaskStatus,
} from "@/types";

type Range = "today" | "7d" | "30d" | "all";

const RANGES: { key: Range; label: string }[] = [
  { key: "today", label: "今天" }, { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" }, { key: "all", label: "全部" },
];

/** 本地日期,不用 toISOString —— 那个先转 UTC,东八区的「今天」会被算成昨天。 */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function rangeToDates(r: Range): { date_from: string | null; date_to: string | null } {
  if (r === "all") return { date_from: null, date_to: null };
  const now = new Date();
  const days = r === "today" ? 0 : r === "7d" ? 6 : 29;
  const from = new Date(now);
  from.setDate(from.getDate() - days);
  return { date_from: ymd(from), date_to: ymd(now) };
}

const Seg = ({ options, value, onChange }: {
  options: { key: string; label: string }[];
  value: string; onChange: (k: string) => void;
}) => (
  <span className="h-[30px] inline-flex items-center border border-zinc-200 rounded-md overflow-hidden bg-white">
    {options.map((o) => (
      <button key={o.key} onClick={() => onChange(o.key)}
              className={cn("h-full px-2.5 text-xs",
                            value === o.key ? "bg-zinc-900 text-white" : "text-zinc-500 hover:bg-zinc-50")}>
        {o.label}
      </button>
    ))}
  </span>
);

const Fld = ({ on, children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean }) => (
  <button {...p} className={cn(
    "h-[30px] inline-flex items-center gap-1.5 px-2.5 border rounded-md bg-white text-xs whitespace-nowrap",
    on ? "border-zinc-900 shadow-[inset_0_0_0_1px_#18181b] text-zinc-900"
       : "border-zinc-200 text-zinc-600 hover:bg-zinc-50",
  )}>{children}</button>
);

export default function TasksPage({ summary, onMutate }: {
  summary: Summary | null; onMutate: () => void;
}) {
  const meta = useMeta();

  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [envCode, setEnvCode] = useState<string | null>(null);
  const [dateField, setDateField] = useState<"created" | "purchased">("created");
  const [range, setRange] = useState<Range>("7d");
  const [asin, setAsin] = useState("");
  const [batchText, setBatchText] = useState("");
  const [batchOn, setBatchOn] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [density, setDensity] = useState<Density>("detail");
  const [page, setPage] = useState(1);

  const [out, setOut] = useState<SearchOut | null>(null);
  const [scoped, setScoped] = useState<Summary | null>(null);
  const [envs, setEnvs] = useState<InstanceRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [batchResult, setBatchResult] = useState<BatchResetOut | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => { void api.instances().then((r) => r.ok && setEnvs(r.data.items)); }, []);

  const dates = useMemo(() => rangeToDates(range), [range]);

  /** 导出用的条件必须和列表**完全一致**,所以从同一处算出来 ——
   *  两边各拼一份的话,改了筛选却忘了改导出,导出来的会是另一批单子。 */
  const query = (): SearchReq => ({
    status: batchOn ? null : status,
    env_code: batchOn ? null : envCode,
    date_field: dateField,
    date_from: batchOn ? null : dates.date_from,
    date_to: batchOn ? null : dates.date_to,
    order_numbers: batchOn ? batchText.split("\n") : [],
    asin: asin.trim() || null,
  });

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api.searchTasks({ ...query(), page, page_size: 50 });
    setLoading(false);
    if (r.ok) { setOut(r.data); setErr(null); }
    // 「查不到」和「服务挂了」在界面上是两句话。混成一句会让人跑去上游翻一张其实好好的单。
    else { setErr(r.kind === "transport" ? `连不上服务端:${r.message}` : `${r.code} · ${r.message}`); }
  }, [status, envCode, dateField, dates, asin, page, batchOn, batchText]);

  useEffect(() => { void load(); }, [load]);

  // 状态桶上的数字要跟着其它筛选走,否则点进去数量对不上,像是界面丢了单。
  useEffect(() => {
    if (batchOn) return;   // 批量单号盖过状态桶,那时整排藏起来
    void api.summary({ env_code: envCode, date_field: dateField, ...dates })
      .then((r) => { if (r.ok) setScoped(r.data); });
  }, [envCode, dateField, dates, batchOn, out]);

  useEffect(() => { setPage(1); }, [status, envCode, dateField, range, asin, batchOn]);
  useEffect(() => { setCursor(0); }, [out]);
  // 换了筛选/翻了页就清空勾选。留着的话,「重置选中的 12 条」会包含
  // 现在根本看不见的单 —— 那正是批量动作最容易出事的地方。
  useEffect(() => { setChecked(new Set()); setBatchResult(null); },
            [status, envCode, dateField, range, asin, batchOn, page]);

  // J/K 移动,⏎ 打开。一屏几十行,手不用离开键盘。
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (selected !== null) return;                       // 弹窗开着时让给弹窗
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;    // 正在打字就不是快捷键
      const n = out?.items.length ?? 0;
      if (!n) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, n - 1)); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); setSelected(out!.items[cursor].id); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [out, cursor, selected]);

  const reset = () => {
    setStatus(null); setEnvCode(null); setDateField("created"); setRange("7d");
    setAsin(""); setBatchOn(false); setBatchText(""); setBatchOpen(false);
  };

  const batchCount = batchText.split("\n").filter((s) => s.trim()).length;
  const counts = scoped?.by_status;

  return (
    <>
      <div className="h-12 shrink-0 bg-white border-b border-zinc-100 flex items-center gap-3 px-4">
        <span className="text-[13px] font-medium">任务队列</span>
        <span className="text-xs text-zinc-500">
          今日已拍单 <span className="num text-zinc-900">{summary?.purchased_today ?? "—"}</span>
        </span>
        <span className="text-xs text-zinc-500">
          队列待拍 <span className="num text-zinc-900">{summary?.queue_depth ?? "—"}</span>
        </span>
        <span className="ml-auto text-xs text-zinc-400">
          {loading ? "查询中…" : out ? `${out.total} 条` : ""}
        </span>
        <Button size="sm" disabled={exporting || !out?.total}
                title={out ? `导出当前筛选下的全部 ${out.total} 条,不只是这一页` : ""}
                onClick={async () => {
                  setExporting(true);
                  const e = await downloadTasksCsv(query());
                  setExporting(false);
                  if (e) setErr(e);
                }}>
          <Download className="w-3 h-3" />{exporting ? "导出中…" : "导出 CSV"}
        </Button>
      </div>

      <div className="shrink-0 bg-white border-b border-zinc-200 flex flex-col">
        <div className="h-11 flex items-center gap-1.5 px-4 overflow-x-auto">
          <span className="text-xs+ font-medium uppercase tracking-wider text-zinc-400 mr-0.5">状态</span>
          {batchOn ? (
            <span className="text-xs text-zinc-400">批量单号生效中,状态桶不参与筛选</span>
          ) : (
            <>
              <button onClick={() => setStatus(null)}
                      className={cn("inline-flex items-center gap-1.5 h-[26px] px-2 rounded text-xs whitespace-nowrap",
                                    status === null ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100")}>
                全部
              </button>
              {Object.keys(meta.task_status.labels).map((k) => {
                const n = counts?.[k as TaskStatus];
                return (
                  <button key={k} onClick={() => setStatus(k as TaskStatus)}
                          className={cn("inline-flex items-center gap-1.5 h-[26px] px-2 rounded text-xs whitespace-nowrap",
                                        status === k ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100")}>
                    {meta.task_status.labels[k]}
                    <span className={cn("num text-xs+", status === k ? "text-zinc-300" : "text-zinc-400")}>
                      {n ?? "—"}
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>

        <div className="min-h-[52px] flex items-center gap-2 px-4 py-2 border-t border-zinc-100 flex-wrap">
          <span className="text-xs+ font-medium uppercase tracking-wider text-zinc-400">时间</span>
          <Seg options={[{ key: "created", label: "创建时间" }, { key: "purchased", label: "采购时间" }]}
               value={dateField} onChange={(k) => setDateField(k as "created" | "purchased")} />
          {RANGES.map((r) => (
            <Fld key={r.key} on={range === r.key} onClick={() => setRange(r.key)}>{r.label}</Fld>
          ))}

          <span className="w-px h-5 bg-zinc-200 mx-0.5" />
          <span className="text-xs+ font-medium uppercase tracking-wider text-zinc-400">买家号</span>
          <select value={envCode ?? ""} onChange={(e) => setEnvCode(e.target.value || null)}
                  className="h-[30px] px-2 border border-zinc-200 rounded-md bg-white text-xs text-zinc-700">
            <option value="">全部</option>
            {envs.map((e) => <option key={e.env_id} value={e.env_code}>{e.env_code}</option>)}
          </select>

          <span className="w-px h-5 bg-zinc-200 mx-0.5" />
          <Fld on={batchOpen || batchOn} onClick={() => setBatchOpen((v) => !v)}>
            <List className="w-3 h-3" />批量单号{batchOn && ` · ${batchCount}`}
          </Fld>
          <Input value={asin} onChange={(e) => setAsin(e.target.value)}
                 placeholder="ASIN" className="h-[30px] w-[124px] font-mono" />

          <span className="ml-auto" />
          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCcw className="w-3 h-3" />重置
          </Button>
          <span className="text-xs+ font-medium uppercase tracking-wider text-zinc-400">行密度</span>
          <Seg options={[{ key: "detail", label: "详细" }, { key: "compact", label: "紧凑" }]}
               value={density} onChange={(k) => setDensity(k as Density)} />
        </div>

        {batchOpen && (
          <div className="border-t border-zinc-100 bg-zinc-50 px-4 py-3 flex gap-3.5 items-start">
            <div className="w-[420px] shrink-0 flex flex-col gap-1.5">
              <div className="text-xs text-zinc-700">批量单号 · 每行一个,上游单号和 AMZ 单号可以混着粘</div>
              <Textarea value={batchText} onChange={(e) => setBatchText(e.target.value)}
                        className="h-[88px]" placeholder={"UP-20841\n111-4820193-7736441"} />
            </div>
            <div className="flex-1 flex flex-col gap-1.5 pt-5">
              <div className="text-xs text-zinc-500 leading-relaxed max-w-[560px]">
                粘进来的号会自己分流:形如 <span className="id text-zinc-700">111-xxxxxxx-xxxxxxx</span> 的
                按 AMZ 单号查,其余按上游单号查 —— 运营手里的表两种号混排是常态,不该逼人先分好类再贴。
              </div>
              <div className="text-xs text-zinc-500 leading-relaxed">
                批量单号一旦生效就<span className="text-zinc-900">盖过状态桶和时间范围</span>。
              </div>
              <div className="flex gap-2 mt-0.5">
                <Button size="sm" variant="primary" disabled={!batchCount}
                        onClick={() => { setBatchOn(true); setBatchOpen(false); }}>
                  按 {batchCount} 个单号筛选
                </Button>
                <Button size="sm" onClick={() => { setBatchText(""); setBatchOn(false); }}>清空</Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {batchOn && out?.by_order_number && (
        <div className="shrink-0 min-h-9 bg-zinc-50 border-b border-zinc-200 flex items-center gap-2 px-4 py-1.5 flex-wrap">
          <Tag tone="dashed-sky">批量单号 {batchCount} 个</Tag>
          <span className="text-xs text-zinc-500">
            已盖过状态桶与时间范围 · 匹配{" "}
            <span className="num text-zinc-900">{batchCount - out.missing_order_numbers.length}</span> / {batchCount}
          </span>
          {/* 一个都没匹配上的号要原样报回来。厂商面板在这里是静默的 ——
              粘 100 个号回来 87 条,运营不会知道少了哪 13 个。 */}
          {out.missing_order_numbers.length > 0 && (
            <span className="text-xs text-amber-700 min-w-0">
              查不到:<span className="id text-xs+">{out.missing_order_numbers.join(", ")}</span>
            </span>
          )}
          <span className="ml-auto" />
          <Button variant="ghost" size="sm" onClick={() => setBatchOn(false)}>取消批量筛选</Button>
        </div>
      )}

      {checked.size > 0 && (
        <div className="shrink-0 min-h-9 bg-zinc-900 text-white flex items-center gap-2 px-4 py-1.5">
          <span className="text-xs">已选 <span className="num text-white">{checked.size}</span> 条</span>
          <span className="text-xs+ text-zinc-400">只有拍单异常 / 待人工的能选</span>
          <span className="ml-auto" />
          <Button size="sm" variant="ghost" className="text-zinc-300 hover:bg-zinc-800"
                  onClick={() => setChecked(new Set())}>取消选择</Button>
          <Button size="sm" variant="secondary" disabled={resetting}
                  onClick={async () => {
                    setResetting(true);
                    const r = await api.batchReset([...checked]);
                    setResetting(false);
                    if (r.ok) {
                      setBatchResult(r.data);
                      setChecked(new Set());
                      void load();
                      onMutate();
                    } else {
                      setErr(r.kind === "transport" ? `没说上话:${r.message}`
                                                    : `${r.code} · ${r.message}`);
                    }
                  }}>
            {resetting ? "重置中…" : `重置这 ${checked.size} 条回待拍单`}
          </Button>
        </div>
      )}

      {/* 批量结果。三份清单分开说 —— 「跳过」不是失败,是「这几条得你亲自去看」,
          混进失败里会让人以为系统出了问题,于是重试,于是绕过那道闸。 */}
      {batchResult && (
        <div className="shrink-0 bg-zinc-50 border-b border-zinc-200 px-4 py-2.5 flex flex-col gap-1.5">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-emerald-700">
              已重置 <span className="num text-emerald-700">{batchResult.counts.done}</span> 条
            </span>
            {batchResult.counts.skipped > 0 && (
              <span className="text-violet-700">
                跳过 <span className="num text-violet-700">{batchResult.counts.skipped}</span> 条
              </span>
            )}
            {batchResult.counts.failed > 0 && (
              <span className="text-red-700">
                失败 <span className="num text-red-700">{batchResult.counts.failed}</span> 条
              </span>
            )}
            <span className="ml-auto" />
            <Button size="sm" variant="ghost" onClick={() => setBatchResult(null)}>知道了</Button>
          </div>
          {batchResult.skipped.length > 0 && (
            <div className="text-xs text-violet-700 leading-relaxed">
              这几条<b className="font-medium">可能已经在亚马逊上真下成了</b>,批量不替你确认 ——
              点开逐条去买家号的订单页看过再重置:
              <span className="id ml-1">
                {batchResult.skipped.map((x) => x.upstream_order_no).join(", ")}
              </span>
            </div>
          )}
          {batchResult.failed.length > 0 && (
            <div className="text-xs text-red-700 leading-relaxed">
              这几条服务端拒了:
              {batchResult.failed.map((x) => (
                <span key={x.task_id} className="ml-1">
                  <span className="id">{x.upstream_order_no ?? x.task_id}</span>
                  <span className="text-zinc-500">({x.message})</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 p-4 min-h-0 flex">
        <section className="flex-1 flex flex-col min-w-0 bg-white border border-zinc-200 rounded-lg overflow-hidden">
          {err && (
            <div className="px-4 py-2.5 bg-red-50 border-b border-red-200 text-sm- text-red-700">{err}</div>
          )}
          {out && out.items.length === 0 && !err ? (
            <div className="flex-1 flex items-center justify-center text-xs text-zinc-400">
              这个条件下没有单子 —— 服务端答了,只是答案是零条
            </div>
          ) : (
            <TaskTable rows={out?.items ?? []} density={density} selectedId={selected}
                       cursor={cursor} onPick={(r) => setSelected(r.id)}
                       checked={checked}
                       onCheck={(id, on) => setChecked((prev) => {
                         const next = new Set(prev);
                         if (on) next.add(id); else next.delete(id);
                         return next;
                       })}
                       onCheckAll={(on) => setChecked(() => {
                         if (!on) return new Set();
                         return new Set((out?.items ?? [])
                           .filter((r) => r.status === "exception" || r.status === "manual")
                           .map((r) => r.id));
                       })} />
          )}

          <div className="h-9 shrink-0 border-t border-zinc-100 flex items-center px-3 gap-2.5">
            <span className="text-xs text-zinc-500">
              {out ? `第 ${out.page} 页 · 共 ${out.total} 条` : ""}
            </span>
            <Button size="sm" variant="ghost" disabled={!out || out.page <= 1}
                    onClick={() => setPage((p) => p - 1)}>上一页</Button>
            <Button size="sm" variant="ghost"
                    disabled={!out || out.page * out.page_size >= out.total}
                    onClick={() => setPage((p) => p + 1)}>下一页</Button>
            <span className="ml-auto text-xs+ text-zinc-400">
              按 <Kbd>J</Kbd> / <Kbd>K</Kbd> 移动 · <Kbd>⏎</Kbd> 打开 · 每页 50
            </span>
          </div>
        </section>
      </div>

      {selected !== null && (
        <TaskDetailModal taskId={selected} onClose={() => setSelected(null)}
                         onMutate={() => { void load(); onMutate(); }} />
      )}
    </>
  );
}

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="font-mono text-2xs px-1.5 py-px border border-zinc-200 border-b-2 rounded bg-zinc-50 text-zinc-600">
    {children}
  </kbd>
);
