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
}

export const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8781",
  mode: "off" as RunMode,
  heartbeatMs: 20_000,
  claimPollMs: 10_000,
  shipmentPollMs: 15 * 60_000,
  requestTimeoutMs: 15_000,
};

const KEY = "amz.config";

function newUid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return "ext-" + crypto.randomUUID();
  }
  return "ext-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
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
  };
  if (saved.instanceUid !== cfg.instanceUid) await store.set(KEY, cfg);
  return cfg;
}

export async function saveConfig(store: Store, cfg: Config): Promise<void> {
  await store.set(KEY, cfg);
}
