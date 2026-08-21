/** 订单详情。**点行才弹**,不默认占着右边一栏(所有者定稿)。
 *
 * 布局照厂商面板那一行的 8 组字段与顺序 —— 运营从他们那边迁过来时,
 * 眼睛不用重新学一遍东西放在哪。分组名也沿用他们的说法。
 *
 * 与厂商那边有两处刻意的不同:
 *  - 他们整段执行过程只有一个 `failContent` 自由文本字段;我们换成只追加的事件时间线。
 *  - 危险动作(强制回填)必须先过一个**预览步**,把「要写进库的到底是什么」摊开说清楚。
 */

import { useEffect, useState } from "react";
import { X, Zap } from "lucide-react";
import { CopyBlock, CopyText } from "@/components/CopyText";
import { Button } from "@/components/ui/button";
import { Dot, Tag } from "@/components/ui/tag";
import { Input } from "@/components/ui/input";
import { api, type ApiResult } from "@/lib/api";
import { useLabel, useMeta } from "@/lib/meta";
import { cn, fullTime, money, shortTime } from "@/lib/utils";
import type { TaskDetail as TD } from "@/types";

function Group({ title, note, right, children, last }: {
  title: string; note?: React.ReactNode; right?: React.ReactNode;
  children: React.ReactNode; last?: boolean;
}) {
  return (
    <div className={cn("px-3.5 py-3 flex flex-col gap-1.5 border-b border-zinc-100 min-w-0",
                       !last && "border-r")}>
      <div className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-zinc-400">
        {title}{note}
        {right && <span className="ml-auto normal-case tracking-normal">{right}</span>}
      </div>
      {children}
    </div>
  );
}

function KV({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-sm- leading-relaxed min-w-0">
      <span className="w-[58px] shrink-0 text-zinc-400 text-xs">{k}</span>
      <span className="text-zinc-800 min-w-0">{children}</span>
    </div>
  );
}

/** 一条事件说人话。
 *
 * 三件事分开处理,因为它们的正文在**不同的字段**里:
 *  · step —— 正文在 payload.step,插件发的时候就是中文(「清空购物车」「加购 B0… × 2」)
 *  · error / guard_block —— 正文是 code 的中文标签
 *  · 其余 —— 只有 payload
 *
 * 早先这里一律把 `code` 丢进错误码表查,于是 step 的 code 查不到就露出英文,
 * 后面还挂一个空的「·」。查错误码表是给错误码用的,step 的 code 不是错误码。
 */
function eventText(e: { kind: string; code: string | null; payload: Record<string, unknown> },
                   labels: Record<string, string>): string {
  const pl = e.payload ?? {};
  const head = e.kind === "step"
    ? String(pl.step ?? e.code ?? "")
    : e.code ? (labels[e.code] ?? e.code) : "";

  // payload 里除了已经当正文用掉的那个键,剩下的按 k=v 铺开。
  // 不用 JSON.stringify:引号和花括号在一行里读起来比值本身还占地方。
  const rest = Object.entries(pl)
    .filter(([k, v]) => k !== "step" && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);

  return [head, ...rest].filter(Boolean).join(" · ");
}

/** 可改的收货字段。与 services/task_admin._ADDRESS_FIELDS 一一对应 ——
 *  多一个服务端会以 BAD_FIELD 拒掉,少一个是界面自己把能力藏了。 */
/** AMZ 单号形状。与 services/task_query.AMZ_ORDER_RE 同一条规则。
 *
 *  不校验的后果不是「填错了报个错」——是**首尾一个空格就能绕开唯一索引**:
 *  `" 111-…"` 与 `"111-…"` 在库里是两个不同的值,同一张亚马逊订单于是能被
 *  钉到两条任务上,后面对账、物流、退款全跟着错。而这个动作恰恰是
 *  「跳过断言直接写库」的那一个。 */
