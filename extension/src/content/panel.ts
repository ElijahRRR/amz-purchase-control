/** 注入在 Amazon 页面右侧的操作面板。
 *
 * 挂在 shadow root 里:Amazon 的样式进不来,我们的样式也出不去。
 * 厂商那套用 layer.js 往页面里塞 iframe 覆盖层,样式和页面互相污染。
 */

import type { LogLine } from "../core/log.js";
import { PHASE_LABEL, type Phase } from "../core/status.js";
import type { Config } from "../core/config.js";
import type { Task } from "../core/types.js";
import type { ConfirmPreview } from "../flow/run.js";
import { wireCopy } from "./copy.js";
import { Runner } from "./runner.js";
import { PANEL_CSS } from "./styles.js";

interface State {
  phase: Phase;
  task: Task | null;
  log: LogLine[];
  config: Config | null;
  /** 本标签页是不是那个在跑单的。同一浏览器开着好几个 amazon.com 时,
   *  只有拿到租约的那个会认领 —— 不显示的话,人会以为另一个标签页坏了。 */
  hasLease: boolean;
  /** 正在等操作员做发卡行验证时,这一段的到期时刻(epoch 毫秒)。 */
  verifyDeadlineMs: number | null;
  /** 停在下单前等人按时,这一屏要摆出来的东西。null = 没在等。 */
  confirm: ConfirmPreview | null;
  /** 等人确认那一格的到期时刻(epoch 毫秒)。 */
  confirmDeadlineMs: number | null;
}

const PHASE_TAG: Record<Phase, [string, string]> = {
  off:     ["tag tagdash", "background:#fff;color:#52525b;border-color:#d4d4d8"],
  idle:    ["tag tagdash", "background:#fff;color:#52525b;border-color:#d4d4d8"],
  // 红的:这台机器此刻问不到单,而且多半要人去看服务端。灰色的「待命」
  // 会让人以为一切正常 —— 而队列里可能正堆着单。
  "no-server": ["tag", "background:#fef2f2;color:#b91c1c;border-color:#fecaca"],
  claimed: ["tag tagdash", "background:#fff;color:#b45309;border-color:#fde68a"],
  running: ["tag tagdash", "background:#fff;color:#b45309;border-color:#fde68a"],
  // 琥珀**实心**,和 verify 一档:这一格是「轮到你了」,不是「机器在跑,你不用管」。
  // 与上面几个虚线琥珀(已认领 / 执行中)分开 —— 虚线在这块面板上的意思一直是
  // 「你不用动」,而这一格恰恰是不按就什么也不会发生。
  confirm: ["tag", "background:#fffbeb;color:#b45309;border-color:#fde68a"],
  // 琥珀**实心**:与 blocked 的紫色分开 —— 紫色是「已经定了要人工处理」,
  // 这一格是「此刻正在等你动手,还来得及」。也与上面几个虚线琥珀分开:
  // 虚线是「机器在跑,你不用管」。
  verify:  ["tag", "background:#fffbeb;color:#b45309;border-color:#fde68a"],
  blocked: ["tag", "background:#f5f3ff;color:#6d28d9;border-color:#ddd6fe"],
  // 红色:这台机器**真的坏了**,不重新登录一单也跑不了。
  // 与「待命」的灰色分开,是为了让人一眼看出该动手的是他自己。
  "signed-out": ["tag", "background:#fef2f2;color:#b91c1c;border-color:#fecaca"],
  // 红色,与「已登出」一档:两者都要人去**这台机器上**动手,只是动的东西不同
  // (一个重新登录,一个换回正确的账号)。
  "account-mismatch": ["tag", "background:#fef2f2;color:#b91c1c;border-color:#fecaca"],
  // 琥珀,**不是红的**:这一格通常什么都不用做 —— 下一轮登录探测把账号报上去
  // 就自动开闸。染成红的会让人跑去那台机器上瞎换账号,而它本来就是对的。
  // 与运营台买家号页「可派单」那一列的配色同源(那边也是红 / 琥珀两档)。
  "account-unverified": ["tag", "background:#fffbeb;color:#b45309;border-color:#fde68a"],
  // 同样是红的:这台机器此刻拍不了单,而且要人去动手。
  "cart-blocked": ["tag", "background:#fef2f2;color:#b91c1c;border-color:#fecaca"],
  // 上一单被强行掐掉、还没落地:这期间不认领。也是红的 —— 它同样是
  //「有单也不领」,不是「没单可跑」,而后者的灰色会让人以为一切正常。
  stuck: ["tag", "background:#fef2f2;color:#b91c1c;border-color:#fecaca"],
  done:    ["tag", "background:#ecfdf5;color:#047857;border-color:#a7f3d0"],
};

