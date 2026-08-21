/** 点一下就进剪贴板。ASIN、上游单号、AMZ 单号、收货信息、运单号都用它。
 *
 * 三件事是刻意的:
 *
 * 1. **失败要出声**。`navigator.clipboard` 只在安全上下文可用 —— localhost 与
 *    127.0.0.1 算安全,但哪天有人把 dist 挂到局域网 IP 上就不算了。
 *    静默失败在这里特别毒:运营以为地址已经复制,粘到亚马逊的却是上一次的剪贴板内容,
 *    包裹直接寄错人。所以失败要变红说「复制失败」,不吞。
 * 2. **不冒泡**。行本身是可点的(点行开详情),复制不该顺手把弹窗也开了。
 * 3. 反馈落在字段自己身上,不弹全局 toast —— 一行里有四个可复制字段,
 *    全局提示说不清刚才复制的是哪一个。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { cn } from "@/lib/utils";

type State = "idle" | "done" | "fail";

async function toClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面那条老路,别在这里就放弃。
  }
  // 非安全上下文的退路。execCommand 已废弃,但在 http://<局域网 IP> 下它是唯一能用的。
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function useCopy() {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(async (text: string) => {
    const ok = text ? await toClipboard(text) : false;
    setState(ok ? "done" : "fail");
    window.clearTimeout(timer.current);
    // 失败停久一点 —— 那条消息是要被读到的,不是装饰。
    timer.current = window.setTimeout(() => setState("idle"), ok ? 1200 : 2600);
    return ok;
  }, []);

  return { state, copy };
}

export function CopyText({
  value, children, className, title, icon = true,
}: {
  /** 真正进剪贴板的内容。留空表示这个字段暂时没有值,组件退化成纯文本、不可点。 */
  value: string | null | undefined;
  children?: React.ReactNode;
  className?: string;
  title?: string;
  icon?: boolean;
}) {
  const { state, copy } = useCopy();
  const text = value ?? "";

  if (!text) return <span className={cn("text-zinc-400", className)}>—</span>;

  return (
    <span
      role="button"
      tabIndex={0}
      title={title ?? `点击复制 ${text}`}
      className={cn(
        "copyable inline-flex items-center gap-1 max-w-full align-bottom",
        state === "fail" && "text-red-600 border-red-300",
        className,
      )}
      onClick={(e) => { e.stopPropagation(); void copy(text); }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        void copy(text);
      }}
    >
      <span className="truncate">{children ?? text}</span>
      {icon && (
        state === "done" ? <Check className="w-3 h-3 shrink-0 text-emerald-600" />
        : state === "fail" ? <X className="w-3 h-3 shrink-0 text-red-600" />
        : <Copy className="w-3 h-3 shrink-0 text-zinc-300" />
      )}
      {state === "fail" && <span className="text-[10px] shrink-0">复制失败</span>}
    </span>
  );
}

/** 「复制整段」。收货地址得整段拿走 —— 一格一格复制四次是在给寄错件创造机会。 */
export function CopyBlock({ value, label = "复制整段", className }: {
  value: string; label?: string; className?: string;
}) {
  const { state, copy } = useCopy();
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-medium text-zinc-500 hover:text-zinc-900",
        state === "fail" && "text-red-600",
        className,
      )}
      onClick={(e) => { e.stopPropagation(); void copy(value); }}
    >
      {state === "done" ? <Check className="w-3 h-3 text-emerald-600" />
       : state === "fail" ? <X className="w-3 h-3" />
       : <Copy className="w-3 h-3 text-zinc-400" />}
      {state === "done" ? "已复制" : state === "fail" ? "复制失败" : label}
    </button>
  );
}
