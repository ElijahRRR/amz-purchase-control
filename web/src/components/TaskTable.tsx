/** 任务列表。两种行密度,虚拟滚动。
 *
 * **详细**照厂商面板那一行做(所有者定稿:「这是订单详情,需要把它作为模板」)——
 * 8 组字段竖着堆在各自格子里,一行 ~124px。运营在这一档不用点开就能核对地址、
 * 费用、物流,这正是他们现在的工作方式。
 * **紧凑**一行一条 40px,用来扫桶:今天异常几单、卡在哪。
 *
 * 表格用 `display:grid` 而不是默认的 table 布局 —— 虚拟滚动要给行绝对定位,
 * 原生 table 的行是排不动的。这是 TanStack Virtual 官方那条路子。
 */

import { useEffect, useRef } from "react";
import {
  flexRender, getCoreRowModel, useReactTable, type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Box, Home, Mail, MapPin, Phone } from "lucide-react";
import { CopyText } from "@/components/CopyText";
import { Tag } from "@/components/ui/tag";
import { useLabel, useMeta } from "@/lib/meta";
import { autoRetryApplies, capVerdict, cn, money, shortTime } from "@/lib/utils";
import type { TaskRow } from "@/types";

export type Density = "detail" | "compact";

/** 行高。虚拟滚动要先知道估计值,估得准滚动条才不会跳。 */
const ROW_H: Record<Density, number> = { detail: 124, compact: 40 };

/** 表头高度(h-th 36 + 下边框 1)。表头在流内 sticky,占着滚动容器内容区的顶部,
 *  虚拟器得把这段算进 paddingStart,否则它算的位置整体偏 37px。 */
const HEAD_H = 37;

function Thumb({ url, size = 32 }: { url?: string | null; size?: number }) {
  return (
    <span
      className="shrink-0 border border-zinc-200 rounded bg-zinc-50 inline-flex
                 items-center justify-center overflow-hidden"
      style={{ width: size, height: size }}
    >
      {url
        ? <img src={url} alt="" className="w-full h-full object-contain" />
        : <Box className="text-zinc-300" strokeWidth={1.4} size={size * 0.44} />}
    </span>
  );
}

/** 详细档里那种「小标签: 值」的一行。 */
function DL({ k, children, className }: { k: string; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("flex items-baseline gap-1.5 text-xs leading-relaxed text-zinc-700", className)}>
      <span className="w-[46px] shrink-0 text-zinc-400 whitespace-nowrap">{k}</span>
      {children}
    </span>
  );
}

/** 「这一单有没有超限价」的着色。超了要看得见 —— 护栏本来就该拦住,漏过去的
 *  那几单是最需要人去看的。核不了的时候不着色:那不是「没超」,是「还没有这个数」。
 *
 * **判据只有一处(lib/utils.capVerdict),这里不许再写一遍。**
 * 限价是**整单**的,不是单价的:3 件 × 24 元、限价 60,单价 24 看着安全,
 * 整单 72 其实已经超了。而整单要比的是**货款**(goods_total),不是实付 ——
 * price_guard.adjudicate 比的就是货款。这一格栽过一次:改护栏的时候它没跟着改,
 * 于是礼品卡全额抵扣、货款 2241.86、限价 1000 的一单在列表页渲染成黑色的 0.00,
 * 跟一张真的只花了 0 元的单**长得一模一样**,而详情弹窗那边说它超了一倍多 ——
 * 同一个事实两个页面两种说法。界面上的红色必须跟真正那道闸算的是同一件事,
 * 否则就是「看起来有护栏」。 */
/** 「这一单越过了下单点」。**与错误码是两件事** —— 越过下单点之后抛的
 *  DriverError 用的是它自己的码(PLUGIN_INTERNAL / CART_MISMATCH,都在
 *  「可重试」那一组),光看码会把一张已经花过钱的单读成「重一下就过」。
 *  服务端四道回队列的闸都判这一位,列表这一层原先看不见它:
 *  扫「待人工」那一桶的人没有任何线索知道哪几条必须先去买家号订单页确认。
 *  紫色与「可能已下单」那组码同色 —— 它们说的是同一件事。 */
