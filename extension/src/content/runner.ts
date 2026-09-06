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
import { SingleFlight } from "../core/singleflight.js";
import type { Phase } from "../core/status.js";
import type { Task } from "../core/types.js";
import { Loop } from "../background/loop.js";
import { AmazonDriver, AmazonShipmentReader } from "../flow/amazon.js";
import { SimulatedDriver, SimulatedShipmentReader } from "../flow/simulated.js";
import type { PageDriver } from "../flow/driver.js";
import type { LoginState } from "../flow/dom/parse.js";
import type { ShipmentReader } from "../flow/shipment.js";

export interface RunnerState {
  phase: Phase;
  task: Task | null;
  hasLease: boolean;
  /** 正在等操作员做发卡行验证,到点是这个时刻(epoch 毫秒)。null = 没在等。 */
  verifyDeadlineMs: number | null;
}

/** 这几个相位表示「这个标签页手里有一单没跑完」。续租时要把它报给 SW ——
 *  正在跑单的标签页即使因为后台节流没能按时续租,也不该被别的标签页抢走租约。
 *
 *  **相位只是兜底,不是判据本体。** 真正的事实由 `Loop.holdsWork()` 给出
 *  (在跑 / 有一条被掐掉还没落地的 runTask);猜相位漏过一整格 ——
 *  看门狗掐单之后相位是 `stuck`,不在这张表里,而那条僵尸 runTask 还活着。 */
const BUSY_PHASES: ReadonlySet<Phase> = new Set<Phase>(["claimed", "running", "confirm", "verify", "stuck"]);

export class Runner {
  readonly log = new Log();

  private cfg: Config | null = null;
  private client: Client | null = null;
  private loop: Loop | null = null;
  private hasLease = false;
  private verifyDeadlineMs: number | null = null;
  /** 单飞闸。**挂在 Runner 上,不挂在 Loop 上** —— Loop 会被 setConfig 重建,
   *  闸跟着归零,于是正在跑的那一单还没结束就又领了一单进来(两条 runTask
   *  动同一个购物车)。Runner 只有一个,活得比 Loop 长。 */
  private readonly flight = new SingleFlight<Config>((cfg) => this.applyConfig(cfg));
  /** 服务端在心跳里回的「该复检登录态了」。每轮要租约时从 SW 顺手取回来。 */
  private loginCheckDue = false;
  private phase: Phase = "off";
  private task: Task | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private listeners = new Set<(s: RunnerState) => void>();

  onChange(fn: (s: RunnerState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  state(): RunnerState {
    return {
      phase: this.phase,
      task: this.task,
      hasLease: this.hasLease,
      verifyDeadlineMs: this.verifyDeadlineMs,
    };
  }

  private emit() {
    const s = this.state();
    for (const fn of this.listeners) fn(s);
  }

  /** 配置变了就地更新。
   *
   *  两道保险,缺一不可:
   *   1. 只在**服务端地址或身份**变了的时候才换 client / 重建 Loop
   *      —— 别的改动就地生效就行;
   *   2. 正在跑单时**先收着,等这一单结束再生效**(单飞闸在 Runner 上)。
   *      原先只有第 1 条:地址一变就 `this.loop = null`,新 Loop 的 busy 是 false,
   *      10 秒后的定时器又领了一单,两条 runTask 动同一个购物车。 */
  setConfig(cfg: Config): void {
    if (this.flight.offer(cfg)) {
      this.log.dim("配置已收到,等这一单跑完再生效");
    }
  }

  private applyConfig(cfg: Config): void {
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
        // 「此刻正在等这个人做发卡行验证,到点是什么时候」。面板拿它跑倒计时;
        // 相位负责标签,这一条负责那个数字。
        onVerifyWindow: (deadlineMs) => { this.verifyDeadlineMs = deadlineMs; this.emit(); },
        // 读页面必须在内容脚本里(SW 没有 document),心跳发在 SW 里。
        // 所以这里只负责把读到的那一位交给 SW,由它挂在下一次心跳上。
        reportLogin: (state: LoginState) => {
          chrome.runtime.sendMessage({ type: "amz.loginState", state })
            .catch(() => { /* SW 没起来:下一轮复检还会再报一次,不必在这里重试 */ });
        },
        loginCheckDue: () => this.loginCheckDue,
      });
    }
    this.emit();
  }

  private driver(): PageDriver {
    // 超时表从配置来 —— 页面等待的每一个数字都要能现场调,不许编译进 dist。
    return this.cfg?.mode === "simulate"
      ? new SimulatedDriver("happy")
      : new AmazonDriver(undefined, this.cfg?.timeouts);
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
      // busy 要**如实**报:正在跑单的标签页即使被切到后台、续租迟到,
      // 也不该被别的标签页把租约抢走(两单并行动同一个购物车)。
      //
      // 两个来源取或,缺一不可:
      //  · `this.flight.busy` —— 此刻闸里有活。认领那一轮从 claim 到 return
      //    之间相位会被 Loop 改成 claimed/running,但**在这之前**有一小段
      //    (刚进闸、还没 claim 到)相位仍是上一轮留下的 idle;物流同步那一轮
      //    也占着 iframe,同样不该让位。
      //  · `Loop.holdsWork()` —— Loop 自己说的事实:在跑,或者有一条被看门狗
      //    掐掉、还没走到 finish() 的 runTask。**这一条是判据本体。**
      //    原先这里只有闸和相位:看门狗掐单之后闸已经放掉、相位是 stuck,
      //    两条都说不忙,租约 5 分钟一到就被另一个标签页接管走,
      //    而那条僵尸稍后走到 finish() 会在同一个买家号上再清一次车,
      //    把新领那一单已经加好的商品删掉。
      //  · 相位 —— 兜住 Loop 还没建起来、或者我们没想到的那一格。
      //
      // 不能只写「这一轮 tick 在跑」:续租现在发生在闸**外面**,那一位永远是
      // true,任何一个空转的标签页都会声称自己在忙,这道判据就废了。
      const got = await chrome.runtime.sendMessage({
        type: "amz.acquireRunner",
        busy: this.flight.busy || !!this.loop?.holdsWork() || BUSY_PHASES.has(this.phase),
      });
      const ok = !!got?.granted;
      // 服务端说「这个买家号有单在等,而且该复检登录态了」。
      // 搭租约这趟车回来的,不另开一条消息路径。
      this.loginCheckDue = !!got?.loginCheckDue;
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

  /** 续租 + 认领。
   *
   *  **续租在闸外面。** 一单能跑好几分钟(光发卡行验证那一段就有 6 分钟预算),
   *  这期间闸一直是关着的 —— 把 lease() 关进闸里,租约在整单期间**一次都续不上**,
   *  TTL 一到另一个标签页就把它接管走,两条 runTask 动同一个购物车。
   *  那正是这道闸要堵的洞,却被闸自己堵死了。
   *
   *  放在闸外面不构成 TOCTOU:SingleFlight.run 的检查与置位之间没有 await,
   *  两个定时器同时 await 完租约,也只有一个能进闸(另一个 run 直接返回 false)。 */
  async tick(): Promise<void> {
    if (!this.loop || this.cfg?.mode === "off") return;
    if (!(await this.lease())) return;
    await this.flight.run(async () => {
      await this.loop!.tickOnce();
    });
  }

  async tickShipments(): Promise<void> {
    if (!this.loop || this.cfg?.mode === "off") return;
    if (!(await this.lease())) return;
    // 与认领共用同一道闸:两条流都要开 iframe,同时跑会互相抢焦点。
    await this.flight.run(async () => {
      await this.loop!.tickShipments();
    });
  }
}
