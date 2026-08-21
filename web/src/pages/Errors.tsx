/** 错误码分布。回答的是「最近在哪儿卡住」,不是「一共失败了多少」。
 *
 * 三个切面:
 *  · 总数说明轻重
 *  · 分买家号说明是不是某一台机器的问题(某个买家号被风控了,只有它在报同一个码)
 *  · 按天说明是一直这样还是昨天开始的 —— 后者往往对应一次亚马逊改版
 *
 * 颜色按错误码的三个集合分,不按「好看」分:三组的**处置方式完全不同**,
 * 混在一起看就等于没分。
 */

import { useEffect, useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Card, CardHead } from "@/components/ui/card";
import { Tag, type Tone } from "@/components/ui/tag";
import { api } from "@/lib/api";
import { useMeta } from "@/lib/meta";
import { cn } from "@/lib/utils";
import type { ErrorStats } from "@/types";

/** 三组各自一个颜色。与列表里的标签色调保持一致 —— 同一个码在两页不该换脸。 */
const GROUP = {
  possibly_ordered: { label: "可能已下单", hex: "#8b5cf6", tone: "solid-violet" as Tone,
                      why: "处置方式跟别的相反:不能直接退回队列重拍,先去亚马逊看一眼" },
  to_manual: { label: "转人工", hex: "#f59e0b", tone: "dashed-amber" as Tone,
               why: "护栏拦截或风控,重试多少次结果都一样,要人来裁决" },
  business_blocked: { label: "业务拦截", hex: "#71717a", tone: "solid-zinc" as Tone,
                      why: "无货、非 FBA、地址不可投递这类。处置是改单或放弃,不是重试" },
  // 业务拦截用中灰、可重试用最浅的灰:两组都不是「出事」,但前者要人动手改单,
  // 后者点一下就过。颜色深浅照「要花多少人力」排,不照好看排。
  retryable: { label: "可重试", hex: "#d4d4d8", tone: "dashed-zinc" as Tone,
               why: "页面慢或结构没等到,重置一下基本能过" },
  other: { label: "未归组", hex: "#dc2626", tone: "solid-red" as Tone,
           why: "不在任何一组 —— 有人加了错误码却忘了归组,处置方式无从谈起" },
};
type GroupKey = keyof typeof GROUP;