const STEPS = [
  "清空购物车",
  "商品页 · 校验 FBA 与库存",
  "加购并回读购物车",
  "读结算页实付与交期",
  // 闸比的是**货款**(实付 + 礼品卡抵扣),不是这张卡要扣的钱。写「实付」的话,
  // 礼品卡全额抵扣的单实付 0.00 ≤ 限价却被 PRICE_CAP_EXCEEDED 拦下,
  // 照面板学规则的操作员会认为护栏抽了风。
  // 与 services/price_guard、error_codes.LABELS["PRICE_CAP_EXCEEDED"]、
  // run.ts 那条放行日志同一句话。
  "护栏 · 货款 ≤ 限价",
  "下单 · 确认页",
  "回填单号 · ASIN 断言",
];

let state: State = { phase: "off", task: null, log: [], config: null, hasLease: false,
                     verifyDeadlineMs: null, confirm: null, confirmDeadlineMs: null };
const runner = new Runner();
let root: ShadowRoot;
let mount: HTMLElement;
let toast: HTMLElement;
/** 「轮到人了」那两格的倒计时(等发卡行验证 / 等人确认下单)。**只在那两格跑**
 *  —— 平时每秒重绘一次面板没有意义,而离开之后还在走的秒表配着一句「剩余 3:12」,
 *  正是这个项目反复记的那种「看起来在盯、其实是假的」。 */
let countdownTimer: ReturnType<typeof setInterval> | undefined;

/** 输入:剩余毫秒 → 输出:M:SS。到点了写 0:00,不写负数。 */
function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** 可复制的等宽值。加上 .copy 就有点击复制的行为。 */
function id(v: string | undefined | null): string {
  const t = v ?? "—";
  return t === "—"
    ? '<span class="id">—</span>'
    : `<span class="id copy" data-copy="${esc(t)}">${esc(t)}</span>`;
}

/** 输入:相位 + 手上这一单 → 输出:状态条右边那句副文本。
 *
 *  **不许写死成 `task ? "task_id N" : "队列里没有本买家号的单"`。**
 *  那样的话「没说上话」「已登出」「清车熔断」「上一单未收尾」四种情况
 *  全配着同一句话,而那句话在这四种情况下**都是假的** —— 队列里可能正堆着单。
 *  loop.ts 的注释自己写着「『没说上话』绝不能当成『没有单』」:
 *  日志那一层守住了,这一层曾经没有。 */
function bandNote(phase: Phase, task: Task | null): string {
  if (task) return "task_id " + task.task_id;
  switch (phase) {
    case "off": return "未开工:只注册与心跳,不认领";
    case "idle": return "队列里没有本买家号的单";
    case "no-server": return "和服务端没说上话 —— 这不等于「没有单」";
    case "signed-out": return "这个浏览器被登出了,认领已暂停";
    // 「服务端拒了」与「没问到服务端」是两句话 —— 后者会让人去查网络。
    case "account-mismatch": return "登的不是这个买家号 —— 服务端拒绝派单";
    case "account-unverified": return "账号还没报上来 —— 服务端暂时不派单";
    case "cart-blocked": return "连着几单清不动购物车,认领已暂停";
    case "stuck": return "上一单还没收尾,这期间不认领";
    default: return "";
  }
}

