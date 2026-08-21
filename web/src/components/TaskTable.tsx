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

import { useRef } from "react";
import {
  flexRender, getCoreRowModel, useReactTable, type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Box, Home, Mail, MapPin, Phone } from "lucide-react";
import { CopyText } from "@/components/CopyText";
import { Tag } from "@/components/ui/tag";
import { useLabel, useMeta } from "@/lib/meta";
import { cn, money, shortTime } from "@/lib/utils";
import type { TaskRow } from "@/types";

export type Density = "detail" | "compact";

/** 行高。虚拟滚动要先知道估计值,估得准滚动条才不会跳。 */
const ROW_H: Record<Density, number> = { detail: 124, compact: 40 };

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

/** 「实付有没有超限价」。超了要看得见 —— 护栏本来就该拦住,漏过去的那几单
 *  是最需要人去看的。没下单时不着色:那不是「没超」,是「还没有这个数」。
 *
 * **只拿整单实付比**。price_guard.adjudicate 判的是 `actual_total > price_cap`,
 * 限价是**整单**的,不是单价的。拿单价去比会得出跟护栏相反的结论:
 * 3 件 × 24 元、限价 60,单价 24 看着安全,整单 72 其实已经超了。
 * 界面上的红色必须跟真正那道闸算的是同一件事,否则就是「看起来有护栏」。 */
function totalTone(total: string | null, cap: string): string {
  if (total === null) return "text-zinc-400";
  return Number(total) > Number(cap) ? "text-red-600 font-medium" : "text-zinc-800";
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
    //   可重试     = 重置一下基本能过(石板灰虚线)
    // 落到 solid-red 的只剩「不在任何一组的码」—— 那说明有人加了码没归组,
    // 红色在这里是提醒去补分类,不是表示这单更严重。
    const tone = meta.error_code.possibly_ordered.includes(code) ? "solid-violet"
      : meta.error_code.to_manual.includes(code) ? "dashed-amber"
      : meta.error_code.business_blocked.includes(code) ? "solid-zinc"
      : meta.error_code.retryable.includes(code) ? "dashed-zinc"
      : "solid-red";
    return <Tag tone={tone}>{meta.error_code.labels[code] ?? code}</Tag>;
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
        id: "ship", header: "收货", size: 224,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span className="text-xs text-zinc-700 truncate">
              {r.ship_name} · {r.ship_city}, {r.ship_state}
            </span>
          );
        },
      },
      { id: "env", header: "买家号", size: 88,
        cell: ({ row }) => <span className="text-xs">{row.original.env_code}</span> },
      { id: "cap", header: "限价", size: 74, meta: { align: "right" },
        cell: ({ row }) => <span className="num">{money(row.original.price_cap)}</span> },
      { id: "paid", header: "实付", size: 74, meta: { align: "right" },
        cell: ({ row }) => (
          <span className={cn("num", totalTone(row.original.actual_total, row.original.price_cap))}>
            {money(row.original.actual_total)}
          </span>
        ) },
      { id: "status", header: "状态", size: 104,
        cell: ({ row }) => {
          const s = statusLabel(row.original.status);
          return <Tag tone={s.tone}>{s.label}</Tag>;
        } },
      {
        id: "note", header: "错误码 / AMZ 单号", size: 240,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span className="flex items-center gap-1.5 min-w-0">
              {codeTag(r.error_code)}
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

  // ── 详细:照厂商那一行的 8 组分组与顺序 ──────────────────────────────
  return [
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
      id: "g-ship", header: "买家信息", size: 236,
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
            <span className="flex items-baseline border-t border-zinc-100 pt-1 mt-0.5 text-xs">
              <span className="text-zinc-900">总计</span>
              <span className={cn("num ml-auto text-xs", totalTone(r.actual_total, r.price_cap))}>
                {money(r.actual_total)}
              </span>
            </span>
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
    {
      id: "g-other", header: "其他信息", size: 210,
      cell: ({ row }) => {
        const r = row.original;
        const s = statusLabel(r.status);
        return (
          <div className="flex flex-col gap-1 min-w-0">
            <span><Tag tone={s.tone}>{s.label}</Tag></span>
            <span className="flex items-center gap-1.5 min-w-0">{codeTag(r.error_code)}</span>
            <DL k="创建"><span className="id text-xs+ text-zinc-500">{shortTime(r.created_at)}</span></DL>
            <DL k="采购"><span className="id text-xs+ text-zinc-500">{shortTime(r.purchased_at)}</span></DL>
          </div>
        );
      },
    },
  ];
}

export function TaskTable({
  rows, density, selectedId, onPick, cursor,
}: {
  rows: TaskRow[];
  density: Density;
  selectedId: number | null;
  onPick: (r: TaskRow) => void;
  /** 键盘游标所在的行索引。J/K 移动,⏎ 打开 —— 一屏几十行时手不用离开键盘。 */
  cursor: number;
}) {
  const columns = useColumns(density);
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  const scrollRef = useRef<HTMLDivElement>(null);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H[density],
    overscan: 8,
  });

  const template = table.getVisibleLeafColumns()
    .map((c, i, all) => (i === all.length - 1 ? "minmax(0,1fr)" : `${c.getSize()}px`))
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
              style={{ gridTemplateColumns: template, transform: `translateY(${v.start}px)` }}
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