/** 本地日期,不用 toISOString —— 那个先转 UTC,东八区的「今天」会被算成昨天。 */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function ErrorsPage() {
  const meta = useMeta();
  const [days, setDays] = useState(14);
  const [data, setData] = useState<ErrorStats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    void api.errorStats({ date_from: ymd(from), date_to: ymd(to) }).then((r) => {
      if (r.ok) { setData(r.data); setErr(null); }
      else setErr(r.kind === "transport" ? `连不上服务端:${r.message}` : `${r.code} · ${r.message}`);
    });
  }, [days]);

  // 顺序有讲究:possibly_ordered 是 to_manual 的子集,必须先判,
  // 否则那几个「可能已经真下了单」的码会被归进普通转人工 —— 颜色一混就没人当回事了。
  const groupOf = (code: string): GroupKey =>
    meta.error_code.possibly_ordered.includes(code) ? "possibly_ordered"
    : meta.error_code.to_manual.includes(code) ? "to_manual"
    : meta.error_code.business_blocked.includes(code) ? "business_blocked"
    : meta.error_code.retryable.includes(code) ? "retryable"
    : "other";

  const bars = useMemo(() => (data?.items ?? []).map((i) => ({
    code: i.code,
    label: meta.error_code.labels[i.code] ?? i.code,
    n: i.n,
    group: groupOf(i.code),
    by_env: i.by_env,
  })), [data, meta]);

  const byGroup = useMemo(() => {
    const acc: Record<GroupKey, number> = {
      possibly_ordered: 0, to_manual: 0, business_blocked: 0, retryable: 0, other: 0,
    };
    bars.forEach((b) => { acc[b.group] += b.n; });
    return acc;
  }, [bars]);

  /** 按天的折线:每组一条,不是每个码一条。19 个码画 19 条线是看不出东西的。
   *
   * **没出错的那天要补成 0,不能缺一天**。SQL 的 GROUP BY 只吐有行的天,
   * 照直画会把 08-13 到 08-17 之间的空档连成一条直线 —— 看着像那五天一直有事,
   * 其实那五天一件都没有。折线图上「平了」和「没数据」长得一模一样,
   * 而这两件事的含义正好相反。 */
  const trend = useMemo(() => {
    const rows = new Map<string, Record<string, number | string>>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = ymd(d);
      rows.set(key, { day: key.slice(5), possibly_ordered: 0, to_manual: 0,
                      business_blocked: 0, retryable: 0, other: 0 });
    }
    (data?.trend ?? []).forEach((p) => {
      const row = rows.get(p.day);
      if (!row) return;           // 落在窗口外的行忽略,不悄悄拉宽 x 轴
      const g = groupOf(p.code);
      row[g] = (row[g] as number) + p.n;
    });
    return [...rows.values()];
  }, [data, meta, days]);

  return (
    <>
      <div className="h-12 shrink-0 bg-white border-b border-zinc-100 flex items-center gap-3 px-4">
        <span className="text-[13px] font-medium">错误码分布</span>
        <span className="text-xs text-zinc-500">
          共 <span className="num text-zinc-900">{data?.total ?? "—"}</span> 条带码的任务
        </span>
        <span className="ml-auto" />
        {[7, 14, 30].map((d) => (
          <button key={d} onClick={() => setDays(d)}
                  className={cn("h-7 px-2.5 rounded-md text-xs",
                                days === d ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100")}>
            近 {d} 天
          </button>
        ))}
      </div>

      <div className="flex-1 p-4 min-h-0 overflow-auto flex flex-col gap-4">
        {err && (
          <div className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm- text-red-700">{err}</div>
        )}

        <div className="grid grid-cols-5 gap-3">
          {(Object.keys(GROUP) as GroupKey[]).map((g) => (
            <Card key={g} className="px-4 py-3 flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: GROUP[g].hex }} />
                <span className="text-xs text-zinc-500">{GROUP[g].label}</span>
                <span className="ml-auto font-mono text-2xl font-semibold tabular-nums">{byGroup[g]}</span>
              </div>
              <div className="text-xs+ text-zinc-400 leading-relaxed">{GROUP[g].why}</div>
              {/* 事实:目前没有任何 workflow 把 exception 退回 ready。
                  写成「系统自己会再试」就是在界面上撒谎,运营会把一桶
                  其实没人管的单晾在那儿。服务端把这一位吐给前端就是为了这句话。 */}
              {g === "retryable" && !meta.error_code.auto_retry_implemented && (
                <div className="text-xs+ text-amber-700 leading-relaxed">
                  目前没有自动重试 —— 这一桶要人进去点「重置回待拍单」
                </div>
              )}
            </Card>
          ))}
        </div>

        <Card className="overflow-hidden">
          <CardHead right={<span className="text-xs text-zinc-400">按码,高的在前</span>}>
            哪个码最多
          </CardHead>
          <div className="p-3" style={{ height: Math.max(200, bars.length * 30 + 40) }}>
            {bars.length === 0
              ? <div className="h-full flex items-center justify-center text-xs text-zinc-400">
                  这段时间没有带错误码的任务
                </div>
              : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={bars} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                    <CartesianGrid horizontal={false} stroke="#f4f4f5" />
                    <XAxis type="number" tick={{ fontSize: 11, fill: "#a1a1aa" }} allowDecimals={false} />
                    <YAxis type="category" dataKey="label" width={148}
                           tick={{ fontSize: 11, fill: "#52525b" }} />
                    <Tooltip
                      cursor={{ fill: "#fafafa" }}
                      contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid #e4e4e7" }}
                      formatter={(v: number, _n, p) => [
                        `${v} 条 · ${Object.entries((p.payload as typeof bars[number]).by_env)
                          .map(([e, c]) => `${e} ${c}`).join(" / ")}`,
                        (p.payload as typeof bars[number]).code,
                      ]}
                    />
                    <Bar dataKey="n" radius={[0, 3, 3, 0]} barSize={16}>
                      {bars.map((b) => <Cell key={b.code} fill={GROUP[b.group].hex} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHead right={<span className="text-xs text-zinc-400">
            一条线一组 —— 19 个码画 19 条线是看不出东西的
          </span>}>是一直这样,还是昨天开始的</CardHead>
          <div className="p-3 h-[300px]">
            {trend.length === 0
              ? <div className="h-full flex items-center justify-center text-xs text-zinc-400">
                  这段时间没有带错误码的任务
                </div>
              : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend} margin={{ left: 0, right: 16, top: 8, bottom: 8 }}>
                    <CartesianGrid stroke="#f4f4f5" />
                    <XAxis dataKey="day" tick={{ fontSize: 11, fill: "#a1a1aa" }} />
                    <YAxis tick={{ fontSize: 11, fill: "#a1a1aa" }} allowDecimals={false} width={32} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid #e4e4e7" }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {/* 这段时间一条都没有的组不画 —— 一整条压在 0 上的线是纯噪音,
                        还会让人以为「有这么一组东西一直在发生」。
                        上面那排卡片已经把 0 明明白白写出来了,不靠这条线说。 */}
                    {(Object.keys(GROUP) as GroupKey[]).filter((g) => byGroup[g] > 0).map((g) => (
                      // linear 不是 monotone:每天一个整数计数,monotone 会在两天之间
                      // 画出从没存在过的峰值,看着像一次剧烈波动,其实只是插值。
                      <Line key={g} type="linear" dataKey={g} name={GROUP[g].label}
                            stroke={GROUP[g].hex} strokeWidth={2} dot={{ r: 2 }} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHead>逐码明细</CardHead>
          <table className="w-full">
            <thead>
              <tr className="bg-zinc-50 border-b border-zinc-200">
                {["错误码", "含义", "归组", "条数", "分买家号"].map((h, i) => (
                  <th key={h} className={cn(
                    "h-th px-3 text-2xs font-medium uppercase tracking-wider text-zinc-500",
                    i === 3 ? "text-right" : "text-left",
                  )}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bars.map((b) => (
                <tr key={b.code} className="border-b border-zinc-100 last:border-0">
                  <td className="px-3 h-row id text-xs+">{b.code}</td>
                  <td className="px-3 text-xs text-zinc-700">{b.label}</td>
                  <td className="px-3"><Tag tone={GROUP[b.group].tone}>{GROUP[b.group].label}</Tag></td>
                  <td className="px-3 num">{b.n}</td>
                  <td className="px-3 text-xs text-zinc-500">
                    {Object.entries(b.by_env).map(([e, c]) => `${e} ${c}`).join(" · ")}
                  </td>
                </tr>
              ))}
              {bars.length === 0 && (
                <tr><td colSpan={5} className="h-16 text-center text-xs text-zinc-400">没有数据</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
