/** 可调参数的唯一来源。任何地方出现硬编码的地址或超时数字都是违规
 *  —— 与主项目 registry/settings.py 同一条规矩。 */

import { memoryStore, type Store } from "./store.js";

export type RunMode =
  /** 只注册与心跳,不认领。**默认值** —— 骨架阶段不该自己去动真单。 */
  | "off"
  /** 认领并跑完整流程,但页面动作走模拟驱动。用来自检 HTTP 闭环,不碰 Amazon。 */
  | "simulate"
  /** 认领并在真实 Amazon 页面上执行。P3 之前 AmazonDriver 未实现,这一档会被拒绝。 */
  | "live";

/** 页面等待预算(毫秒)。**每一个数字都要能现场调**,所以它们在这里,
 *  不在 flow/amazon.ts 里编译成常量 —— 那正是 README 批评厂商
 *  「护栏写死在插件里,改一次要全员升级」的那个毛病。
 *
 *  下面这三个是给「点了下单之后」那一段用的,与其它页面等待不是一个量级:
 *  发卡行验证要人去手机上收短信、回来输验证码,现场差异极大。 */
export interface Timeouts {
  frameLoad: number;
  loginProbe: number;
  addToCart: number;
  checkoutNav: number;
  addressForm: number;
  addressSave: number;
  /** 点了下单之后,页面还读得到时等确认页的预算。语义和以前一样。 */
  orderConfirm: number;
  orderCards: number;
  /** 结算 iframe 落进不透明源(3DS 验证页)之后,留给操作员完成验证的预算。 */
  manualVerify: number;
  /** 从验证页回到「读得到但还不是确认页」之后的预算。**不重置总时钟** ——
   *  厂商 v2.5.3 在这一格是永久卡死(验证被拒、页面停在别处)。 */
  postVerify: number;
  /** 整个 placeOrder 的硬顶。三段加起来也不许超过它。 */
  orderHardCap: number;
  /** 硬顶还要给服务端的认领超时留出这么多余量:必须保证 fail/complete 发生在
   *  任务还是 claimed 的时候,否则「单真下成了、单号也读到了」会写不进库。 */
  orderServerMargin: number;
  /** 下单后那一段的轮询间隔。 */
  orderPoll: number;
}

export interface Config {
  baseUrl: string;
  /** 买家号环境名,如 env-172。没配就不许注册 —— 猜一个会把单派错账号。 */
  envCode: string | null;
  instanceUid: string;
  mode: RunMode;
  heartbeatMs: number;
  claimPollMs: number;
  /** 物流同步的轮询间隔。比认领慢得多 —— 轨迹一天更新不了几次,
   *  真正的节流在服务端(pending 会把刚同步过的挡在外面)。 */
  shipmentPollMs: number;
  requestTimeoutMs: number;
  /** 一单最多跑多久。看门狗用的**最后一道**网(background/loop.tickOnce),
   *  正常情况下永远不该被它兜到 —— 每一步自己都有上界。它防的是
   *  「runTask 因为某个想不到的原因不返回,busy 闸永不复位,这个标签页从此
   *  安静地什么都不干」。厂商的 purchaseBatchInProgress 就是这么死的。 */
  taskHardCapMs: number;
  timeouts: Timeouts;
}

export const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8781",
  mode: "off" as RunMode,
  heartbeatMs: 20_000,
  claimPollMs: 10_000,
  shipmentPollMs: 15 * 60_000,
  requestTimeoutMs: 15_000,
  // 比「所有步骤的上界加起来」再宽一点:兜底网不该在正常链路上被触发,
  // 那样它会把一单本来能成的单打断。
  taskHardCapMs: 20 * 60_000,
  timeouts: {
    frameLoad: 30_000,
    loginProbe: 20_000,
    addToCart: 30_000,
    checkoutNav: 45_000,
    addressForm: 30_000,
    addressSave: 30_000,
    orderConfirm: 60_000,
    orderCards: 20_000,
    // 6 分钟:够收一次短信验证码再输一遍。比 60 秒长一个量级,又落在
    // 服务端 15 分钟认领超时减去 3 分钟余量之内。
    manualVerify: 6 * 60_000,
    postVerify: 60_000,
    orderHardCap: 10 * 60_000,
    orderServerMargin: 3 * 60_000,
    orderPoll: 500,
  } as Timeouts,
};

const KEY = "amz.config";

function newUid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return "ext-" + crypto.randomUUID();
  }
  return "ext-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** 输入:存下来的那一份(可能残缺、可能被人手改坏)→ 输出:一张完整的超时表。
 *
 *  只接受**有限的正数**,其余一律退回默认值:一个存成 0 或 "6min" 的
 *  manualVerify 会让「等操作员完成验证」变成不等 —— 而它长得跟配好了一样。 */
function mergeTimeouts(saved: Partial<Timeouts> | undefined): Timeouts {
  const out = { ...DEFAULTS.timeouts };
  const s = saved ?? {};
  for (const k of Object.keys(DEFAULTS.timeouts) as Array<keyof Timeouts>) {
    const v = s[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

/** 输入:一个 Store → 输出:补全默认值后的配置。instance_uid 生成一次就固定下来。 */
export async function loadConfig(store: Store = memoryStore()): Promise<Config> {
  const saved = (await store.get<Partial<Config>>(KEY)) ?? {};
  const cfg: Config = {
    baseUrl: saved.baseUrl ?? DEFAULTS.baseUrl,
    envCode: saved.envCode ?? null,
    instanceUid: saved.instanceUid ?? newUid(),
    mode: saved.mode ?? DEFAULTS.mode,
    heartbeatMs: saved.heartbeatMs ?? DEFAULTS.heartbeatMs,
    claimPollMs: saved.claimPollMs ?? DEFAULTS.claimPollMs,
    shipmentPollMs: saved.shipmentPollMs ?? DEFAULTS.shipmentPollMs,
    requestTimeoutMs: saved.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    taskHardCapMs: saved.taskHardCapMs ?? DEFAULTS.taskHardCapMs,
    timeouts: mergeTimeouts(saved.timeouts),
  };
  if (saved.instanceUid !== cfg.instanceUid) await store.set(KEY, cfg);
  return cfg;
}

export async function saveConfig(store: Store, cfg: Config): Promise<void> {
  await store.set(KEY, cfg);
}
