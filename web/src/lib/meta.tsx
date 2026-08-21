/** 词汇表的入口。整个前端只在这里向服务端要一次封闭集。
 *
 * 为什么不在各页各自 fetch:那样会有 N 份可能不一致的快照,而且第一屏会闪。
 * 这里在挂载前挡一道 —— 拿不到词汇表的界面不值得渲染:
 * 状态会变成一串裸英文枚举,运营看着 `exception` 是猜不出该干什么的。
 */

import { createContext, useContext, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Meta } from "@/types";
import type { Tone } from "@/components/ui/tag";

const Ctx = createContext<Meta | null>(null);

/** 词汇表必须有的键。
 *
 * 为什么要在这里挡一道:前端和服务端是**分开发布**的 ——
 * `npm run build` 出来的 dist 会一直服务到下次构建,而服务端可能已经升过级/降过级。
 * 少一个键的后果不是「那一处显示不出来」,而是渲染时对 undefined 调 .includes,
 * 整个控制台白屏,连一句能拿去排查的话都没有。实际发生过一次(2026-08-21)。
 *
 * 白屏是最坏的失败方式:它跟「服务挂了」「网断了」长得一模一样,
 * 运营会去重启一台其实好好的机器。所以宁可在这里明说「服务端少给了哪个键」。 */
const REQUIRED: Record<string, string[]> = {
  task_status: ["labels", "tone"],
  shipment_status: ["labels", "tone"],
  event_kind: ["labels", "tone"],
  error_code: ["labels", "retryable", "to_manual", "business_blocked", "possibly_ordered"],
};

function missingKeys(m: unknown): string[] {
  const out: string[] = [];
  const root = m as Record<string, Record<string, unknown> | undefined> | null;
  if (!root || typeof root !== "object") return ["(整个 meta 不是对象)"];
  for (const [group, fields] of Object.entries(REQUIRED)) {
    const g = root[group];
    if (!g || typeof g !== "object") { out.push(group); continue; }
    for (const f of fields) if (g[f] === undefined) out.push(`${group}.${f}`);
  }
  return out;
}

export function useMeta(): Meta {
  const m = useContext(Ctx);
  // 有 MetaGate 挡着,这里不该发生;真发生了就是有人把 Provider 摘了。
  if (!m) throw new Error("useMeta 必须在 MetaGate 内使用");
  return m;
}

/** 状态 / 物流状态 → 标签 + 色调。查不到的键**原样显示**,不吞。
 *  服务端加了新状态而前端还没发版时,界面上出现一个陌生英文词是对的 ——
 *  比静默映射成「未知」要好,后者会让人以为库里真有个叫「未知」的状态。 */
export function useLabel(kind: "task_status" | "shipment_status" | "event_kind") {
  const meta = useMeta();
  return (key: string | null | undefined): { label: string; tone: Tone } => {
    if (!key) return { label: "—", tone: "dashed-zinc" };
    const g = meta[kind];
    return {
      label: g.labels[key] ?? key,
      tone: (g.tone[key] as Tone) ?? "dashed-zinc",
    };
  };
}

export function MetaGate({ children }: { children: React.ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState<{ text: string; offline: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    api.meta().then((r) => {
      if (!alive) return;
      if (r.ok) {
        const missing = missingKeys(r.data);
        if (missing.length) {
          setErr({ offline: false, text:
            `服务端的词汇表少了这些键:${missing.join("、")}。`
            + "多半是前端和服务端版本对不上 —— 重新 npm run build,或把服务端升到同一版。" });
          return;
        }
        setMeta(r.data);
      }
      // 「没说上话」和「服务说不行」在这里要分开讲:前者去看进程,后者去看代码。
      else setErr(r.kind === "transport"
        ? { offline: true, text: `连不上服务端:${r.message}` }
        : { offline: false, text: `${r.code} · ${r.message}` });
    });
    return () => { alive = false; };
  }, []);

  if (err) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="max-w-md flex flex-col gap-2 text-center">
          <div className="text-[13px] font-medium text-zinc-900">控制台起不来</div>
          <div className="text-xs text-zinc-500 leading-relaxed">{err.text}</div>
          {/* 这句只在**真的连不上**时说。服务端明明在跑却让人去重启它,
              等于把人支到错误的方向上 —— 那比不给提示更费时间。 */}
          {err.offline && (
            <div className="text-xs text-zinc-400 leading-relaxed">
              服务端默认只监听 <span className="id">127.0.0.1:8781</span>,
              确认它在跑:<span className="id">uvicorn server.app:app --port 8781</span>
            </div>
          )}
        </div>
      </div>
    );
  }
  if (!meta) {
    return <div className="h-full flex items-center justify-center text-xs text-zinc-400">加载词汇表…</div>;
  }
  return <Ctx.Provider value={meta}>{children}</Ctx.Provider>;
}