function render(): void {
  const { phase, task, config } = state;
  const [tagCls, tagStyle] = PHASE_TAG[phase];
  // verify 与 confirm 一样落在「下单 · 确认页」那一步:点已经点下去了,
  // 正卡在确认页之前。原先整个 placeOrder 期间步骤条停在第 4 步「读结算页」,
  // 而屏幕上(其实在屏幕外)有一个验证页在等人 —— 面板从头到尾没提过这件事。
  const stepIdx = phase === "running" ? 3
                : phase === "confirm" || phase === "verify" ? 5
                : phase === "done" ? 7 : 0;
  const leftMs = state.verifyDeadlineMs === null ? null : state.verifyDeadlineMs - Date.now();
  const confirmLeftMs = state.confirmDeadlineMs === null
    ? null : state.confirmDeadlineMs - Date.now();

  const modeBtn = (m: string, label: string) =>
    `<button data-mode="${m}" class="${config?.mode === m ? "on" : ""}">${label}</button>`;

  mount.innerHTML = `
  <div class="wrap">
    <div class="hd">
      <span class="brand">→</span>
      <span style="font-weight:600">AMZ 采购助手</span>
      <span style="margin-left:auto;display:inline-flex;align-items:center;gap:5px">
        <span class="dot" style="background:${config?.envCode ? "#10b981" : "#a1a1aa"}"></span>
        <span class="id" style="font-size:11px;color:#71717a">${esc(config?.envCode ?? "未配置买家号")}</span>
      </span>
    </div>

    <div class="band">
      <span class="${tagCls}" style="${tagStyle}">${PHASE_LABEL[phase]}</span>
      <span style="font-size:12px;color:#71717a">${esc(bandNote(phase, task))}</span>
    </div>

    ${config?.mode === "simulate" ? `<div class="warnbar">模拟档:页面动作全是假的,只用来自检和服务端说话的时序。不会在 Amazon 上产生任何订单。</div>` : ""}
    ${config?.mode === "live" && !state.hasLease ? `<div class="warnbar">另一个 Amazon 标签页正在跑单,本页只看不动。关掉那个标签页,租约会自动转到这里。</div>` : ""}
    ${config?.mode === "live" && state.hasLease ? `<div class="warnbar">真实档:会在这个买家号上下真单。页面动作从未在真实 Amazon 上验证过,第一次请拿可弃的号试。</div>` : ""}
    ${phase === "stuck" ? `<div class="warnbar" style="background:#fef2f2;color:#b91c1c;border-color:#fecaca">
      上一单跑过了硬顶,已经强制关掉页面,正在等它收尾。收尾之前不认领新单 ——
      两条流程会动同一个购物车。
    </div>` : ""}
    ${phase === "signed-out" ? `<div class="warnbar" style="background:#fef2f2;color:#b91c1c;border-color:#fecaca">
      这个浏览器上的买家号已被登出,认领已暂停。请在<b>本浏览器</b>里重新登录 Amazon ——
      插件复检到之后会自己继续,不用重启插件。在那之前队列里属于这个买家号的单没人拍。
    </div>` : ""}
    ${phase === "account-mismatch" ? `<div class="warnbar" style="background:#fef2f2;color:#b91c1c;border-color:#fecaca">
      <b>这个浏览器里登的不是这个买家号。</b>服务端认得出来,所以它<b>不会</b>把单派给这台机器
      —— 派了就是拿另一个账号去买。<b>这不是「连不上服务端」</b>:服务端好好的,
      拒绝的理由写在下面的日志里(那句话里有两个账号 ID)。
      请在<b>本浏览器</b>里换回这个买家号该登的 Amazon 账号;
      确实是库里记错了的话,去运营台买家号页按「以这个为准」。
    </div>` : ""}
    ${phase === "account-unverified" ? `<div class="warnbar" style="background:#fffbeb;color:#92400e;border-color:#fde68a">
      <b>服务端还不知道这台机器登着谁</b>,所以暂时不派单 —— 新装 / 新 profile / 换过机器
      的那一刻最容易登错号,这道闸就是拦那一刻的。<b>通常什么都不用做</b>:
      下一轮登录探测会把买家号 ID 读上来报过去,对得上就自动恢复。
      一直不恢复只有两种可能:登的真不是这个号,或者页面上没抠到账号 ID —— 那时要人去看一眼。
    </div>` : ""}
    ${phase === "no-server" ? `<div class="warnbar" style="background:#fef2f2;color:#b91c1c;border-color:#fecaca">
      认领时没跟服务端说上话(超时/断网/响应不是 JSON)。<b>这不等于「没有单」</b> ——
      队列里可能正堆着单。请看下面的日志,并确认服务端还活着、地址配对了。
    </div>` : ""}
    ${phase === "cart-blocked" ? `<div class="warnbar" style="background:#fef2f2;color:#b91c1c;border-color:#fecaca">
      连着几单清不动购物车,已暂停认领一段时间 —— 多半是 Amazon 改了购物车页的结构。
      请打开这个买家号的购物车看一眼(手动清空一次也好),日志里有每一次的失败原因。
    </div>` : ""}
    ${phase === "confirm" ? `<div class="warnbar" style="background:#fffbeb;color:#92400e;border-color:#fde68a">
      <b>等你确认${confirmLeftMs === null ? "" : ` · 剩余 ${mmss(confirmLeftMs)}`}:</b>
      这一单已经过了护栏,<b>还没点下单,一分钱没花</b>。下面那一屏看清楚再按。${
        // 到点会发生什么必须写出来,而且必须与代码里真正发生的事一致:
        // run.ts 那条路是「清车 + 退回队列」,不是「自动下单」也不是「转待人工」。
        // 这句话写错的代价是有人为了赶时间故意让它超时。
        confirmLeftMs === null ? "" :
        "到点<b>不会自动下单</b> —— 这一单会清车退回队列,谁都没花钱,过一会儿还会被再领一次。"}
    </div>` : ""}
    ${phase === "verify" ? `<div class="warnbar" style="background:#fffbeb;color:#92400e;border-color:#fde68a">
      <b>轮到你了:</b>Amazon 把这一单转到了发卡行验证页,窗口已经弹在本页中间 ——
      请在里面完成验证,不要关闭或刷新本页。${
        // 倒计时来自驱动给出的 deadline,不是面板自己拍的数 ——
        // 面板另算一个的话,它迟早与真正到期的那一刻对不上,
        // 而这句话承诺的正是「到点会发生什么」。
        leftMs === null ? "" :
        `剩余 <b>${mmss(leftMs)}</b>,超时后这一单转为待人工(订单可能已经提交,届时要去买家号里查一遍)。`}
    </div>` : ""}

    <div class="body">
      ${state.confirm ? confirmCard(state.confirm, config?.envCode ?? null, confirmLeftMs) : ""}
      ${task ? taskCard(task) : ""}
      <div class="sec">执行步骤</div>
      <div class="steps">
        ${STEPS.map((s0, i) => {
          // 第 5 步在 confirm 相位上要换一句话:「下单 · 确认页」说的是
          // **已经点了、在等 Amazon 的确认页**,而此刻一下都还没点、一分钱没花。
          // 同一格写同一句话的话,步骤条会把「等你决定」渲染成「钱已经花了」。
          const s = i === 5 && phase === "confirm" ? "等你确认 · 还没点下单" : s0;
          const cls = i < stepIdx ? "done" : i === stepIdx && phase !== "off" && phase !== "idle" ? "cur" : "";
          const dot = i < stepIdx
            ? '<span class="dot" style="background:#10b981"></span>'
            : cls === "cur"
              ? '<span class="dothollow"></span>'
              : '<span class="dot" style="background:#e4e4e7"></span>';
          return `<div class="stp ${cls}">${dot}${esc(s)}</div>`;
        }).join("")}
      </div>
      <div class="sec">日志</div>
      <div class="log">${state.log.slice(-40).map((l) =>
        `<div><span class="dim">${esc(l.at)}</span> <span class="${l.level}">${esc(l.text)}</span></div>`).join("")}</div>
    </div>

    <div class="ft">
      <span class="seg">${modeBtn("off", "停")}${modeBtn("simulate", "模拟")}${modeBtn("live", "真实")}</span>
      ${/* 下单前确认。**默认关**(所有者定稿),照三档模式同一套存取方式:
            改的是 chrome.storage 里那份配置,由 SW 广播回来 —— 面板不留副本。 */""}
      <span class="seg"><button id="confirmsw" class="${config?.confirmBeforeOrder ? "on" : ""}"
        title="开着的话每一单在下单前都停下来等人按;没人按就到点退回队列">下单前确认</button></span>
      <input id="env" placeholder="env-172" value="${esc(config?.envCode ?? "")}">
      <button class="btn bs" id="save">保存</button>
      <span style="margin-left:auto"></span>
      <button class="btn bp" id="tick">拉一单</button>
    </div>
  </div>
  <div class="toast" id="toast"></div>`;

  toast = root.getElementById("toast") as HTMLElement;
  wire();
}

