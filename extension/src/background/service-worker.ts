/** MV3 后台:配置、注册、心跳、执行租约。
 *
 * **这里不跑任何页面动作。** MV3 的后台是 service worker,没有 document,
 * AmazonDriver 靠同源 iframe 干活,在这里第一步就是 ReferenceError。
 * 真正要动页面的活在内容脚本里(src/content/runner.ts)。
 *
 * 不申请 cookies 权限,不读也不上传买家 Cookie —— 登录态留在浏览器 profile 里。
 * 这是架构选择:服务端因此无法脱离操作员的浏览器独立下单,这正是不想具备的能力。
 */

import { Client } from "../core/client.js";
import { loadConfig, saveConfig, type Config } from "../core/config.js";
import { Log } from "../core/log.js";
import { chromeStore } from "../core/store.chrome.js";
import type { LoginState } from "../core/types.js";

const VERSION = "0.1.0";
const ALARM_HEARTBEAT = "amz.heartbeat";

/** 执行租约的有效期。内容脚本每一轮认领前都要重新要一次,
 *  所以只要比认领轮询间隔宽裕一点就够 —— 标签页被关掉后,租约最多空转这么久。 */
const LEASE_TTL_MS = 45_000;

const store = chromeStore();
const log = new Log();

let cfg: Config | null = null;
let client: Client | null = null;
let registered = false;

/** 谁在跑单。同一浏览器里可能开着好几个 amazon.com,
 *  不发租约的话两个标签页会各领一单,在同一个买家号上并行拍两单。 */
let leaseTabId: number | null = null;
let leaseUntil = 0;

/** 内容脚本刚读到、还没送出去的登录态。
 *
 *  为什么要在这里中转:读页面必须在**内容脚本**里做(SW 没有 document),
 *  而心跳在 SW 里发。所以内容脚本读完 → 发消息给 SW → SW 挂在下一次心跳上。
 *  发不出去(网络断了)就留着,下一次心跳再带 —— 清空只在服务端确认收到之后。 */
let pendingLoginState: LoginState | null = null;

/** 同一位登录态**被服务端明确拒绝**了几次。只数 business 失败:断网、超时是
 *  「没说上话」,那种情况留着重发正是对的。 */
let pendingLoginRejects = 0;

/** 重发的上限。到了就丢掉这一位并 log.err。
 *
 *  为什么要有上限:这一位只在 `r.ok` 时才清,而它有可能是服务端**永远**不收的
 *  ——最现实的一种是封闭集漂了(HeartbeatReq 那个 Literal 少了一个值)→ 每一次
 *  心跳都 422。那样的话 last_seen_at 再也不更新(这台机器在运营台上变成「失联」),
 *  登录态也再送不上去,这道闸退化成一块永远不动的招牌。
 *  **丢一位登录态,好过让一个毒值把整条心跳通道堵死。** */
const PENDING_LOGIN_MAX_REJECTS = 3;

/** 服务端在上一次心跳里回的「该不该复检登录态」。
 *  内容脚本每轮要租约时顺手取走 —— 不另开一条广播,少一条要维护的消息。 */
let loginCheckDue = false;

async function boot(): Promise<void> {
  cfg = await loadConfig(store);
  client = new Client({ baseUrl: cfg.baseUrl, timeoutMs: cfg.requestTimeoutMs }, cfg.instanceUid);
  registered = false;

  if (!cfg.envCode) {
    log.warn("还没配买家号。面板里填 env-xxx 之后才会注册 —— 猜一个会把单派错账号");
  } else {
    const r = await client.register(cfg.envCode, VERSION);
    if (r.ok) {
      registered = true;
      log.ok(`注册成功 · instance_id=${r.data.instance_id} · ${r.data.env_status}`);
    } else {
      log.err(`注册失败:${r.kind === "business" ? r.code + " " + r.message : r.message}`);
    }
  }

  chrome.alarms.create(ALARM_HEARTBEAT,
                       { periodInMinutes: Math.max(0.5, cfg.heartbeatMs / 60000) });
  broadcastConfig();
}