function CrossedTag({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <span title="下单按钮点过了 —— 重置前必须有人去买家号订单页确认">
      <Tag tone="solid-violet">已越过下单点</Tag>
    </span>
  );
}

function totalTone(r: TaskRow): string {
  const v = capVerdict(r);
  if (v.state === "unknown") return "text-zinc-400";
  return v.state === "over" ? "text-red-600 font-medium" : "text-zinc-800";
}

/** 勾选列。放在最前面,两种密度都有 —— 批量动作不该只在某一档才够得着。 */
function selectColumn(
  selectedIds: Set<number>,
  onToggle: (id: number, on: boolean) => void,
  rows: TaskRow[],
  onToggleAll: (on: boolean) => void,
): ColumnDef<TaskRow> {
  // 只勾**能重置的**那些。已拍单/待拍单的单子重置一定被服务端拒,
  // 让它们能被勾上,只会换来一份「失败 18 条」的清单。
  const resettable = rows.filter((r) => r.status === "exception" || r.status === "manual");
  const allOn = resettable.length > 0 && resettable.every((r) => selectedIds.has(r.id));
  return {
    id: "select",
    size: 34,
    header: () => (
      <input type="checkbox" checked={allOn} disabled={resettable.length === 0}
             title={resettable.length
               ? `全选这一页里 ${resettable.length} 条可重置的`
               : "这一页没有可重置的单"}
             onChange={(e) => onToggleAll(e.target.checked)}
             className="w-3.5 h-3.5 accent-zinc-900 cursor-pointer disabled:cursor-not-allowed" />
    ),
    cell: ({ row }) => {
      const r = row.original;
      const can = r.status === "exception" || r.status === "manual";
      return (
        <input type="checkbox" checked={selectedIds.has(r.id)} disabled={!can}
               title={can ? "" : `${r.status} 的单不能重置`}
               onClick={(e) => e.stopPropagation()}
               onChange={(e) => onToggle(r.id, e.target.checked)}
               className="w-3.5 h-3.5 accent-zinc-900 cursor-pointer disabled:opacity-30" />
      );
    },
  };
}

/** 「这一单正卡在发卡行验证页上等人」的徽标。
 *
 *  为什么不做成一个自己会走的倒计时:这一页**不自动刷新**,那样的数字看着是活的、
 *  其实停在上一次请求的那一刻 —— 一个不动的计数器比没有计数器更坏。
 *  给出「从几点开始等的」,让人自己看表,并且写清超时之后会怎样。 */
function AwaitingVerify({ since }: { since: string | null }) {
  return (
    <span title={
      (since ? `插件报告:从 ${shortTime(since)} 起` : "插件报告:正") +
      "在等操作员完成发卡行验证。超时后这一单会转为待人工,而订单可能已经提交。"
    }>
      <Tag tone="solid-amber">等人工验证{since ? ` · ${shortTime(since)}` : ""}</Tag>
    </span>
  );
}

