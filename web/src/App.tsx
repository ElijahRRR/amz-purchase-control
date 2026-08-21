import { lazy, Suspense, useEffect, useState } from "react";
import { Clock, LayoutGrid, LineChart, UserRound } from "lucide-react";
import { api } from "@/lib/api";
import { getOperator, setOperator } from "@/lib/operator";
import { useRoute, type Page } from "@/lib/route";
import { cn } from "@/lib/utils";
import type { InstanceRow, Summary } from "@/types";
import TasksPage from "@/pages/Tasks";
import InstancesPage from "@/pages/Instances";
import RunsPage from "@/pages/Runs";
// Recharts 一个人就占掉打包体积的一半多,而它只在这一页用。
// 拆出去之后进控制台的首屏少加载 ~400KB —— 那一页多等半秒没人会注意到。
const ErrorsPage = lazy(() => import("@/pages/Errors"));

const NAV: { page: Page; label: string; icon: typeof LayoutGrid; group: string }[] = [
  { page: "tasks", label: "任务队列", icon: LayoutGrid, group: "采购" },
  { page: "instances", label: "买家号", icon: UserRound, group: "采购" },
  { page: "runs", label: "工作流记录", icon: Clock, group: "运行" },
  { page: "errors", label: "错误码分布", icon: LineChart, group: "运行" },
];

/** 侧栏底部那条实例灯。
 *
 * 它是这个界面上唯一一处**不受任何筛选影响**的信息:哪台机器还活着。
 * 定时刷,因为判活是有时限的 —— 一个停在「在线」不动的绿点比没有灯更坏。
 */
function InstanceStrip() {
  const [rows, setRows] = useState<InstanceRow[] | null>(null);
  const [down, setDown] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await api.instances();
      if (!alive) return;
      if (r.ok) { setRows(r.data.items); setDown(false); }
      // 拿不到就说拿不到,**不留着上一次的绿点** —— 那正是「看起来有护栏」的样子。
      else setDown(true);
    };
    void tick();
    const id = window.setInterval(tick, 10_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const color: Record<InstanceRow["liveness"], string> = {
    online: "bg-emerald-500", stale: "bg-amber-500",
    paused: "bg-zinc-400", never: "bg-zinc-300",
  };
  const note: Record<InstanceRow["liveness"], string> = {
    online: "", stale: "失联", paused: "暂停", never: "未连过",
  };

  return (
    <div className="px-4 py-3 border-t border-zinc-100 flex flex-col gap-1.5">
      <div className="text-2xs font-medium uppercase tracking-wider text-zinc-400">插件实例</div>
      {down && <div className="text-xs+ text-amber-600">读不到实例状态</div>}
      {!down && rows?.length === 0 && <div className="text-xs+ text-zinc-400">还没有实例连上来</div>}
      {!down && rows?.map((r) => (
        <div key={r.env_id} className="flex items-center gap-1.5">
          <span className={cn("w-2 h-2 rounded-full shrink-0", color[r.liveness])} />
          <span className={cn("text-xs truncate", r.liveness === "online" ? "text-zinc-700" : "text-zinc-400")}>
            {r.env_code}
          </span>
          <span className="ml-auto font-mono text-xs+ text-zinc-400 shrink-0">
            {note[r.liveness] || (r.last_seen_age_seconds != null ? `${r.last_seen_age_seconds}s` : "—")}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 侧栏底部的「操作人」。
 *
 * 这**不是登录**,是自己填的一个名字。这套东西不做鉴权(所有者定稿),
 * 所以没有可信身份可用;但人工动作会写进事件流,事件流存在的意义正是事后回答
 * 「这个地址是谁改的」—— 一律记 null 的话那句话永远答不上来。
 *
 * 界面上必须写清「不是登录、拦不住任何人」,否则迟早有人把它当成权限。
 */
function OperatorBox() {
  const [name, setName] = useState(getOperator() ?? "");
  return (
    <div className="px-4 py-3 border-t border-zinc-100 flex flex-col gap-1.5">
      <div className="text-2xs font-medium uppercase tracking-wider text-zinc-400">操作人</div>
      <input
        value={name}
        onChange={(e) => { setName(e.target.value); setOperator(e.target.value); }}
        placeholder="填个名字"
        className="h-7 px-2 rounded-md border border-zinc-200 bg-white text-xs text-zinc-800
                   placeholder:text-zinc-400 focus-visible:outline-none focus-visible:border-zinc-900"
      />
      <div className="text-2xs text-zinc-400 leading-relaxed">
        只用来在人工动作上留个名。不是登录,拦不住任何人
      </div>
    </div>
  );
}

export default function App() {
  const [page, go] = useRoute();
  const [summary, setSummary] = useState<Summary | null>(null);

  // 侧栏那个紫色数字是「待人工」——整个界面上唯一需要人主动去处理的那一桶。
  // 放在导航上是为了让它在别的页面也追着人跑。
  const reloadSummary = () =>
    api.summary({}).then((r) => { if (r.ok) setSummary(r.data); });
  useEffect(() => { void reloadSummary(); }, [page]);

  return (
    <div className="h-full flex bg-zinc-50">
      <nav className="w-[200px] shrink-0 bg-white border-r border-zinc-200 flex flex-col">
        <div className="h-12 flex items-center gap-2 px-4 border-b border-zinc-100">
          <span className="w-5 h-5 rounded-[5px] bg-zinc-900 inline-flex items-center justify-center shrink-0">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
            </svg>
          </span>
          <span className="text-[13px] font-semibold">AMZ 采购控制台</span>
        </div>

        {["采购", "运行"].map((group) => (
          <div key={group}>
            <div className="px-4 mt-3 mb-1 text-2xs font-medium uppercase tracking-wider text-zinc-400">
              {group}
            </div>
            {NAV.filter((n) => n.group === group).map((n) => (
              <button
                key={n.page}
                onClick={() => go(n.page)}
                className={cn(
                  "w-full h-8 px-4 flex items-center gap-2 text-[13px]",
                  page === n.page ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-50",
                )}
              >
                <n.icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
                {n.label}
                {n.page === "tasks" && !!summary?.by_status.manual && (
                  // 这个数字是**全局**的,不跟页面上的筛选走 ——
                  // 它的作用是在别的页面也追着人跑。跟状态桶上的数字对不上是正常的,
                  // 但对不上就得说清楚,否则运营会开始怀疑哪个数字是假的。
                  <span title="全部待人工,不受页面筛选影响"
                        className="ml-auto font-mono text-2xs tabular-nums h-4 px-1.5 inline-flex
                                   items-center rounded bg-violet-50 text-violet-700">
                    {summary.by_status.manual}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}

        <span className="mt-auto" />
        <OperatorBox />
        <InstanceStrip />
      </nav>

      <main className="flex-1 flex flex-col min-w-0">
        {/* 顶栏那两个数字由任务页顺手带回来:它每次搜索都会取一份全局 summary,
            取回来又丢掉的话,顶栏会停在进页面那一刻的数值不动 ——
            运营盯着「今日已拍单 128」看半天,以为一单都没再拍出去。 */}
        {page === "tasks" && (
          <TasksPage summary={summary} onMutate={reloadSummary} onSummary={setSummary} />
        )}
        {page === "instances" && <InstancesPage />}
        {page === "runs" && <RunsPage />}
        {page === "errors" && (
          <Suspense fallback={
            <div className="flex-1 flex items-center justify-center text-xs text-zinc-400">加载图表…</div>
          }>
            <ErrorsPage />
          </Suspense>
        )}
      </main>
    </div>
  );
}
