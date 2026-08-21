/** MV3 后台:注册、心跳、认领循环。
 *
 * 不申请 cookies 权限,不读也不上传买家 Cookie —— 登录态留在浏览器 profile 里。
 * 这是架构选择:服务端因此无法脱离操作员的浏览器独立下单,这正是不想具备的能力。
 */

import { Client } from "../core/client.js";
import { loadConfig, saveConfig, type Config } from "../core/config.js";
import { Log } from "../core/log.js";
import { chromeStore } from "../core/store.chrome.js";
import type { Phase } from "../core/status.js";
import type { Task } from "../core/types.js";
import { AmazonDriver, AmazonShipmentReader } from "../flow/amazon.js";
import { SimulatedDriver, SimulatedShipmentReader } from "../flow/simulated.js";
import type { PageDriver } from "../flow/driver.js";
import type { ShipmentReader } from "../flow/shipment.js";
import { Loop } from "./loop.js";

const VERSION = "0.1.0";
const ALARM_HEARTBEAT = "amz.heartbeat";
const ALARM_CLAIM = "amz.claim";
const ALARM_SHIPMENT = "amz.shipment";

const store = chromeStore();
const log = new Log();

let cfg: Config | null = null;
let client: Client | null = null;
let loop: Loop | null = null;
let phase: Phase = "off";
let currentTask: Task | null = null;

function driverFor(c: Config): PageDriver {
  return c.mode === "simulate" ? new SimulatedDriver("happy") : new AmazonDriver();
}

function shipmentReaderFor(c: Config): ShipmentReader {
  return c.mode === "simulate" ? new SimulatedShipmentReader("in_transit") : new AmazonShipmentReader();
}

async function boot(): Promise<void> {
  cfg = await loadConfig(store);
  client = new Client(
    { baseUrl: cfg.baseUrl, timeoutMs: cfg.requestTimeoutMs },
    cfg.instanceUid,
  );
  loop = new Loop({
    client,
    log,
    config: () => cfg!,
    driver: () => driverFor(cfg!),
    shipmentReader: () => shipmentReaderFor(cfg!),
    onPhase: (p, t) => {
      phase = p;
      currentTask = t;
      broadcast();
    },
  });

  if (!cfg.envCode) {
    log.warn("还没配买家号。面板里填 env-xxx 之后才会注册 —— 猜一个会把单派错账号");
  } else {
    const r = await client.register(cfg.envCode, VERSION);
    if (r.ok) log.ok(`注册成功 · instance_id=${r.data.instance_id} · ${r.data.env_status}`);
    else log.err(`注册失败:${r.kind === "business" ? r.code + " " + r.message : r.message}`);
  }

  chrome.alarms.create(ALARM_HEARTBEAT, { periodInMinutes: Math.max(0.5, cfg.heartbeatMs / 60000) });
  chrome.alarms.create(ALARM_CLAIM, { periodInMinutes: Math.max(0.5, cfg.claimPollMs / 60000) });
  chrome.alarms.create(ALARM_SHIPMENT, { periodInMinutes: Math.max(1, cfg.shipmentPollMs / 60000) });
  broadcast();
}

async function heartbeat(): Promise<void> {
  if (!client || !cfg?.envCode) return;
  const r = await client.heartbeat();
  if (!r.ok) log.warn("心跳失败:" + (r.kind === "business" ? r.code : r.message));
}

function broadcast(): void {
  chrome.runtime
    .sendMessage({
      type: "amz.state",
      phase,
      task: currentTask,
      log: log.all(),
      config: cfg && { ...cfg },
    })
    .catch(() => {
      /* 面板没开着就没人收,正常 */
    });
}

chrome.runtime.onInstalled.addListener(() => void boot());
chrome.runtime.onStartup.addListener(() => void boot());

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM_HEARTBEAT) void heartbeat();
  if (a.name === ALARM_CLAIM) void loop?.tickOnce();
  if (a.name === ALARM_SHIPMENT) void loop?.tickShipments();
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "amz.getState") {
    respond({ phase, task: currentTask, log: log.all(), config: cfg });
    return false;
  }
  if (msg?.type === "amz.setConfig") {
    void (async () => {
      cfg = { ...(cfg ?? (await loadConfig(store))), ...msg.patch };
      await saveConfig(store, cfg!);
      log.info("配置已更新,重新注册");
      await boot();
      respond({ ok: true });
    })();
    return true;
  }
  if (msg?.type === "amz.syncShipments") {
    void loop?.tickShipments().then((r) => respond(r));
    return true;
  }
  if (msg?.type === "amz.tick") {
    void loop?.tickOnce().then((r) => respond(r));
    return true;
  }
  return false;
});

void boot();