function useColumns(density: Density): ColumnDef<TaskRow>[] {
  const meta = useMeta();
  const statusLabel = useLabel("task_status");
  const shipLabel = useLabel("shipment_status");

  const codeTag = (code: string | null) => {
    if (!code) return null;
    // 四组的处置方式完全不同,颜色要分开:
    //   可能已下单 = 先去亚马逊看一眼(紫)
    //   转人工     = 排队等人裁决(琥珀)
    //   业务拦截   = 改单或放弃,重试没用(石板灰实心)
    //   可重试     = 再来一次基本能过(石板灰虚线)。谁去重要看配置:
    //                开了自动重试是系统重,没开就得人点 —— 那句话在详情里说,
    //                颜色不承担这个区分(色调是「这组码是什么」,不是「谁来管」)
    // 落到 solid-red 的只剩「不在任何一组的码」—— 那说明有人加了码没归组,
    // 红色在这里是提醒去补分类,不是表示这单更严重。
    const tone = meta.error_code.possibly_ordered.includes(code) ? "solid-violet"
      : meta.error_code.to_manual.includes(code) ? "dashed-amber"
      : meta.error_code.business_blocked.includes(code) ? "solid-zinc"
      : meta.error_code.retryable.includes(code) ? "dashed-zinc"
      : "solid-red";
    return <Tag tone={tone}>{meta.error_code.labels[code] ?? code}</Tag>;
  };

  /** 「已试 k/N」。**只在这一单真在自动重试射程里时才写上限** ——
   *  判据复用详情那一套(lib/utils.autoRetryApplies),两边各写一遍的话,
   *  迟早一边说「系统会来重」、另一边说「要人去点」。
   *
   *  为什么列表也要有:开着自动重试时,「已试 0/2、机器待会儿会来重」与
   *  「已试 2/2、机器再也不会碰、要人现在去点」在列表上原先是同一行
   *  「拍单异常 · 结算页跳转超时」,而列表正是运营扫桶的地方 ——
   *  要判断哪几条已经用满、正在没人管地躺着,只能一条条点开。 */
  const retryBadge = (r: TaskRow) => {
    if (!meta.auto_retry.enabled) return null;
    if (r.status !== "exception" || !r.error_code) return null;
    if (!meta.error_code.retryable.includes(r.error_code)) return null;
    const inRange = autoRetryApplies(r, meta.auto_retry, meta.error_code.retryable);
    const used = r.retry_count >= meta.auto_retry.max;
    return (
      <span className={cn("text-2xs whitespace-nowrap",
                          inRange && !used ? "text-zinc-400" : "text-amber-700")}
            title={inRange
              ? (used ? "自动重试已经用满,系统不会再动它 —— 要人来点"
                      : "还在自动重试的射程里,不点它也会被放回队列")
              : "系统不会自动重它(越过下单点 / 失败太久)—— 要人来点"}>
        已试 {r.retry_count}{inRange ? `/${meta.auto_retry.max}` : ""}
      </span>
    );
  };

  if (density === "compact") {
    return [
      {
        id: "product", header: "商品", size: 236,
        cell: ({ row }) => {
          const p = row.original.products?.[0];
          const n = row.original.products?.length ?? 0;
          return (
            <div className="flex items-center gap-2.5 min-w-0">
              <Thumb url={p?.image_url} />
              <span className="flex flex-col gap-px min-w-0">
                <CopyText value={p?.asin} className="id text-zinc-900" />
                <span className="text-xs+ text-zinc-400">
                  {p ? `×${p.quantity}` : "无商品"}{n > 1 && ` · 另 ${n - 1} 项`}
                </span>
              </span>
            </div>
          );
        },
      },
      {
        id: "upstream", header: "上游单号", size: 146,
        cell: ({ row }) => <CopyText value={row.original.upstream_order_no} className="id" />,
      },
      {
        // 这一格是紧凑档里唯一**可以被截断而不丢信息**的(收件人 + 城市州),
        // 所以窄屏时让它去让位 —— 见下面 template 那一段。
        id: "ship", header: "收货", size: 224, meta: { flex: true },
        cell: ({ row }) => {
          const r = row.original;
          return (
            // truncate 要 block/flex 才生效:overflow:hidden 与 text-overflow
            // 对非替换的**行内**框不起作用,长收件人名会压过右边的限价/实付两列。
            <span className="block min-w-0 truncate text-xs text-zinc-700">
              {r.ship_name} · {r.ship_city}, {r.ship_state}
            </span>
          );
        },
      },
      { id: "env", header: "买家号", size: 88,
        cell: ({ row }) => <span className="text-xs">{row.original.env_code}</span> },
      { id: "cap", header: "限价", size: 74, meta: { align: "right" },
        cell: ({ row }) => <span className="num">{money(row.original.price_cap)}</span> },
      // **红色必须落在它标注的那个数上。** 原先这一格永远显示 actual_total,
      // 而闸比的是货款:礼品卡抵扣过的单会渲染成「限价 1200.00 / 实付 1141.86(红)」
      // —— 屏幕上两个数字说「没超」,颜色说「超了」,真正比过的那个数(2241.86)
      // 在这一档根本不出现。详细档早就多渲染了一行「货款」并把红色标在它上面,
      // 紧凑档没跟上,而扫桶用的正是紧凑档。
      { id: "paid", header: "实付/货款", size: 88, meta: { align: "right" },
        cell: ({ row }) => {
          const r = row.original;
          const v = capVerdict(r);
          // 两个数不同 = 有礼品卡垫过。显示被比过的那个(货款),并加一个
          // 极小的「货」角标说明这不是卡扣的钱。
          const isGoods = v.basis !== null && v.basis !== r.actual_total;
          return (
            <span className={cn("num", totalTone(r))} title={v.text}>
              {money(v.basis ?? r.actual_total)}
              {isGoods && <span className="ml-0.5 text-2xs text-zinc-400 align-super">货</span>}
            </span>
          );
        } },
      { id: "status", header: "状态", size: 104,
        cell: ({ row }) => {
          const r = row.original;
          const s = statusLabel(r.status);
          // 「拍单中」和「拍单中,但正卡在验证页上等人」必须是两个样子:
          // 后者要有人去催操作员,前者什么都不用做。
          return (
            <span className="flex flex-col items-start gap-0.5">
              <Tag tone={s.tone}>{s.label}</Tag>
              {r.awaiting_manual_verification && <AwaitingVerify since={r.awaiting_since} />}
              <CrossedTag on={r.may_have_ordered} />
            </span>
          );
        } },
      {
        id: "note", header: "错误码 / AMZ 单号", size: 240,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span className="flex items-center gap-1.5 min-w-0">
              {codeTag(r.error_code)}
              {retryBadge(r)}
              {r.amazon_order_no
                ? <CopyText value={r.amazon_order_no} className="id text-2xs text-zinc-500" icon={false} />
                : !r.error_code && <span className="text-xs text-zinc-300">—</span>}
            </span>
          );
        },
      },
      { id: "time", header: "时间", size: 120,
        cell: ({ row }) => (
          <span className="id text-xs+ text-zinc-500">
            {shortTime(row.original.purchased_at ?? row.original.created_at)}
          </span>
        ) },
    ];
  }

  // ── 详细:照厂商那一行的 8 组分组 ────────────────────────────────────
  //
  // **顺序上只改了一处:「其他信息」从最后一格挪到了最前面。**
  // 那一格是唯一承载状态标、错误码标、「等人工验证」徽标和「已越过下单点」的格子,
  // 而它原先排在最右:实测 1440 / 1512 / 1680 这些常见笔记本宽度下,
  // 前面 8 组固定列已经把内容区吃满,这一列被压到 24px、默认滚动位置下整列在屏幕外
  // —— docs/01 §8.3 把「运营台列表挂『等人工验证』徽标」列为那条功能的四件事之一,
  // 而在默认密度、默认滚动位置、主流分辨率上它是**看不见的**。
  // 分组没变,还是厂商那 8 组;窄屏时被挤到屏幕外的换成了「买家号信息」。
  return [
    {
      id: "g-other", header: "其他信息", size: 210,
      cell: ({ row }) => {
        const r = row.original;
        const s = statusLabel(r.status);
        return (
          <div className="flex flex-col gap-1 min-w-0">
            <span className="flex items-center gap-1.5 min-w-0">
              <Tag tone={s.tone}>{s.label}</Tag>
              {r.awaiting_manual_verification && <AwaitingVerify since={r.awaiting_since} />}
            </span>
            <span className="flex items-center gap-1.5 min-w-0 flex-wrap">
              {codeTag(r.error_code)}
              {retryBadge(r)}
            </span>
            <CrossedTag on={r.may_have_ordered} />
            <DL k="创建"><span className="id text-xs+ text-zinc-500">{shortTime(r.created_at)}</span></DL>
            <DL k="采购"><span className="id text-xs+ text-zinc-500">{shortTime(r.purchased_at)}</span></DL>
          </div>
        );
      },
    },
    {
      id: "g-upstream", header: "上游订单", size: 172,
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex flex-col gap-0.5">
            <CopyText value={r.upstream_order_no} className="id text-[13px] text-zinc-900" />
            <span className="id text-2xs text-zinc-400 truncate" title={r.line_key}>
              {r.line_key.slice(0, 12)}…
            </span>
            <span className="text-xs+ text-zinc-500 mt-0.5">
              {r.marketplace} · amazon.com
            </span>
          </div>
        );
      },
    },
    {
      // 详细档里最能截断的一格(地址那一行本来就 truncate)—— 窄屏让它让位,
      // 而不是让最后一列被压没。
      id: "g-ship", header: "买家信息", size: 236, meta: { flex: true },
      cell: ({ row }) => {
        const r = row.original;
        const ic = "w-3 h-3 shrink-0 text-zinc-300 relative top-px";
        return (
          <div className="flex flex-col gap-px min-w-0">
            <CopyText value={r.ship_name} className="text-sm- font-medium text-zinc-900" icon={false} />
            <span className="flex items-baseline gap-1 text-xs text-zinc-700">
              <MapPin className={ic} strokeWidth={1.8} />{r.marketplace}, {r.ship_city}, {r.ship_state}
            </span>
            <span className="flex items-baseline gap-1 text-xs text-zinc-700 min-w-0">
              <Home className={ic} strokeWidth={1.8} />
              <CopyText value={r.ship_line1} className="truncate" icon={false} />
            </span>
            <span className="flex items-baseline gap-1 text-xs text-zinc-700">
              <Mail className={ic} strokeWidth={1.8} />
              <CopyText value={r.ship_postcode} className="id text-xs+" icon={false} />
            </span>
            <span className="flex items-baseline gap-1 text-xs text-zinc-700">
              <Phone className={ic} strokeWidth={1.8} />
              <CopyText value={r.ship_phone} className="id text-xs+" icon={false} />
            </span>
          </div>
        );
      },
    },
    {
      id: "g-product", header: "产品信息", size: 220,
      cell: ({ row }) => {
        const r = row.original;
        const p = r.products?.[0];
        const more = (r.products?.length ?? 0) - 1;
        return (
          <div className="flex gap-2.5 items-start min-w-0">
            <Thumb url={p?.image_url} size={48} />
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <CopyText value={p?.asin} className="id text-sm- text-zinc-900" />
              {/* 「整单限价」不是「单价限价」—— 名字里带上「整单」两个字,
                  是因为它就摆在数量旁边,不写清楚一定会被当成单价读。 */}
              <DL k="整单限价">
                <span className="id text-xs+ text-zinc-900">{money(r.price_cap)}</span>
                <span className="text-zinc-400">{p ? `×${p.quantity}` : ""}</span>
              </DL>
              <DL k="实付单价">
                <span className="id text-xs+ text-zinc-800">{money(p?.actual_unit_price)}</span>
              </DL>
              {more > 0 && <span className="text-2xs text-zinc-400">另 {more} 项商品</span>}
            </div>
          </div>
        );
      },
    },
    {
      id: "g-order", header: "订单信息", size: 228,
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex flex-col gap-0.5">
            {r.amazon_order_no
              ? <CopyText value={r.amazon_order_no} className="id text-xs text-zinc-900" />
              : <span className="id text-xs text-zinc-400">未写入</span>}
            <DL k="下单">
              <span className="id text-xs+ text-zinc-500">{shortTime(r.purchased_at)}</span>
            </DL>
          </div>
        );
      },
    },
    {
      id: "g-fee", header: "费用信息", size: 168,
      cell: ({ row }) => {
        const r = row.original;
        const line = (k: string, v: string | null) => (
          <span className="flex items-baseline text-xs text-zinc-700">
            <span className="text-zinc-400">{k}</span>
            <span className="num ml-auto text-xs+">{money(v)}</span>
          </span>
        );
        return (
          <div className="flex flex-col gap-0.5">
            {line("运费", r.actual_shipping)}
            {line("税费", r.actual_tax)}
            {/* 礼品卡垫过的单,「总计 0.00」这一格看起来就像这单没花钱。
                抵扣额单列一行,货款也单列一行 —— 红色标在货款上,
                因为护栏比的是它。没有礼品卡的单两个数一样,不多这两行。 */}
            {r.gift_card_amount !== null && line("礼品卡", r.gift_card_amount)}
            <span className="flex items-baseline border-t border-zinc-100 pt-1 mt-0.5 text-xs">
              <span className="text-zinc-900">总计</span>
              <span className={cn("num ml-auto text-xs",
                                  r.goods_total !== null && r.goods_total !== r.actual_total
                                    ? "text-zinc-800" : totalTone(r))}>
                {money(r.actual_total)}
              </span>
            </span>
            {r.goods_total !== null && r.goods_total !== r.actual_total && (
              <span className="flex items-baseline text-xs" title={capVerdict(r).text}>
                <span className="text-zinc-900">货款</span>
                <span className={cn("num ml-auto text-xs", totalTone(r))}>
                  {money(r.goods_total)}
                </span>
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: "g-logistics", header: "物流信息", size: 228,
      cell: ({ row }) => {
        const r = row.original;
        const s = r.shipment_status ? shipLabel(r.shipment_status) : null;
        return (
          <div className="flex flex-col gap-0.5 min-w-0">
            <DL k="物流商"><span className="text-xs">{r.carrier ?? "—"}</span></DL>
            <DL k="运单号">
              <CopyText value={r.tracking_no} className="id text-2xs" icon={false} />
            </DL>
            <DL k="状态">{s ? <Tag tone={s.tone}>{s.label}</Tag>
                             : <span className="text-xs text-zinc-300">未同步</span>}</DL>
            <DL k="预计"><span className="text-xs">{r.delivery_date ?? "—"}</span></DL>
          </div>
        );
      },
    },
    {
      id: "g-env", header: "买家号信息", size: 196,
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm- text-zinc-900">{r.env_code}</span>
            <CopyText value={r.amazon_customer_id} className="id text-2xs text-zinc-500" icon={false} />
            <DL k="信用卡">
              <span className="id text-xs+">{r.payment_last4 ? `•••• ${r.payment_last4}` : "—"}</span>
            </DL>
          </div>
        );
      },
    },
  ];
}

