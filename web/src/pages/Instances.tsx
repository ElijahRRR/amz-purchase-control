/** 买家号 / 插件实例。回答一个问题:现在有几台机器真的在拍单。
 *
 * 判活是有时限的,所以这一页定时刷。一个停在「在线」不动的绿点比没有灯更坏 ——
 * 那正是「看起来有护栏、实际防不住」的样子。
 */

import { useCallback, useEffect, useState } from "react";
import { CopyText } from "@/components/CopyText";
import { Card, CardHead } from "@/components/ui/card";
import { Tag, type Tone } from "@/components/ui/tag";
import { api } from "@/lib/api";
import { useLabel } from "@/lib/meta";
import { cn, shortTime } from "@/lib/utils";
import type { InstanceRow } from "@/types";

/** 「该刷哪张卡」这一格。留空 = 这个买家号不校验支付方式。
 *
 *  做成可改的而不是只读的:配错一位数的后果是这个买家号从此每一单都被
 *  「支付卡不符」拦下,而运营看到那句话会去查买家号的支付方式、查不出问题。
 *  能就地改掉,是这一格唯一说得过去的形态。
 *
 *  形状校验在服务端(services/instance.set_expected_card)。这里也拦一道,
 *  但这一道是**便利**不是保证 —— 接口是公开的,curl 一下就绕过去了。
 *
 *  **清空这一格 = 把 PAYMENT_METHOD_UNEXPECTED 这道下单前的闸整个关掉**,
 *  所以它单独过一次确认。原先是「按了退格再点别处」就生效:没有二次确认、
 *  没有成功提示,而按 set_expected_card 自己的自述也没有任何审计记录 ——
 *  这个买家号从此每一单都不再校验支付卡,界面只是把输入框变成灰色的「不校验」。
 *  对照:同一套界面里危险性小得多的「强制回填单号」必须过一个红色预览步。
 *  **填一个新值不需要确认**(填错了的表现是每一单都被拦下,吵而安全);
 *  只有「关掉」这个方向要。 */
function ExpectedCard({ row, onSaved }: { row: InstanceRow; onSaved: () => void }) {
  const [v, setV] = useState(row.expected_card_last4 ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 等人确认「确实要关掉这道闸」。null = 没在等。 */
  const [confirmOff, setConfirmOff] = useState(false);
  // 别人改了库(或者别的标签页改了)时跟着刷新,但正在输入的时候不抢用户的光标
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setV(row.expected_card_last4 ?? "");
  }, [row.expected_card_last4, focused]);

  const commit = async (next: string) => {
    setBusy(true);
    const r = await api.setExpectedCard(row.env_id, next);
    setBusy(false);
    setConfirmOff(false);
    if (r.ok) { setErr(null); onSaved(); }
    else setErr(r.kind === "transport" ? "没说上话" : r.message);
  };

  const save = async () => {
    const next = v.trim();
    if (next === (row.expected_card_last4 ?? "")) return;
    if (next && !/^\d{4}$/.test(next)) {
      setErr("要 4 位数字,留空表示不校验");
      return;
    }
    // 从「配着一张卡」变成「留空」= 关掉一道下单前的护栏。先问一句。
    if (!next && row.expected_card_last4) { setConfirmOff(true); return; }
    await commit(next);
  };

  return (
    <span className="inline-flex items-center gap-1">
      <input
        value={v}
        onChange={(e) => { setV(e.target.value.replace(/\D/g, "").slice(0, 4)); setErr(null); }}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); void save(); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        disabled={busy}
        placeholder="不校验"
        className={cn("id text-xs+ w-16 px-1 py-0.5 rounded border bg-white",
                      err ? "border-red-300 text-red-700"
                          : "border-zinc-200 text-zinc-700 focus:border-sky-400")}
      />
      {err && <span className="text-2xs text-red-600">{err}</span>}
      {confirmOff && (
        <span className="inline-flex items-center gap-1.5 text-2xs text-red-700">
          关掉之后这个买家号的每一单都不再核对支付卡,确定?
          <button className="px-1.5 py-0.5 rounded border border-red-300 bg-white text-red-700"
                  disabled={busy}
                  onClick={() => void commit("")}>关掉</button>
          <button className="px-1.5 py-0.5 rounded border border-zinc-200 bg-white text-zinc-600"
                  disabled={busy}
                  onClick={() => { setConfirmOff(false); setV(row.expected_card_last4 ?? ""); }}>
            算了
          </button>
        </span>
      )}
    </span>
  );
}