const AMZ_ORDER_RE = /^\d{3}-\d{7}-\d{7}$/;

const ADDRESS_FIELDS: [string, string][] = [
  ["ship_name", "姓名"], ["ship_phone", "电话"], ["ship_line1", "地址"],
  ["ship_city", "城市"], ["ship_state", "州"], ["ship_postcode", "邮编"],
];

/** 真改动过的字段。原值与草稿相同的不算 —— 整份地址原样回传的话,
 *  事件流里那条 before/after 会记成「六个字段全改了」,
 *  以后查「谁把州改错了」就查不出来了。 */
function changedAddress(t: TD, draft: Record<string, string>): string[] {
  return ADDRESS_FIELDS
    .map(([k]) => k)
    .filter((k) => draft[k] !== undefined && draft[k] !== String(t[k as keyof TD] ?? ""));
}

/** 清空了的字段。收货六项都是 NOT NULL 的必填项,空串写进去等于把地址弄残 ——
 *  而界面上那句「将改 N 个字段」看着像是在把关,其实一个字都没校验。 */
function blankedAddress(draft: Record<string, string>): string[] {
  return ADDRESS_FIELDS.map(([k]) => k)
    .filter((k) => draft[k] !== undefined && draft[k].trim() === "");
}

const Hint = ({ children }: { children: React.ReactNode }) => (
  <div className="mt-0.5 text-xs+ text-zinc-400 leading-relaxed">{children}</div>
);

