/** 注入在 Amazon 页面右侧的操作面板。
 *
 * 挂在 shadow root 里:Amazon 的样式进不来,我们的样式也出不去。
 * 厂商那套用 layer.js 往页面里塞 iframe 覆盖层,样式和页面互相污染。
 */

import type { LogLine } from "../core/log.js";
import { PHASE_LABEL, type Phase } from "../core/status.js";
import type { Config } from "../core/config.js";
import type { Task } from "../core/types.js";
import { wireCopy } from "./copy.js";
import { PANEL_CSS } from "./styles.js";

interface State {
  phase: Phase;
  task: Task | null;
  log: LogLine[];
  config: Config | null;
}

const PHASE_TAG: Record<Phase, [string, string]> = {
  off:     ["tag tagdash", "background:#fff;color:#52525b;border-color:#d4d4d8"],
  idle:    ["tag tagdash", "background:#fff;color:#52525b;border-color:#d4d4d8"],
  claimed: ["tag tagdash", "background:#fff;color:#b45309;border-color:#fde68a"],
  running: ["tag tagdash", "background:#fff;color:#b45309;border-color:#fde68a"],
  confirm: ["tag tagdash", "background:#fff;color:#b45309;border-color:#fde68a"],
  blocked: ["tag", "background:#f5f3ff;color:#6d28d9;border-color:#ddd6fe"],
  done:    ["tag", "background:#ecfdf5;color:#047857;border-color:#a7f3d0"],
};

const STEPS = [
  "清空购物车",
  "商品页 · 校验 FBA 与库存",
  "加购并回读购物车",
  "读结算页实付与交期",
  "护栏 · 实付 ≤ 限价",
  "下单 · 确认页",
  "回填单号 · ASIN 断言",
];

let state: State = { phase: "off", task: null, log: [], config: null };
let root: ShadowRoot;
let mount: HTMLElement;
let toast: HTMLElement;

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

function render(): void {
  const { phase, task, config } = state;
  const [tagCls, tagStyle] = PHASE_TAG[phase];
  const stepIdx = phase === "running" ? 3 : phase === "confirm" ? 5 : phase === "done" ? 7 : 0;

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
      <span style="font-size:12px;color:#71717a">${task ? "task_id " + task.task_id : "队列里没有本买家号的单"}</span>
    </div>

    ${config?.mode === "simulate" ? `<div class="warnbar">模拟档:页面动作全是假的,只用来自检和服务端说话的时序。不会在 Amazon 上产生任何订单。</div>` : ""}
    ${config?.mode === "live" ? `<div class="warnbar">真实档:页面动作(P3)还没实现,因此不会认领任何任务。</div>` : ""}

    <div class="body">
      ${task ? taskCard(task) : ""}
      <div class="sec">执行步骤</div>
      <div class="steps">
        ${STEPS.map((s, i) => {
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
    chrome.runtime.sendMessage({ type: "amz.tick" });
  });
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

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "amz.state") {
      state = { phase: msg.phase, task: msg.task, log: msg.log ?? [], config: msg.config };
      render();
    }
  });
  chrome.runtime.sendMessage({ type: "amz.getState" }, (s) => {
    if (s) {
      state = { phase: s.phase, task: s.task, log: s.log ?? [], config: s.config };
      render();
    }
  });
}

// 只在顶层文档注入。厂商那套 all_frames:true 会把脚本灌进订单页自己的每一个子框架
// (深度分析:16 处跨框架操作全是父页面侧发起的,子框架里那份纯属污染)。
if (window.top === window.self) boot();