/** 「这台机器登着的是不是这个买家号」这一格。
 *
 *  为什么这一格必须存在:两台机器登错号是真会发生的事(防关联环境一多,
 *  谁的 profile 里登了哪个号是记不住的)。在此之前这一页对它一无所知 ——
 *  一台登着隔壁号的机器在这里是满格绿色的「在线 · 可派」,而它领到的每一单
 *  都会用**另一个买家号**在亚马逊上真买下来。与登录态那一列当初的毛病一模一样。
 *
 *  四档四种说法(封闭集与标签都从 /v1/admin/meta 来,前端不存副本):
 *    ok          两个 ID 对得上
 *    mismatch    对不上 —— 服务端已经在拒绝派单了,这里要把两个 ID 都摆出来
 *    unverified  买家号那一列有值、这台机器还没报过 —— **服务端同样在拒绝派单**
 *                (最容易登错号的正是这一刻:新装 / 新 profile / 换了机器),
 *                但它会自己好,所以是琥珀不是红,而且不给「以这个为准」——
 *                手里根本没有第二个 ID 可以拿来为准
 *    unknown     买家号那一列也还是空的 —— 没有任何东西可比,**不拦单**,
 *                别渲染成红的
 *
 *  「以这个为准」只在 mismatch 时给:它把库里那一列改成插件报的,
 *  **等于把闸打开**,所以要过一次确认,而且服务端会写 procure.env_events
 *  (带操作人)—— 一个能开闸的按钮按完之后库里一个字都不留是不行的。 */
