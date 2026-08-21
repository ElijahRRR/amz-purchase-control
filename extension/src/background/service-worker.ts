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
  const r = await client.heartbeat();
  if (r.ok) return;
  if (r.kind === "business" && r.code === "INSTANCE_NOT_REGISTERED") {
    // 服务端重建过库,或实例被清掉了。重新注册一次,别默默地一直心跳失败。
    log.warn("实例未注册,重新注册");
    await boot();
    return;
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
      respond({ granted: true });
    } else {
      respond({ granted: false, heldBy: leaseTabId });
    }
    return false;
  }

  return false;
});

// 拿着租约的标签页被关掉时立刻释放,不用等 TTL 到期
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === leaseTabId) { leaseTabId = null; leaseUntil = 0; }
});

void boot();