/** 下单前那一屏。**这一屏的存在意义是让人能独立回答「该不该现在买」** ——
 *  所以摆的是上游单号、商品与数量、服务端真正比过的货款与限价、礼品卡抵扣、
 *  交期原文、买家号。少一样它就退化成一个写着「确定?」的按钮,而那种按钮
 *  只会训练人闭着眼睛点。
 *
 *  **两个按钮的分量不一样**:「下单」是红实心(会花真钱,不可撤销),
 *  「取消」是次要按钮。红色一旦廉价,它就不再是刹车 —— 这块面板上再没有
 *  第二个红按钮(design/DesignSystem.dc.html 那条)。 */
function confirmCard(c: ConfirmPreview, envCode: string | null, leftMs: number | null): string {
  const items = c.products.map((p) => `${id(p.asin)} × ${esc(p.quantity)}`).join("  ");
  // 服务端回了货款就写「货款」,没回就写「实付」并说明。两者在礼品卡全额抵扣的
  // 单子上差得很远(实付 0.00 / 货款 2241.86),写错一个字这一屏就在骗人。
  const money = c.goodsTotal === null
    ? `<span class="kvv">实付 ${id(c.actualTotal)} <span style="color:#a1a1aa">服务端没回货款,这里是结算页实付</span></span>`
    : `<span class="kvv">货款 ${id(c.goodsTotal)} <span style="color:#a1a1aa">≤ 限价 ${esc(c.priceCap)}</span></span>`;
  const gift = c.giftCard === null
    ? "结算页上没有抵扣行"
    : !c.giftCard.applied
      ? "有抵扣行,但这一单没用上"
      : c.giftCard.amount === null
        ? "有抵扣,但金额没读出来"
        : `抵扣 ${esc(c.giftCard.amount)}`;
  return `
    <div class="sec">下单前确认 · 会花真钱</div>
    <div style="margin:2px 14px 0;border:1px solid #fecaca;background:#fef2f2;border-radius:6px;padding:11px 12px;display:flex;flex-direction:column;gap:6px">
      <div class="kv" style="padding:0"><span class="kvk">上游单号</span><span class="kvv">${
        // 收不到与「真的是空的」不许长成一个样子:老服务端的认领响应里没有这一项。
        c.upstreamOrderNo ? id(c.upstreamOrderNo) : '<span style="color:#a1a1aa">服务端未下发</span>'
      }</span></div>
      <div class="kv" style="padding:0"><span class="kvk">买家号</span><span class="kvv">${
        envCode ? id(envCode) : '<span style="color:#a1a1aa">未配置</span>'}</span></div>
      <div class="kv" style="padding:0"><span class="kvk">商品</span><span class="kvv">${items}</span></div>
      <div class="kv" style="padding:0"><span class="kvk">金额</span>${money}</div>
      <div class="kv" style="padding:0"><span class="kvk">礼品卡</span><span class="kvv">${esc(gift)}</span></div>
      <div class="kv" style="padding:0"><span class="kvk">交期</span><span class="kvv">${
        // 原文照抄,面板不解析交期(服务端解析的那一条已经比过 max_delivery_days)。
        c.deliveryRaw ? esc(c.deliveryRaw) : '<span style="color:#a1a1aa">服务端没采信任何一条</span>'}</span></div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:3px">
        <button class="btn bdanger" id="cfyes">下单</button>
        <button class="btn bs" id="cfno">取消</button>
        <span style="margin-left:auto;font-size:11px;color:#b45309">${
          // 这句话必须与代码里真正发生的事一致(run.ts:超时 → 清车 + 退回队列)。
          leftMs === null ? "" : `剩余 ${mmss(leftMs)} · 到点退回队列`}</span>
      </div>
    </div>`;
}