function CustomerId({ row, onSaved }: { row: InstanceRow; onSaved: () => void }) {
  const label = useLabel("account_state");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const g = label(row.account_state);

  const take = async () => {
    if (!row.instance_customer_id) return;
    setBusy(true);
    const r = await api.setEnvCustomerId(row.env_id, row.instance_customer_id);
    setBusy(false);
    setConfirm(false);
    if (r.ok) { setErr(null); onSaved(); }
    else setErr(r.kind === "transport" ? "没说上话" : r.message);
  };

  if (row.account_state === "mismatch") {
    return (
      <span className="flex flex-col gap-0.5 items-start">
        <Tag tone={g.tone}>{g.label}</Tag>
        {/* 两个 ID 都摆出来。只写「登错号」的话,人没法判断该去改机器还是改库。 */}
        <span className="text-2xs text-red-700 whitespace-nowrap">
          登录的不是这个买家号(<span className="id">{row.instance_customer_id}</span>
          {" ≠ "}<span className="id">{row.amazon_customer_id}</span>)
        </span>
        {confirm ? (
          <span className="inline-flex items-center gap-1.5 text-2xs text-red-700">
            改成插件报的这个,派单就会恢复。确定?
            <button className="px-1.5 py-0.5 rounded border border-red-300 bg-white text-red-700"
                    disabled={busy} onClick={() => void take()}>以这个为准</button>
            <button className="px-1.5 py-0.5 rounded border border-zinc-200 bg-white text-zinc-600"
                    disabled={busy} onClick={() => setConfirm(false)}>算了</button>
          </span>
        ) : (
          <button className="text-2xs text-sky-700 hover:text-sky-900"
                  title="确认过「这台机器登的号才是对的、库里那一列记错了」再点。如果是机器登错了号,该做的是去那台机器上换回来。"
                  onClick={() => setConfirm(true)}>以这个为准</button>
        )}
        {err && <span className="text-2xs text-red-600">{err}</span>}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5 items-start">
      <Tag tone={g.tone}>{g.label}</Tag>
      {/* 「还没比对过」也要把手里有的那个 ID 显示出来 —— 空着的话,
          「买家号那一列没写过」和「插件没报过」看起来一模一样。 */}
      <span className="id text-2xs text-zinc-400">
        {row.amazon_customer_id ?? row.instance_customer_id ?? "—"}
      </span>
      {/* unverified 与 unknown 长得像,但一个拦着这个买家号的全部派单、
          一个什么也没拦。不说出来的话,运营看到一台「在线」的机器一整天不动,
          只能去猜是不是插件坏了 —— 而这一格手里就有答案。 */}
      {row.account_state === "unverified" && (
        <span className="text-2xs text-amber-700">
          派单先停着,等这台机器报一次它登着谁
        </span>
      )}
    </span>
  );
}

/** 表头。**提到组件外是为了让空态那两行的 colSpan 跟着它走** ——
 *  写死一个数字的话,加一列就得记得同时改三处,而漏掉的那次没有任何测试会红:
 *  HTML 表格的列数取所有行的最大值,colSpan 比真实列数大 1 就会凭空多出一列,
 *  表头行少一格、列宽整体重算,空态与有数据时的列位置对不上。
 *  这个 +1 的偏差已经继承了两轮(12 列写 13、14 列写 15)。 */
const HEADERS = ["买家号", "站点", "实例", "插件版本", "最后心跳", "队列待拍",
                 "待人工", "今日已拍", "日上限", "支付卡尾号", "状态", "登录态",
                 "买家号ID", "清车", "可派单"];

const LIVENESS: Record<InstanceRow["liveness"], { label: string; tone: Tone; dot: string }> = {
  online: { label: "在线", tone: "solid-emerald", dot: "bg-emerald-500" },
  // 失联用琥珀不用红:机器没心跳不等于出事,但也确实不能派单给它。
  stale: { label: "失联", tone: "dashed-amber", dot: "bg-amber-500" },
  paused: { label: "暂停", tone: "solid-zinc", dot: "bg-zinc-400" },
  never: { label: "未连过", tone: "dashed-zinc", dot: "bg-zinc-300" },
};

export default function InstancesPage() {
  // 登录态的中文标签走 /v1/admin/meta,前端不存副本 —— 这个项目已经因为
  // 「两份副本悄悄分叉」栽过两次。
  const loginLabel = useLabel("login_state");
  // 「可派单」那一格里账号这一支的措辞**从 meta 来**,前端不写死:
  // 这道闸拦两档(登错号 / 等账号报上来),写死一句话的话,一台刚装好的机器
  // 会被当成登错号,人跑到机器前不知道该干什么。
  const accountLabel = useLabel("account_state");
  const [rows, setRows] = useState<InstanceRow[] | null>(null);
  const [stale, setStale] = useState<number>(0);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await api.instances();
    if (r.ok) { setRows(r.data.items); setStale(r.data.stale_seconds); setErr(null); }
    else setErr(r.kind === "transport" ? `连不上服务端:${r.message}` : `${r.code} · ${r.message}`);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => { if (alive) await refresh(); };
    void tick();
    const id = window.setInterval(tick, 10_000);
    return () => { alive = false; window.clearInterval(id); };
  }, [refresh]);

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
            派单只会派给「在线、未暂停、没到日上限、还登着 Amazon、且登的就是这个号」的买家号 ·
            支付卡尾号留空表示不校验
          </span>}>买家号 · 实例</CardHead>

          <table className="w-full">
            <thead>
              <tr className="bg-zinc-50 border-b border-zinc-200">
                {HEADERS.map((h, i) => (
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
                    <td className="px-3">
                      {/* 留空 = 不校验。这一格与 daily_cap 的 0 是同一种表达:
                          「不设限」得写出来,别让人对着一个空格去猜。 */}
                      <ExpectedCard row={r} onSaved={() => void refresh()} />
                    </td>
                    <td className="px-3"><Tag tone={L.tone}>{L.label}</Tag></td>
                    <td className="px-3 whitespace-nowrap">
                      {/* 登录态与「状态」是两条独立的轴:心跳一秒不落的机器,
                          浏览器里那个 Amazon 账号照样可能已经被登出。
                          这一列在之前是没有的 —— 于是被登出的买家号在这一页上
                          是满格绿色的「在线 · 可派」,而它领到的每一单都会走到
                          /ap/signin 然后超时,看起来只是"页面慢"。 */}
                      {(() => {
                        const g = loginLabel(r.login_state);
                        return <Tag tone={g.tone}>{g.label}</Tag>;
                      })()}
                      {/* 一分钟前读到的「已登录」和三天前读到的不是一回事。
                          不写出检查时间的话,这两种渲染成同一个绿标签。 */}
                      <span className="ml-1.5 text-2xs text-zinc-400">
                        {r.login_checked_at ? shortTime(r.login_checked_at) : "未查过"}
                      </span>
                    </td>
                    <td className="px-3">
                      {/* 登录态答的是「还登着吗」,这一格答的是「登着的是不是**这个号**」——
                          两条独立的轴。一台心跳一秒不落、登录态 ok 的机器,
                          浏览器里登的完全可能是隔壁那个号。 */}
                      <CustomerId row={r} onSaved={() => void refresh()} />
                    </td>
                    <td className="px-3 whitespace-nowrap">
                      {/* 清车失败原先是「只写不读」的:/fail 收到 cart_cleared=false
                          就往事件流里记一条 warning,全项目没有任何地方读它。
                          而清车是每一单的第一步 —— 它失败通常意味着 Amazon 改了
                          购物车页的结构,队列里的单会被一单一单打进「拍单异常」桶,
                          而这一行照旧是满格绿色的「在线 · 可派」。
                          插件那边也有一道熔断(连续 3 单清不动就暂停认领 10 分钟),
                          这一格是它在运营台上的那一面。 */}
                      {r.cart_fail_24h > 0
                        ? <span title="最近 24 小时里,这个买家号有这么多单试着清车但没清动。清车是每一单的第一步,多半是 Amazon 改了购物车页的结构 —— 请人工去这个买家号的购物车看一眼。">
                            <Tag tone="solid-red">清不动 {r.cart_fail_24h}</Tag>
                          </span>
                        : <span className="text-xs text-zinc-300">—</span>}
                    </td>
                    <td className="px-3 text-xs">
                      {/* 「已到日上限」这一支以前永远走不到 ——
                          服务端的 dispatchable 只看在线,不看 daily_cap,与真正
                          那道闸(task_queue.CLAIM_SQL)分叉着。现在两边算同一件事了。 */}
                      {r.dispatchable
                        ? <span className="text-emerald-700">可派</span>
                        : <span className={
                            r.login_blocks_dispatch || r.account_state === "mismatch"
                              ? "text-red-700"
                            : r.account_blocks_dispatch || r.at_daily_cap ? "text-amber-700"
                            : "text-zinc-400"}>
                            {/* 「被登出」排在「已暂停」后面、其余之前:
                                暂停是人主动停的(去问为什么停),被登出是机器坏了
                                (去那台机器上重新登录)。两句话指向不同的人,
                                所以不能合并成一句「不可派」。 */}
                            {r.liveness === "paused" ? "已暂停"
                             : r.login_blocks_dispatch ? "已登出"
                             /* 账号这一支排在「已登出」之后。它**拦两档**,措辞取
                                account_state 的标签(登错号 / 等账号报上来):
                                「登错号」要人去那台机器上换回正确的账号,是红的;
                                「等账号报上来」是刚装好还没报过号的机器,琥珀,
                                通常什么都不用做 —— 下一轮登录探测就自己好了。
                                两档合成一句话的话,人到了机器前不知道该干什么。 */
                             : r.account_blocks_dispatch
                               ? accountLabel(r.account_state).label
                             : r.at_daily_cap ? "已到日上限"
                             : r.liveness === "online" ? "在线但不可派" : "没有心跳"}
                          </span>}
                    </td>
                  </tr>
                );
              })}
              {rows === null && (
                <tr><td colSpan={HEADERS.length} className="h-20 text-center text-xs text-zinc-400">
                  {err ? "读不到买家号列表" : "读取中…"}
                </td></tr>
              )}
              {rows?.length === 0 && (
                <tr><td colSpan={HEADERS.length} className="h-20 text-center text-xs text-zinc-400">
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