export function TaskDetailModal({ taskId, onClose, onMutate }: {
  taskId: number;
  onClose: () => void;
  onMutate: () => void;
}) {
  const meta = useMeta();
  const statusLabel = useLabel("task_status");
  const shipLabel = useLabel("shipment_status");
  const eventLabel = useLabel("event_kind");

  const [t, setT] = useState<TD | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 哪一个危险动作正在预览。null = 没有。
   *  两个动作共用一条预览条,但绝不共用一个布尔 —— 那样点错按钮会确认成另一件事。 */
  const [confirm, setConfirm] = useState<null | "force" | "reset">(null);
  const [forceNo, setForceNo] = useState("");
  const [note, setNote] = useState("");
  /** 正在改哪一样。改地址/改 ASIN 的接口早就有、也有测试,只是一直没有入口 ——
   *  接口存在而界面到不了,对用这套东西的人来说等于这个功能不存在。 */
  const [editing, setEditing] = useState<null | "address" | "asin">(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [productsOpen, setProductsOpen] = useState(false);

  const load = () => {
    setErr(null);
    api.taskDetail(taskId).then((r) => {
      if (r.ok) setT(r.data);
      else setErr(r.kind === "transport" ? `读不到详情:${r.message}` : `${r.code} · ${r.message}`);
    });
  };
  useEffect(load, [taskId]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      // 预览步开着的时候 Esc 只收预览,不收整个弹窗 ——
      // 一个键既能取消危险动作又能关窗,手一抖就分不清刚才取消的是哪一个。
      if (e.key !== "Escape") return;
      if (confirm) { setConfirm(null); return; }
      if (editing) { setEditing(null); return; }
      onClose();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [confirm, editing, onClose]);

  const run = async (p: Promise<ApiResult<unknown>>) => {
    setBusy(true);
    const r = await p;
    setBusy(false);
    if (!r.ok) {
      setErr(r.kind === "transport" ? `没说上话:${r.message}` : `${r.code} · ${r.message}`);
      return false;
    }
    setErr(null);
    setConfirm(null);
    setEditing(null);
    load();
    onMutate();
    return true;
  };

  const shell = (body: React.ReactNode) => (
    <div className="absolute inset-0 bg-zinc-900/30 flex items-center justify-center z-20 p-6"
         onClick={onClose}>
      <div className="w-[1300px] max-w-full max-h-full bg-white border border-zinc-200 rounded-[10px]
                      shadow-2xl flex flex-col overflow-hidden"
           onClick={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>
  );

  if (!t) {
    return shell(
      <div className="h-40 flex items-center justify-center text-xs text-zinc-400">
        {err ?? "读取中…"}
      </div>,
    );
  }

  const s = statusLabel(t.status);
  const p = t.products?.[0];
  const bought = !!t.amazon_order_no;
  const addressBlock =
    `${t.ship_name}\n${t.ship_phone}\n${t.ship_line1}\n${t.ship_city}, ${t.ship_state} ${t.ship_postcode}\n${t.ship_country}`;

  const codeTone = (code: string) =>
    meta.error_code.possibly_ordered.includes(code) ? "solid-violet"
    : meta.error_code.to_manual.includes(code) ? "dashed-amber"
    : meta.error_code.business_blocked.includes(code) ? "solid-zinc"
    : meta.error_code.retryable.includes(code) ? "dashed-zinc"
    : "solid-red";

  /** 「可能已经下单」那一组的处置方式跟别的**相反**:不能直接退回队列重拍。
   *  这句话必须在按钮旁边说出来,而不是指望人记得住 19 个码分别属于哪一组。 */
  const maybeOrdered = !!t.error_code && meta.error_code.possibly_ordered.includes(t.error_code);

  return shell(
    <>
      <div className="h-[52px] shrink-0 flex items-center gap-2.5 px-[18px] border-b border-zinc-200">
        <span className="text-[13px] font-semibold text-zinc-900">订单详情</span>
        <CopyText value={t.upstream_order_no} className="id text-[13px] text-zinc-900" />
        <Tag tone={s.tone}>{s.label}</Tag>
        <Tag tone="dashed-zinc">{t.marketplace}</Tag>
        <span className="ml-auto text-xs+ text-zinc-400">
          关闭 <kbd className="font-mono text-2xs px-1.5 py-px border border-zinc-200 border-b-2 rounded bg-zinc-50">Esc</kbd>
        </span>
        <Button variant="ghost" size="sm" onClick={onClose}><X className="w-3.5 h-3.5" /></Button>
      </div>

      <div className="overflow-auto">
        <div className="grid grid-cols-4 border-t border-zinc-100">
          <Group title="上游订单">
            <KV k="上游单号"><CopyText value={t.upstream_order_no} className="id text-sm- text-zinc-900" /></KV>
            <KV k="行唯一键">
              <span className="id text-xs+ text-zinc-500 break-all">{t.line_key.slice(0, 24)}…</span>
            </KV>
            <KV k="站点">{t.marketplace} · amazon.com</KV>
            <Hint>店铺留在上游 ERP,这里不存。行唯一键 = sha256(上游单号|ASIN×数量)</Hint>
          </Group>

          <Group title="收货信息"
                 note={<span className="text-sky-500">· 上游下发</span>}
                 right={<CopyBlock value={addressBlock} />}>
            <KV k="姓名"><CopyText value={t.ship_name} icon={false} /></KV>
            <KV k="电话"><CopyText value={t.ship_phone} className="id text-xs" icon={false} /></KV>
            <KV k="地址"><CopyText value={t.ship_line1} icon={false} className="leading-snug" /></KV>
            <KV k="城市/州">{t.ship_city}, {t.ship_state}</KV>
            <KV k="邮编"><CopyText value={t.ship_postcode} className="id text-xs" icon={false} /></KV>
          </Group>

          {/* 产品格在 grid-cols-4 里,把 products 全量铺开会把同一行的另外三格
              (上游订单/收货信息/订单信息)一起拉到同样高度,后半页被顶出视野。
              先显示三个,其余折起来 —— 一单二十个商品是有的。 */}
          <Group title="产品信息">
            {(t.products ?? []).slice(0, productsOpen ? undefined : 3).map((prod, i) => (
              <div key={i} className="flex flex-col gap-1 border-b border-zinc-50 last:border-0 pb-1 last:pb-0">
                <KV k="ASIN"><CopyText value={prod.asin} className="id text-[13px] text-zinc-900" /></KV>
                <KV k="数量"><span className="num text-sm-">{prod.quantity}</span></KV>
                {/* 单价不拿限价着色:限价是**整单**的(price_guard 判的是
                    actual_total > price_cap)。超没超看下面费用信息那一格。 */}
                <KV k="实付单价"><span className="id text-zinc-800">{money(prod.actual_unit_price)}</span></KV>
              </div>
            ))}
            {(t.products?.length ?? 0) > 3 && (
              <button type="button" onClick={() => setProductsOpen((v) => !v)}
                      className="self-start text-xs+ text-sky-700 hover:text-sky-900">
                {productsOpen ? "收起" : `另 ${t.products!.length - 3} 项商品`}
              </button>
            )}
            <KV k="整单限价">
              <span className="id text-zinc-900">{money(t.price_cap)}</span>
              <span className="ml-1.5 text-xs+ text-zinc-400">上游算好下发</span>
            </KV>
            <KV k="最迟送达">{t.max_delivery_days} 天内</KV>
          </Group>

          <Group title="订单信息" last>
            <KV k="AMZ 单号">
              {bought ? <CopyText value={t.amazon_order_no} className="id text-sm- text-zinc-900" />
                      : <span className="id text-zinc-400">未写入</span>}
            </KV>
            <KV k="下单时间"><span className="id text-xs">{fullTime(t.purchased_at)}</span></KV>
            <KV k="信用卡"><span className="id text-xs">{t.payment_last4 ? `•••• ${t.payment_last4}` : "—"}</span></KV>
            <Hint>断言在回填那一刻做,不符就不写库 —— 不存导入值/同步值两份再打红叉</Hint>
          </Group>

          <Group title="费用信息">
            {bought ? (
              <>
                {([["运费", t.actual_shipping], ["税费", t.actual_tax]] as const).map(([k, v]) => (
                  <div key={k} className="flex items-center h-[26px] text-sm-">
                    <span className="text-zinc-500">{k}</span>
                    <span className="num ml-auto">{money(v)}</span>
                  </div>
                ))}
                <div className="flex items-center h-[26px] text-sm- border-t border-zinc-100">
                  <span className="text-zinc-900">总计</span>
                  <span className={cn("num ml-auto", t.actual_total
                    && Number(t.actual_total) > Number(t.price_cap)
                    ? "text-red-600 font-medium" : "text-zinc-900")}>
                    {money(t.actual_total)}
                  </span>
                </div>
                {/* 「没有这个数」不能渲染成「未超」。
                    actual_total 为 null 时(强制回填的单必然如此,插件也可能没回传),
                    原先整个表达式是假值 → 落进 else → 画绿点写「未超」。
                    那是一个**从来没算过的护栏结论**,而它长得跟真算过的一模一样。 */}
                <div className="flex items-center gap-1.5 mt-0.5">
                  <Dot tone={t.actual_total === null ? "amber-hollow"
                             : Number(t.actual_total) > Number(t.price_cap) ? "red" : "emerald"} />
                  <span className="text-xs+ text-zinc-600">
                    {t.actual_total === null
                      ? `实付金额没回传,限价 ${money(t.price_cap)} 这一条没法核`
                      : Number(t.actual_total) > Number(t.price_cap)
                        ? `超限价 ${money(String(Number(t.actual_total) - Number(t.price_cap)))}`
                        : `限价 ${money(t.price_cap)},未超`}
                  </span>
                </div>
              </>
            ) : (
              <div className="text-sm- text-zinc-500 leading-relaxed">
                还没有下单,也就没有实付金额 —— 这几格空着是对的,不是没同步上。
              </div>
            )}
          </Group>

          <Group title="物流信息">
            {t.shipment ? (
              <>
                <KV k="物流商">{t.shipment.carrier ?? "—"}</KV>
                <KV k="运单号"><CopyText value={t.shipment.tracking_no} className="id text-xs+" /></KV>
                <KV k="状态">
                  {t.shipment.status
                    ? (() => { const x = shipLabel(t.shipment!.status); return <Tag tone={x.tone}>{x.label}</Tag>; })()
                    : "—"}
                </KV>
                <KV k="预计送达">{t.delivery_date ?? "—"}</KV>
                {t.delivery_raw && <Hint>Amazon 原文「{t.delivery_raw}」</Hint>}
                {/* 轨迹明细。seq 0 = 最新,所以从上往下就是倒序,跟快递页面一致。
                    解析不出时间的用 Amazon 原文兜底 —— 解析规则会变,原文不会。 */}
                {!!t.shipment.events?.length && (
                  <div className="mt-1 flex flex-col gap-1 border-t border-zinc-100 pt-1.5">
                    {t.shipment.events.slice(0, 4).map((e, i) => (
                      <div key={i} className="flex items-baseline gap-1.5 text-xs leading-snug">
                        <span className={cn("mt-1 shrink-0 w-1.5 h-1.5 rounded-full",
                                            i === 0 ? "bg-sky-500" : "bg-zinc-300")} />
                        <span className="text-zinc-700 min-w-0">
                          {e.description ?? "—"}
                          {(e.city || e.state_code) && (
                            <span className="text-zinc-400"> · {[e.city, e.state_code]
                              .filter(Boolean).join(", ")}</span>
                          )}
                        </span>
                        <span className="id text-2xs text-zinc-400 ml-auto shrink-0">
                          {e.happened_at ? shortTime(e.happened_at)
                                         : [e.raw_day, e.raw_time].filter(Boolean).join(" ")}
                        </span>
                      </div>
                    ))}
                    {t.shipment.events.length > 4 && (
                      <div className="text-2xs text-zinc-400">
                        另有 {t.shipment.events.length - 4} 条更早的轨迹
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="text-sm- text-zinc-400 leading-relaxed">
                {bought ? "已下单,还没同步到轨迹" : "还没有订单,也就没有轨迹可同步"}
              </div>
            )}
          </Group>

          <Group title="买家号信息">
            <KV k="环境名">{t.env_code}</KV>
            <KV k="买家号ID"><CopyText value={t.amazon_customer_id} className="id text-xs+" /></KV>
            <KV k="信用卡"><span className="id text-xs">{t.payment_last4 ? `•••• ${t.payment_last4}` : "—"}</span></KV>
            <KV k="执行实例"><span className="id text-xs+">{t.executed_by_uid ?? "—"}</span></KV>
            <Hint>
              执行实例取的是「当初谁跑的」(最后一次认领),不是 claimed_by ——
              后者是在途指针,落终态就清空了
            </Hint>
          </Group>

          <Group title="执行信息" last>
            <KV k="状态">
              <Tag tone={s.tone}>{s.label}</Tag>
              <span className="id text-2xs text-zinc-400 ml-1.5">{t.status}</span>
            </KV>
            <KV k="错误码">
              {t.error_code
                ? <>
                    <Tag tone={codeTone(t.error_code)}>
                      {meta.error_code.labels[t.error_code] ?? t.error_code}
                    </Tag>
                    <span className="id text-2xs text-zinc-400 ml-1.5">{t.error_code}</span>
                  </>
                : <span className="text-zinc-400">—</span>}
            </KV>
            <KV k="创建时间"><span className="id text-xs">{fullTime(t.created_at)}</span></KV>
            <KV k="采购时间"><span className="id text-xs">{fullTime(t.purchased_at)}</span></KV>
            <Hint>没有「创建者」—— 单子由上游下发,不是人在这里建的</Hint>
          </Group>
        </div>

        {t.error_detail && (
          <div className="px-[18px] py-3 border-b border-zinc-100">
            <div className={cn("rounded-md border px-3 py-2.5 flex items-start gap-2.5",
                               maybeOrdered ? "bg-violet-50 border-violet-200"
                                            : "bg-zinc-50 border-zinc-200")}>
              <span className="mt-1.5"><Dot tone={maybeOrdered ? "violet" : "zinc"} /></span>
              <div className="text-sm- text-zinc-600 leading-relaxed">
                {t.error_detail}
                {maybeOrdered && (
                  <div className="mt-1 text-violet-700">
                    这一组的处置方式跟别的<b className="font-medium">相反</b>:下单可能已经成了,直接退回队列重拍会拍成两单。
                    先去亚马逊订单页确认,再决定是回填单号还是重置。
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="px-[18px] pt-3 pb-3.5">
          <div className="mb-2.5 text-2xs font-medium uppercase tracking-wider text-zinc-400">
            事件时间线 · 只追加
            <span className="ml-1.5 normal-case tracking-normal text-zinc-500">
              · 厂商那边这一整段只有一个 failContent 自由文本字段
            </span>
          </div>
          {t.events.length === 0
            ? <div className="text-xs text-zinc-400">还没有事件 —— 这一单还没被任何实例领走</div>
            : (
              <div className="flex flex-col gap-0">
                {t.events.map((e, i) => {
                  const x = eventLabel(e.kind);
                  return (
                    <div key={i} className="flex items-start gap-2.5 py-1">
                      <span className="mt-1.5 shrink-0"><Dot tone={meta.event_kind.tone[e.kind] ?? "zinc"} /></span>
                      <span className="text-xs text-zinc-800 w-[76px] shrink-0">{x.label}</span>
                      <span className="text-xs text-zinc-600 flex-1 min-w-0 break-words">
                        {eventText(e, meta.error_code.labels)}
                      </span>
                      <span className="id text-2xs text-zinc-400 shrink-0">{shortTime(e.created_at)}</span>
                      <span className="id text-2xs text-zinc-300 shrink-0 w-[92px] text-right truncate">
                        {e.instance_uid ?? ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      </div>

      {editing === "address" && (
        <div className="border-t border-zinc-200 bg-zinc-50 px-[18px] py-3 flex flex-col gap-2">
          <div className="text-2xs font-medium uppercase tracking-wider text-zinc-400">
            改收货地址
            <span className="ml-1.5 normal-case tracking-normal text-zinc-500">
              · 只改我们库里的值。已下单的单子服务端会拒 —— 货在路上了,
              改库里的地址只会让库和现实对不上
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {ADDRESS_FIELDS.map(([key, label]) => (
              <label key={key} className="flex items-center gap-1.5">
                <span className="w-[52px] shrink-0 text-xs text-zinc-500">{label}</span>
                <Input className="flex-1 min-w-0"
                       value={draft[key] ?? String(t[key as keyof TD] ?? "")}
                       onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {/* 只把**真改动过**的字段发出去。整份地址原样回传的话,
                事件流里那条 before/after 会记成「六个字段全改了」,
                以后查「谁把州改错了」就查不出来了。 */}
            <span className={cn("text-xs+",
              blankedAddress(draft).length ? "text-red-600" : "text-zinc-400")}>
              {blankedAddress(draft).length
                ? `${blankedAddress(draft).map((k) =>
                     ADDRESS_FIELDS.find(([f]) => f === k)![1]).join("、")}不能空`
                : changedAddress(t, draft).length
                  ? `将改 ${changedAddress(t, draft).length} 个字段`
                  : "还没有改动"}
            </span>
            <span className="ml-auto" />
            <Button size="sm" onClick={() => { setEditing(null); setDraft({}); }}>取消</Button>
            <Button size="sm" variant="primary"
                    disabled={busy || changedAddress(t, draft).length === 0
                              || blankedAddress(draft).length > 0}
                    onClick={() => {
                      const fields = Object.fromEntries(
                        changedAddress(t, draft).map((k) => [k, draft[k].trim()]));
                      void run(api.updateAddress(t.id, fields));
                    }}>
              保存
            </Button>
          </div>
        </div>
      )}

      {editing === "asin" && (
        <div className="border-t border-zinc-200 bg-zinc-50 px-[18px] py-3 flex flex-col gap-2">
          <div className="text-2xs font-medium uppercase tracking-wider text-zinc-400">
            改 ASIN
            <span className="ml-1.5 normal-case tracking-normal text-zinc-500">
              · 行唯一键<b className="font-medium text-zinc-700">不重算</b>:
              它是导入期的去重键,不是内容摘要。改了会在事件流里留痕
            </span>
          </div>
          <div className="max-h-[168px] overflow-auto flex flex-col gap-2">
          {(t.products ?? []).map((prod, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="id text-xs text-zinc-500 w-[104px] shrink-0">{prod.asin}</span>
              <span className="text-xs text-zinc-400">→</span>
              <Input className="w-[140px] font-mono" placeholder="新 ASIN"
                     value={draft[prod.asin] ?? ""}
                     onChange={(e) => setDraft((d) => ({ ...d, [prod.asin]: e.target.value.trim() }))} />
              <Button size="sm" variant="primary"
                      disabled={busy || !draft[prod.asin] || draft[prod.asin] === prod.asin}
                      onClick={() => void run(api.updateAsin(t.id, prod.asin, draft[prod.asin]))}>
                替换
              </Button>
            </div>
          ))}
          </div>
          <div className="flex">
            <span className="ml-auto" />
            <Button size="sm" onClick={() => { setEditing(null); setDraft({}); }}>关闭</Button>
          </div>
        </div>
      )}

      {err && (
        <div className="px-[18px] py-2 border-t border-red-200 bg-red-50 text-sm- text-red-700">
          {err}
        </div>
      )}

      {confirm === "force" && (
        <div className="border-t border-red-200 bg-red-50 px-[18px] py-3 flex items-center gap-3">
          <Zap className="w-3.5 h-3.5 shrink-0 text-red-700" />
          <div className="text-sm- text-zinc-600 leading-relaxed flex-1">
            要写进库的是:把 <span className="id text-zinc-700">{t.upstream_order_no}</span> 的 AMZ 单号
            钉成人工填的 <span className="id text-zinc-900">{forceNo}</span>,状态改成
            <Tag tone="solid-emerald" className="mx-1">已拍单</Tag>,并
            <b className="font-medium text-zinc-900">跳过 ASIN 断言</b> ——
            断言正是当初把它挡在这儿的那道闸。写完不可撤销。
          </div>
          <Button size="sm" onClick={() => setConfirm(null)}>再想想</Button>
          <Button size="sm" variant="danger"
                  disabled={busy || !AMZ_ORDER_RE.test(forceNo) || !note.trim()}
                  onClick={() => void run(api.forceBackfill(t.id, forceNo, note.trim()))}>
            <Zap className="w-3 h-3" />确认写入
          </Button>
        </div>
      )}

      {/* 服务端拒绝过一次(NEEDS_ACK)才会走到这里。
          「已确认」是**人做的一个动作**,不是前端算出来的一个布尔 ——
          由前端看错误码自动带上 acknowledged,等于把服务端那道闸自己拆了,
          而闸上写着的正是「可能已经真下成了单」。 */}
      {confirm === "reset" && (
        <div className="border-t border-violet-200 bg-violet-50 px-[18px] py-3 flex items-center gap-3">
          <span className="mt-px"><Dot tone="violet" /></span>
          <div className="text-sm- text-zinc-600 leading-relaxed flex-1">
            <b className="font-medium text-zinc-900">
              {t.error_code} 意味着这一单可能已经在亚马逊上真下成了。
            </b>
            {" "}重置回队列 = 让下一个实例把同一单再买一遍。
            请先去买家号 <span className="id text-zinc-700">{t.env_code}</span> 的订单页确认
            <span className="id text-zinc-700"> {p?.asin ?? ""} </span>
            没有这一单,再点确认。
          </div>
          <Button size="sm" onClick={() => setConfirm(null)}>先去看看</Button>
          <Button size="sm" variant="danger" disabled={busy}
                  onClick={() => void run(api.resetTask(t.id, true))}>
            我已确认没有这一单,重置
          </Button>
        </div>
      )}

      <div className="min-h-[56px] shrink-0 border-t border-zinc-200 bg-zinc-50
                      flex items-center gap-2 px-[18px] py-2 flex-wrap">
        <CopyBlock value={addressBlock} label="复制收货地址"
                   className="h-7 px-2 border border-zinc-300 rounded-md bg-white text-xs" />

        {/* 与服务端 services/task_admin._FROZEN_FOR_EDIT 一一对应。
            **claimed 是最要紧的那个**:插件此刻正拿着这一单的旧快照在亚马逊上下单,
            改了它会买错东西或者寄错地方。已下单/已取消则是货已在路上或单已作废。
            服务端都会拒,按钮也就不该亮着 —— 点下去必然被拒的按钮,
            是在让人以为自己做错了什么。 */}
        {!["claimed", "purchased", "cancelled"].includes(t.status) && (
          <>
            <Button size="sm" onClick={() => { setDraft({}); setEditing("address"); }}>改地址</Button>
            <Button size="sm" onClick={() => { setDraft({}); setEditing("asin"); }}>改 ASIN</Button>
          </>
        )}

        {t.status === "pending" && (
          <Button size="sm" variant="primary" disabled={busy}
                  onClick={() => void run(api.releaseTask(t.id))}>放行到队列</Button>
        )}
        {(t.status === "exception" || t.status === "manual") && (
          <Button size="sm" disabled={busy}
                  onClick={async () => {
                    // 一律先按「未确认」发。服务端回 NEEDS_ACK 就是它在说
                    // 「这一单可能已经真下成了」—— 那句话要让人看见并回应,
                    // 不能由前端替人答。
                    setBusy(true);
                    const r = await api.resetTask(t.id, false);
                    setBusy(false);
                    if (r.ok) { setErr(null); load(); onMutate(); return; }
                    if (!r.ok && r.kind === "business" && r.code === "NEEDS_ACK") {
                      setErr(null); setConfirm("reset"); return;
                    }
                    setErr(r.kind === "transport" ? `没说上话:${r.message}` : `${r.code} · ${r.message}`);
                  }}>
            重置回待拍单
          </Button>
        )}

        <span className="ml-auto" />

        {/* 只对 manual 亮:services/task_admin.force_backfill 只接受 manual。
            对 exception 也亮的话,人会走完整条红色确认条,然后吃一个 BAD_STATUS ——
            一个必然被拒的危险按钮,比没有按钮更伤信任。 */}
        {t.status === "manual" && !bought && (
          <>
            <Input value={forceNo}
                   onChange={(e) => setForceNo(e.target.value.trim())}
                   placeholder="111-1234567-1234567"
                   className={cn("w-[172px] font-mono",
                                 forceNo && !AMZ_ORDER_RE.test(forceNo) && "border-red-400")} />
            <Input value={note} onChange={(e) => setNote(e.target.value)}
                   placeholder="为什么要强填(必填)" className="w-[200px]" />
            <Button size="sm" variant="danger"
                    disabled={busy || !AMZ_ORDER_RE.test(forceNo) || !note.trim()}
                    title={forceNo && !AMZ_ORDER_RE.test(forceNo)
                      ? "AMZ 单号形如 111-1234567-1234567" : ""}
                    onClick={() => setConfirm("force")}>
              <Zap className="w-3 h-3" />强制回填单号
            </Button>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
      </div>
    </>,
  );
}