function taskCard(t: Task): string {
  const s = t.shipping;
  return `
    <div class="sec">上游下发 · 只读</div>
    <div class="kv"><span class="kvk">ASIN</span><span class="kvv">${t.products.map((p) => id(p.asin) + ` × ${p.quantity}`).join("  ")}</span></div>
    <div class="kv"><span class="kvk">限价</span><span class="kvv">${id(t.guards.price_cap)} <span style="color:#a1a1aa">上游算好下发</span></span></div>
    <div class="kv"><span class="kvk">收货人</span><span class="kvv">${esc(s.name)} · ${id(s.phone)}</span></div>
    <div class="kv"><span class="kvk">地址</span><span class="kvv copy" data-copy="${esc(`${s.name}, ${s.line1}, ${s.city}, ${s.state} ${s.postcode}, ${s.country}`)}">${esc(s.line1)}, ${esc(s.city)}, ${esc(s.state)} ${esc(s.postcode)}</span></div>`;
}

function wire(): void {
  root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "amz.setConfig", patch: { mode: b.dataset.mode } });
    }));
  root.getElementById("save")?.addEventListener("click", () => {
    const v = (root.getElementById("env") as HTMLInputElement).value.trim();
    chrome.runtime.sendMessage({ type: "amz.setConfig", patch: { envCode: v || null } });
  });
  root.getElementById("tick")?.addEventListener("click", () => {
    void runner.tick();
  });
  // 与三档模式同一套存取方式:改的是配置,由 SW 存进 chrome.storage 再广播回来。
  // 面板不留副本 —— 留一份的话,广播丢一次这个开关就和真正生效的那一位对不上了。
  root.getElementById("confirmsw")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type: "amz.setConfig",
      patch: { confirmBeforeOrder: !state.config?.confirmBeforeOrder },
    });
  });
  // 那两个按钮只把人的那一下传给执行器。**到点不由这里说了算** ——
  // 上界在 flow/run.ts,一个渲染卡住的面板不该等于「没有上界」。
  root.getElementById("cfyes")?.addEventListener("click", () => runner.answerConfirm(true));
  root.getElementById("cfno")?.addEventListener("click", () => runner.answerConfirm(false));
}

