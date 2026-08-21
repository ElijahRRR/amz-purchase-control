/** 执行器:认领与物流同步都在**内容脚本**里跑。
 *
 * 为什么不在 service worker 里跑:MV3 的后台是 service worker,**没有 document**。
 * 而 AmazonDriver 靠同源 iframe 操作页面(`document.createElement("iframe")`),
 * 在 SW 里第一步就是 ReferenceError。SW 只能做三件事:存配置、注册、心跳。
 * 真正要动页面的活必须在一个打开着的 Amazon 标签页里干。
 *
 * 代价与厂商那套一样:整个流程绑死在「操作员得开着一个 Amazon 页面」上。
 * 这是同源 iframe 方案换来的,不是疏漏。
 *
 * 多标签页:同一浏览器里可能开着好几个 amazon.com。执行器向 SW 要一张**租约**,
 * 只有拿到租约的那个标签页会认领 —— 否则两个标签页会各领一单,
 * 在同一个买家号上并行拍两单。
 */

import { Client } from "../core/client.js";
import type { Config } from "../core/config.js";
import { Log } from "../core/log.js";
import type { Phase } from "../core/status.js";
import type { Task } from "../core/types.js";
import { Loop } from "../background/loop.js";
import { AmazonDriver, AmazonShipmentReader } from "../flow/amazon.js";
import { SimulatedDriver, SimulatedShipmentReader } from "../flow/simulated.js";
import type { PageDriver } from "../flow/driver.js";
import type { ShipmentReader } from "../flow/shipment.js";

export interface RunnerState {
  phase: Phase;
  task: Task | null;
  hasLease: boolean;
}

export class Runner {
  readonly log = new Log();

  private cfg: Config | null = null;
  private client: Client | null = null;
  private loop: Loop | null = null;
  private hasLease = false;
  private phase: Phase = "off";
  private task: Task | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private listeners = new Set<(s: RunnerState) => void>();

  onChange(fn: (s: RunnerState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  state(): RunnerState {
    return { phase: this.phase, task: this.task, hasLease: this.hasLease };
  }

  private emit() {
    const s = this.state();
    for (const fn of this.listeners) fn(s);
  }

  /** 配置变了就地更新,**不重建 Loop** ——
   *  重建会把 busy 闸一起清零,正在跑的那一单还没结束,下一轮就又领一单进来。 */
  setConfig(cfg: Config): void {
    const first = this.cfg === null;
    const baseChanged = !first && (cfg.baseUrl !== this.cfg!.baseUrl ||
                                   cfg.instanceUid !== this.cfg!.instanceUid);
    this.cfg = cfg;
    if (first || baseChanged) {
      this.client = new Client({ baseUrl: cfg.baseUrl, timeoutMs: cfg.requestTimeoutMs },
                               cfg.instanceUid);
      this.loop = null;   // 换了服务端地址或身份,旧 Loop 拿的是旧 client
    }
    if (!this.loop && this.client) {
      this.loop = new Loop({
        client: this.client,
        log: this.log,
        config: () => this.cfg!,
        driver: () => this.driver(),
        shipmentReader: () => this.shipmentReader(),
        onPhase: (p, t) => { this.phase = p; this.task = t; this.emit(); },
      });
    }
    this.emit();
  }

  private driver(): PageDriver {
    return this.cfg?.mode === "simulate" ? new SimulatedDriver("happy") : new AmazonDriver();
  }

  private shipmentReader(): ShipmentReader {
    return this.cfg?.mode === "simulate"
      ? new SimulatedShipmentReader("in_transit")
      : new AmazonShipmentReader();
  }

  /** 起定时器。租约每轮现要 —— 拿不到就这一轮不干活,不报错。 */
  start(): void {
    this.stop();
    const claimMs = this.cfg?.claimPollMs ?? 10_000;
    const shipMs = this.cfg?.shipmentPollMs ?? 900_000;
    this.timers.push(setInterval(() => void this.tick(), claimMs));
    this.timers.push(setInterval(() => void this.tickShipments(), shipMs));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private async lease(): Promise<boolean> {
    try {
      const got = await chrome.runtime.sendMessage({ type: "amz.acquireRunner" });
      const ok = !!got?.granted;
      if (ok !== this.hasLease) {
        this.hasLease = ok;
        this.log.dim(ok ? "拿到执行租约,本标签页负责跑单" : "另一个标签页在跑,本页只看不动");
        this.emit();
      }
      return ok;
    } catch {
      return false;   // SW 没起来,这一轮不干活
    }
  }

  async tick(): Promise<void> {
    if (!this.loop || this.cfg?.mode === "off") return;
    if (!(await this.lease())) return;
    await this.loop.tickOnce();
  }

  async tickShipments(): Promise<void> {
    if (!this.loop || this.cfg?.mode === "off") return;
    if (!(await this.lease())) return;
    await this.loop.tickShipments();
  }
}