async function heartbeat(): Promise<void> {
  if (!client || !cfg?.envCode) return;
  const sending = pendingLoginState;
  const r = await client.heartbeat(sending ?? undefined);
  if (r.ok) {
    // 收到了才清。清早了的话,一次网络抖动就能让「这台机器被登出了」这条消息
    // 永远丢掉 —— 而服务端会一直按上一位派单。
    // 只清送出去的那一位:发请求这段时间里内容脚本可能又报了新的。
    if (sending && pendingLoginState === sending) {
      pendingLoginState = null;
      pendingLoginRejects = 0;
    }
    loginCheckDue = !!r.data?.login_check_due;
    return;
  }
  if (r.kind === "business" && r.code === "INSTANCE_NOT_REGISTERED") {
    // 服务端重建过库,或实例被清掉了。重新注册一次,别默默地一直心跳失败。
    log.warn("实例未注册,重新注册");
    await boot();
    return;
  }
  if (sending && r.kind === "business") {
    // 服务端**明确**拒了这一条:再发一遍答案一样(api.postIdempotent 也是这么判的)。
    // 留着重发的只该是「没说上话」那一种。
    pendingLoginRejects += 1;
    if (pendingLoginRejects >= PENDING_LOGIN_MAX_REJECTS) {
      log.err(`登录态 ${sending} 连续 ${pendingLoginRejects} 次被服务端拒绝` +
              `(${r.code} ${r.message}),丢弃这一位 —— 再重发下去整条心跳通道都会被它堵死`);
      if (pendingLoginState === sending) pendingLoginState = null;
      pendingLoginRejects = 0;
    }
  }
  log.warn("心跳失败:" + (r.kind === "business" ? r.code : r.message));
}

function broadcastConfig(): void {
  chrome.tabs.query({ url: "https://www.amazon.com/*" }, (tabs) => {
    for (const t of tabs) {
      if (t.id !== undefined) {
        chrome.tabs.sendMessage(t.id, { type: "amz.config", config: cfg, registered })
          .catch(() => { /* 那个标签页没注入内容脚本,正常 */ });
      }
    }
  });
}

chrome.runtime.onInstalled.addListener(() => void boot());
chrome.runtime.onStartup.addListener(() => void boot());
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM_HEARTBEAT) void heartbeat();
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === "amz.getConfig") {
    void (async () => {
      if (!cfg) await boot();
      respond({ config: cfg, registered, log: log.all() });
    })();
    return true;
  }

  if (msg?.type === "amz.setConfig") {
    void (async () => {
      cfg = { ...(cfg ?? (await loadConfig(store))), ...msg.patch };
      await saveConfig(store, cfg!);
      log.info("配置已更新,重新注册");
      await boot();
      respond({ ok: true, config: cfg });
    })();
    return true;
  }

  if (msg?.type === "amz.acquireRunner") {
    const tabId = sender.tab?.id;
    const now = Date.now();
    if (tabId === undefined) { respond({ granted: false }); return false; }
    if (leaseTabId === null || leaseTabId === tabId || now > leaseUntil) {
      leaseTabId = tabId;
      leaseUntil = now + LEASE_TTL_MS;
      // 顺路把服务端那句「该复检登录态了」捎回去。租约本来就每轮要一次,
      // 搭在这上面比再开一条广播少一条要维护的消息路径。
      respond({ granted: true, loginCheckDue });
    } else {
      respond({ granted: false, heldBy: leaseTabId });
    }
    return false;
  }

  if (msg?.type === "amz.loginState") {
    // 内容脚本读页面读出来的那一位。SW 自己读不了 —— 它没有 document。
    // 换了一个值就重新数:上一位被拒的次数说的是上一位。
    if (msg.state !== pendingLoginState) pendingLoginRejects = 0;
    pendingLoginState = msg.state as LoginState;
    // 报上来之后这一轮的「该复检了」就算答完了,别让内容脚本再开一次页面。
    loginCheckDue = false;
    respond({ ok: true });
    return false;
  }

  return false;
});

// 拿着租约的标签页被关掉时立刻释放,不用等 TTL 到期
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === leaseTabId) { leaseTabId = null; leaseUntil = 0; }
});

void boot();