function boot(): void {
  const host = document.createElement("div");
  host.id = "amz-purchase-panel";
  document.documentElement.appendChild(host);
  root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  root.appendChild(style);
  mount = document.createElement("div");
  root.appendChild(mount);

  render();
  wireCopy(root, toast);

  // 执行器就在这个内容脚本里(MV3 的后台没有 document,跑不了页面动作),
  // 所以状态是本地的,不用跟后台来回要。
  runner.onChange((rs) => {
    state = { ...state, phase: rs.phase, task: rs.task, hasLease: rs.hasLease,
              verifyDeadlineMs: rs.verifyDeadlineMs,
              confirm: rs.confirm, confirmDeadlineMs: rs.confirmDeadlineMs };
    // 倒计时只在「轮到人了」那两格跑。**离开必须把定时器收掉** ——
    // 一个还在走的秒表配着一句「剩余 3:12」,而其实没有任何东西在等,
    // 正是这个项目反复记的那种「看起来在盯、其实是假的」。
    if (countdownTimer !== undefined) { clearInterval(countdownTimer); countdownTimer = undefined; }
    const ticking = (rs.phase === "verify" && rs.verifyDeadlineMs !== null) ||
                    (rs.phase === "confirm" && rs.confirmDeadlineMs !== null);
    if (ticking) countdownTimer = setInterval(render, 1000);
    render();
  });
  runner.log.onChange((lines) => {
    state = { ...state, log: [...lines] };
    render();
  });

  // 配置仍然由后台持有(它要拿去注册和心跳),变了会广播过来
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "amz.config" && msg.config) {
      state = { ...state, config: msg.config };
      runner.setConfig(msg.config);
      runner.start();
      render();
    }
  });

  chrome.runtime.sendMessage({ type: "amz.getConfig" }, (got) => {
    if (!got?.config) return;
    state = { ...state, config: got.config, log: got.log ?? [] };
    runner.setConfig(got.config);
    runner.start();
    render();
  });
}

// 只在顶层文档注入。厂商那套 all_frames:true 会把脚本灌进订单页自己的每一个子框架
// (深度分析:16 处跨框架操作全是父页面侧发起的,子框架里那份纯属污染)。
if (window.top === window.self) boot();
