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
  /** 替买家号切支付卡那一段的每一步预算(所有者定稿①)。
   *
   *  这一段有四个「等」:等更改支付入口出现、等支付选择页画出来、等确认按钮
   *  从 disabled 变成可用、等切完回到结算页且尾号真的变成期望的那张。
   *  四步共用一个预算,因为它们的性质一样 —— 都是「Amazon 的一次页面切换」,
   *  和填地址那两步(addressForm / addressSave)是同一个量级。
   *
   *  **不给它一个"永远等下去"的选项**:这一步发生在下单之前,等过头的代价是
   *  服务端 15 分钟后把这一单判成 CLAIM_TIMEOUT 转待人工,而这时钱一分没花、
   *  单本可以退回队列让下一台机器接着做。 */
  paymentSelect: number;
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
  /** 连着几单清不动购物车就暂停认领(background/loop 的熔断)。
   *  clearCart 是每一单的第一步,它失败通常意味着 Amazon 改了购物车页的结构 ——
   *  那种失败对每一单都成立,而认领每 10 秒来一次。 */
  cartFailStreakMax: number;
  /** 熔断之后暂停认领多久。停这一会儿不解决问题,它把「一次坏一整队」
   *  变成「一次坏几单」,剩下的留在队列里等人来看。 */
  cartBlockMs: number;
  /** 跨标签页执行租约的有效期。要比后台标签页的定时器节流周期(约 60 秒)
   *  宽一个量级 —— 短于它的话,一个被切到后台的标签页会在自己正跑着单的时候
   *  把租约丢掉,另一个标签页接管后两条 runTask 动同一个购物车。 */
  leaseTtlMs: number;
  /** 持有者说自己在跑单、却再也没来续租时,还给它多少宽限。
   *  必须有界:标签页没关但内容脚本死了的话,租约会永远停在 busy 上。 */
  leaseBusyGraceMs: number;
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
  cartFailStreakMax: 3,
  cartBlockMs: 10 * 60_000,
  // 5 分钟。放大它不会造成「持有者已死却占着」:标签页被关掉时 onRemoved 立刻释放。
  leaseTtlMs: 5 * 60_000,
  // 比一单的硬顶短是故意的:真跑着单的标签页每一轮认领都续一次,
  // 连着 10 分钟一次都没续上,它已经不在跑了。
  leaseBusyGraceMs: 10 * 60_000,
  timeouts: {
    frameLoad: 30_000,
    loginProbe: 20_000,
    addToCart: 30_000,
    checkoutNav: 45_000,
    addressForm: 30_000,
    addressSave: 30_000,
    // 30 秒:与填地址那两步同一个量级。厂商给这一段的是 30s/30s/10s/30s
    // (v2.5.3 :2246、:2270、:2281、:2299),我们四步统一 30s ——
    // 确认按钮那一格他们给了 10s,而那正是页面在算钱、最容易慢的一格。
    paymentSelect: 30_000,
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

/** 输入:存下来的一个数 + 默认值 → 输出:能用的那个。
 *
 *  与 mergeTimeouts 同一条规矩,只是给单个标量用:只收**有限的正数**,
 *  其余(0、负数、字符串、undefined)一律退回默认值。一个存成 0 的
 *  `cartFailStreakMax` 会让熔断在第一单就触发,而它长得跟配好了一模一样。 */
export function posOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
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
    taskHardCapMs: posOr(saved.taskHardCapMs, DEFAULTS.taskHardCapMs),
    cartFailStreakMax: Math.floor(posOr(saved.cartFailStreakMax, DEFAULTS.cartFailStreakMax)),
    cartBlockMs: posOr(saved.cartBlockMs, DEFAULTS.cartBlockMs),
    leaseTtlMs: posOr(saved.leaseTtlMs, DEFAULTS.leaseTtlMs),
    leaseBusyGraceMs: posOr(saved.leaseBusyGraceMs, DEFAULTS.leaseBusyGraceMs),
    timeouts: mergeTimeouts(saved.timeouts),
  };
  if (saved.instanceUid !== cfg.instanceUid) await store.set(KEY, cfg);
  return cfg;
}

export async function saveConfig(store: Store, cfg: Config): Promise<void> {
  await store.set(KEY, cfg);
}