export function TaskTable({
  rows, density, selectedId, onPick, cursor, checked, onCheck, onCheckAll,
}: {
  rows: TaskRow[];
  density: Density;
  selectedId: number | null;
  onPick: (r: TaskRow) => void;
  /** 键盘游标所在的行索引。J/K 移动,⏎ 打开 —— 一屏几十行时手不用离开键盘。 */
  cursor: number;
  checked: Set<number>;
  onCheck: (id: number, on: boolean) => void;
  onCheckAll: (on: boolean) => void;
}) {
  const base = useColumns(density);
  const columns = [selectColumn(checked, onCheck, rows, onCheckAll), ...base];
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  const scrollRef = useRef<HTMLDivElement>(null);

  // 表头是**流内**的 sticky,占掉滚动容器内容区顶部 37px(h-th 36 + 下边框 1)。
  // 虚拟器不知道这件事的话,它算出来的 start 与真实位置差 37px ——
  // scrollToIndex 会把行滚到刚好被表头压住、或者卡在视口下沿之外。
  // 切换密度时也要让它重算行高缓存:itemSizeCache 只在 count/paddingStart/
  // scrollMargin/getItemKey 变化时才清,estimateSize 变了它不管。
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H[density],
    overscan: 8,
    paddingStart: HEAD_H,
    // 密度进 key:换档时 key 全变,缓存作废,行高按新档重算。
    getItemKey: (i) => `${density}:${rows[i]?.id ?? i}`,
  });

  // 游标跟着 J/K 走,列表得跟着游标滚。
  //
  // 不滚的话:按 J 越过可视区,虚拟滚动就不再渲染那一行 —— 游标从界面上消失,
  // 而 ⏎ 照样会打开它。**打开一张看不见的单**比没有快捷键更坏,
  // 何况页脚还写着「按 J / K 移动 · ⏎ 打开」,等于界面在承诺一件它做不到的事。
  //
  // align:"auto" = 已经在视野里就不动,越界了才滚最小的距离 ——
  // 每按一次都把行拽到中间,会让人失去「我在列表的哪个位置」这个感觉。
  useEffect(() => {
    if (rows.length) virt.scrollToIndex(cursor, { align: "auto" });
    // virt 每次渲染都是新对象,不进依赖 —— 进了会变成每帧滚一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, rows.length, density]);

  // **伸缩的是标了 `meta.flex` 的那一列,不是「最后一列」。**
  // 原先无条件把最后一列写成 minmax(0,1fr):内容区不够宽时,它会被压到
  // 只剩左右内边距(实测 24px),而那一列恰恰是承载状态标与徽标的那一格 ——
  // 表格不横向滚动,人也就没有任何提示说「右边还有东西」。
  // 现在让位的是一个截断了也不丢信息的格子(收货 / 买家信息)。
  const cols = table.getVisibleLeafColumns();
  const flexIdx = cols.findIndex(
    (c) => (c.columnDef.meta as { flex?: boolean } | undefined)?.flex);
  const stretch = flexIdx >= 0 ? flexIdx : cols.length - 1;
  const template = cols
    .map((c, i) => (i === stretch ? "minmax(0,1fr)" : `${c.getSize()}px`))
    .join(" ");

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto min-h-0">
      <div className="grid sticky top-0 z-10 bg-zinc-50 border-b border-zinc-200"
           style={{ gridTemplateColumns: template }}>
        {table.getFlatHeaders().map((h) => (
          <div key={h.id}
               className={cn(
                 "h-th flex items-center px-3 text-2xs font-medium uppercase tracking-wider text-zinc-500",
                 (h.column.columnDef.meta as { align?: string } | undefined)?.align === "right"
                   && "justify-end",
               )}>
            {flexRender(h.column.columnDef.header, h.getContext())}
          </div>
        ))}
      </div>

      <div className="relative" style={{ height: virt.getTotalSize() }}>
        {virt.getVirtualItems().map((v) => {
          const row = table.getRowModel().rows[v.index];
          const r = row.original;
          return (
            <div
              key={row.id}
              data-index={v.index}
              ref={virt.measureElement}
              onClick={() => onPick(r)}
              className={cn(
                "absolute left-0 w-full grid border-b border-zinc-100 cursor-pointer",
                "hover:bg-zinc-50",
                selectedId === r.id && "bg-zinc-50 shadow-rowsel",
                cursor === v.index && selectedId !== r.id && "bg-sky-50/40 shadow-rowsel",
              )}
              style={{ gridTemplateColumns: template,
                       transform: `translateY(${v.start - HEAD_H}px)` }}
            >
              {row.getVisibleCells().map((cell) => (
                <div key={cell.id}
                     className={cn(
                       "px-3 min-w-0 flex",
                       density === "detail"
                         ? "py-3 items-start border-r border-zinc-100 last:border-r-0"
                         : "items-center h-row",
                       (cell.column.columnDef.meta as { align?: string } | undefined)?.align === "right"
                         && "justify-end",
                     )}>
                  <div className="min-w-0 w-full">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
