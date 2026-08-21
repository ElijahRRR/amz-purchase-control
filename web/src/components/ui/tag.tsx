import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** 设计系统里的 `.tag`。
 *
 * 两条语义规则写进了 variant 名字里,免得用的人凭手感挑颜色:
 *  - **中间态用虚线,终态用实心** —— 一眼分出「还在动」与「已经定了」
 *  - **忙/停用石板灰,不用红** —— 红色一旦用来表示"正常但没在跑",
 *    真出事时就没有颜色可用了
 *
 * 色值逐个对得上 Tailwind 调色板(设计稿用的就是 zinc/emerald/amber/sky/violet),
 * 所以这里不写十六进制。
 */
const tag = cva(
  "inline-flex items-center gap-1 h-5 px-1.5 rounded text-[11px] font-medium border whitespace-nowrap",
  {
    variants: {
      tone: {
        "dashed-zinc": "bg-white text-zinc-600 border-zinc-300 border-dashed",
        "dashed-sky": "bg-white text-sky-700 border-sky-200 border-dashed",
        "dashed-amber": "bg-white text-amber-700 border-amber-200 border-dashed",
        "solid-emerald": "bg-emerald-50 text-emerald-700 border-emerald-200",
        "solid-red": "bg-red-50 text-red-700 border-red-200",
        "solid-violet": "bg-violet-50 text-violet-700 border-violet-200",
        "solid-zinc": "bg-zinc-100 text-zinc-700 border-zinc-200",
      },
      mono: { true: "font-mono text-[10.5px]", false: "" },
    },
    defaultVariants: { tone: "dashed-zinc", mono: false },
  },
);

export type Tone = NonNullable<VariantProps<typeof tag>["tone"]>;

export function Tag({
  tone, mono, className, children,
}: VariantProps<typeof tag> & { className?: string; children: React.ReactNode }) {
  return <span className={cn(tag({ tone, mono }), className)}>{children}</span>;
}

/** 事件时间线上那个点。
 *  `amber-hollow` = 结局不确定(断言没过、领走没回传),与已经落定的实心点区分开
 *  —— 这两种的处置方式相反。 */
export function Dot({ tone }: { tone: string }) {
  if (tone === "amber-hollow") {
    return <span className="inline-block w-[9px] h-[9px] rounded-full bg-white border-2 border-amber-500 shrink-0" />;
  }
  const map: Record<string, string> = {
    sky: "bg-sky-500", zinc: "bg-zinc-300", violet: "bg-violet-500",
    red: "bg-red-500", emerald: "bg-emerald-500",
  };
  return <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", map[tone] ?? "bg-zinc-300")} />;
}
