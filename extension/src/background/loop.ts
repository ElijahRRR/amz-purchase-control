/** 认领循环。不碰任何 chrome API —— 这样它能在 Node 里被自检脚本直接驱动。 */

import type { Client } from "../core/client.js";
import { DEFAULTS, type Config } from "../core/config.js";
import type { Log } from "../core/log.js";
import type { Phase } from "../core/status.js";
import type { Task } from "../core/types.js";
import type { PageDriver } from "../flow/driver.js";
import type { LoginState } from "../flow/dom/parse.js";
import { runTask, type Outcome, type RunDeps } from "../flow/run.js";
import { syncShipments, type ShipmentReader, type SyncSummary } from "../flow/shipment.js";

export type TickResult =
  | { kind: "busy" }
  | { kind: "off" }
  | { kind: "driver-not-ready"; driver: string }
  /** 连着几单都清不动购物车,熔断了。**与 no-task 分开**:队列里可能有一堆单,
   *  是我们主动不领 —— 领了也只会一单一单打进异常桶。 */
  | { kind: "cart-blocked"; untilMs: number }
  /** 一单跑过了硬顶,被看门狗强行收尾。任务此刻在服务端仍是 claimed,
   *  交给超时清扫。**与 ran 分开**:这一轮没有正常的 outcome 可言。 */
  | { kind: "hard-cap"; task: Task }
  | { kind: "no-task" }
  /** 这个浏览器被登出了,这一轮不认领。**与 no-task 分开**:
   *  「没有单」是正常的,「领不了单」是要人去处理的,长得一样就没人会去处理。 */
  | { kind: "signed-out" }
  | { kind: "transport-error"; message: string }
  | { kind: "ran"; task: Task; outcome: Outcome };

/** 本地那层登录态缓存的有效期。
 *
 *  真正的复检节奏由服务端说了算(心跳回的 login_check_due,
 *  阈值在 registry/settings.login_recheck_minutes)—— 那边知道「这个买家号
 *  有没有单在等派」,插件不知道。这里这一层只防一件事:服务端一直说"该查了"
 *  (比如上报的那条心跳还没来得及发出去)时,别每 10 秒就开一张页面。 */
const LOGIN_CACHE_MS = 10 * 60_000;

/** 连着几单清不动购物车就停下来。
 *
 *  为什么要有这道熔断:clearCart 是每一单的第一步,它失败的原因通常是
 *  **Amazon 改了购物车页的结构**(删除控件的类名变了)。那种失败对每一单都成立,
 *  而 tickOnce 每 10 秒来一次 —— 一个夜里能把队列里几百单一单一单全部打进
 *  「拍单异常」桶,每一条的错误码还都是 PLUGIN_INTERNAL。
 *  停 10 分钟不解决问题,但它把「一次坏一整队」变成「一次坏三单」,
 *  剩下的留在队列里等人来看。 */
const CART_FAIL_STREAK_MAX = 3;
const CART_BLOCK_MS = 10 * 60_000;

export interface LoopDeps {
  client: Client;
  log: Log;
  config: () => Config;
  driver: () => PageDriver;
  /** 物流读取器。与 driver 分开:那条流跑在 purchased 之后,不碰购物车也不下单。 */
  shipmentReader?: () => ShipmentReader;
  onPhase?: (phase: Phase, task: Task | null) => void;
  /** 「正在等操作员做发卡行验证,到点是 deadlineMs」。面板拿它跑倒计时,
   *  离开那一格时传 null。相位(onPhase)负责标签,这一条负责那个数字。 */
  onVerifyWindow?: (deadlineMs: number | null) => void;
  askConfirm?: RunDeps["askConfirm"];
  /** 读到的登录态往上报一次。内容脚本转给 service worker,由它挂在下一次心跳上
   *  —— Loop 自己不碰任何 chrome API(这样它能在 Node 里被自检脚本直接驱动)。 */
  reportLogin?: (state: LoginState) => void;
  /** 服务端在心跳里回的那一句:这个买家号有单在等,而且上次读页面已经过了复检间隔。
   *  没接这个回调时永远返回 false —— **不主动开页面**:
   *  队列空着的时候开一张 Amazon 页面读导航栏,读到的结论也没人用得上。 */
  loginCheckDue?: () => boolean;
}

export class Loop {
  private busy = false;
  private warnedDriver = false;

  /** 连续几单清不动购物车,以及熔断到什么时候。 */
  private cartFailStreak = 0;
  private cartBlockedUntil = 0;

  /** 被看门狗强行收尾、但**还没真的结束**的那些 runTask。
   *
   *  它们的驱动已经 dispose 了,所以每一步都会立刻抛错、很快自己走到 finish();
   *  但在那之前不能再认领下一单 —— 两条 runTask 会去动同一个购物车。
   *  这与「busy 永不复位」不是一回事:busy 在 finally 里照常放掉(相位、
   *  物流那条流、面板都跟着恢复),这里只挡认领,而且挡的是一件**会结束**的事。 */
  private zombies = 0;

  /** 这台机器最后一次判出来的登录态。**初值 unknown,不是 ok** ——
   *  没查过就是没查过,而 unknown 不拦认领(拦了新装的实例永远领不到第一单)。 */
  private loginState: LoginState = "unknown";
  private loginCheckedAt = 0;
  private warnedSignedOut = false;

  constructor(private readonly deps: LoopDeps) {}

  /** 执行中驱动发现落到了登录页。就地把本地那一位改掉并上报 ——
   *  下一轮 tick 因此不会再去认领,而不是继续领一单、再走到 /ap/signin 一次。 */
  private markSignedOut(): void {
    this.loginState = "signed_out";
    this.loginCheckedAt = Date.now();
    this.deps.reportLogin?.("signed_out");
  }

  /** 认领之前问一句「还登着吗」。
   *
   *  什么时候真去开页面:服务端说该查了(有单在等 + 上次检查已经过期),
   *  且本地缓存也过期了。两个条件都要 —— 前者保证不为空队列白开页面,
   *  后者保证上报还在路上时不会每轮都开一次。 */
  private async ensureLoginChecked(driver: PageDriver): Promise<LoginState> {
    const fresh = Date.now() - this.loginCheckedAt < LOGIN_CACHE_MS;
    if (fresh || !(this.deps.loginCheckDue?.() ?? false)) return this.loginState;

    let state: LoginState;
    try {
      state = await driver.readLoginState();
    } catch (e) {
      // 读失败**什么都不报**,本地这一位也不动。
      //
      // 「不传 = 这一轮没有新消息」这条通道本来就有(client.heartbeat 的注释)。
      // 报一个 unknown 上去会把服务端库里确凿的 signed_out 洗成"存疑",
      // 认领闸当场重新打开 —— 而读失败恰恰是被登出时的常见现象
      // (Amazon 弹验证码、探测页没加载出来)。服务端那边也拦着同一件事
      // (services/instance._KEEPS_OLD_LOGIN_STATE),两头都不许它发生。
      //
      // 只把"刚试过"记下来:不记的话,服务端会一直说 login_check_due,
      // 这里每一轮都去开一张页面。**不许兜底成 ok** 也仍然成立 ——
      // 读不出来时放行,这道闸就等于不存在。
      this.deps.log.warn("读登录态失败(这一轮不上报,保留上一次的结论):" +
                         (e instanceof Error ? e.message : String(e)));
      this.loginCheckedAt = Date.now();
      return this.loginState;
    }
    const was = this.loginState;
    this.loginState = state;
    this.loginCheckedAt = Date.now();
    this.deps.reportLogin?.(state);
    if (state === "ok" && was === "signed_out") {
      this.warnedSignedOut = false;
      this.deps.log.ok("登录态已恢复,继续认领");
    }
    return state;
  }

  private phase(p: Phase, task: Task | null = null) {
    this.deps.onPhase?.(p, task);
  }

  /** 同步一轮物流。与认领共用 busy 闸:两条流都要开 iframe,
   *  同时跑会让一个页面里挂着一堆 iframe,也会互相抢焦点。 */
  async tickShipments(): Promise<SyncSummary | { skipped: string }> {
    const cfg = this.deps.config();
    if (cfg.mode === "off") return { skipped: "off" };
    const make = this.deps.shipmentReader;
    if (!make) return { skipped: "no-reader" };
    const reader = make();
    if (!reader.ready) return { skipped: "reader-not-ready" };
    if (this.busy) return { skipped: "busy" };

    this.busy = true;
    try {
      return await syncShipments(this.deps.client, reader, this.deps.log);
    } finally {
      this.busy = false;
    }
  }

  /** 跑一轮:认领 → 执行 → 落终态。同一时刻只允许一轮在跑。 */
  async tickOnce(): Promise<TickResult> {
    if (this.busy) return { kind: "busy" };
    // 上一单被看门狗掐了但还没落地。挡的是「两条 runTask 动同一个购物车」。
    if (this.zombies > 0) return { kind: "busy" };
    const cfg = this.deps.config();

    if (cfg.mode === "off") {
      this.phase("off");
      return { kind: "off" };
    }

    // 清车熔断:连着几单清不动车的话,再领下一单也只是再废一单。
    if (Date.now() < this.cartBlockedUntil) {
      this.phase("idle");
      return { kind: "cart-blocked", untilMs: this.cartBlockedUntil };
    }

    const driver = this.deps.driver();
    if (!driver.ready) {
      // 与其领了单再报 PLUGIN_INTERNAL 把它打进异常桶,不如根本不领。
      if (!this.warnedDriver) {
        this.deps.log.warn(`驱动 ${driver.name} 尚未实现执行动作,不认领`);
        this.warnedDriver = true;
      }
      this.phase("off");
      return { kind: "driver-not-ready", driver: driver.name };
    }

    this.busy = true;
    try {
      // 被登出的机器不该继续刷认领:服务端那道闸会一条条拒,而每一次拒都是
      // 一个来回。更要紧的是,这件事必须在界面上说出来 ——
      // 「领不到单」和「没有单」长得一样的话,没人会去重新登录。
      if ((await this.ensureLoginChecked(driver)) === "signed_out") {
        if (!this.warnedSignedOut) {
          this.deps.log.err("买家号已被登出,暂停认领 —— 请在这个浏览器里重新登录 Amazon");
          this.warnedSignedOut = true;
        }
        this.phase("signed-out");
        return { kind: "signed-out" };
      }

      const claimed = await this.deps.client.claim();

      if (!claimed.ok) {
        // 服务端那道闸拦下的:多半是另一个标签页/上一轮已经报过被登出。
        // 本地跟着改一位,下一轮就不必再来问一次。
        if (claimed.kind === "business" && claimed.code === "INSTANCE_SIGNED_OUT") {
          this.loginState = "signed_out";
          // **不动 loginCheckedAt**:这一位是服务端告诉我们的,不是我们读页面读到的。
          // 动了它就等于宣称"刚刚查过",复检会被推迟一整个缓存周期,
          // 而人可能已经重新登录好了。
          if (!this.warnedSignedOut) {
            this.deps.log.err("服务端拒绝派单:" + claimed.message);
            this.warnedSignedOut = true;
          }
          this.phase("signed-out");
          return { kind: "signed-out" };
        }
        // 「没说上话」绝不能当成「没有单」。厂商插件正是在这里把网络失败
        // 记成「没有需要同步的订单」,运维看日志会以为系统正常(深度分析 §5.3)。
        const msg = claimed.kind === "transport" ? claimed.message : `${claimed.code} ${claimed.message}`;
        this.deps.log.err("认领失败:" + msg);
        this.phase("idle");
        return { kind: "transport-error", message: msg };
      }

      const task = claimed.data;
      if (task === null) {
        this.phase("idle");
        return { kind: "no-task" };
      }

      this.deps.log.ok(`认领 task_id=${task.task_id} · ${task.products.map((p) => p.asin).join(",")}`);
      this.phase("claimed", task);

      this.phase("running", task);
      const running = runTask(task, {
        client: this.deps.client,
        driver,
        log: this.deps.log,
        askConfirm: this.deps.askConfirm,
        confirmBeforeOrder: !!this.deps.askConfirm,
        onLoginLost: () => this.markSignedOut(),
        // 相位由 runTask 说了算的那两格(等人做发卡行验证 / 验证做完了)。
        // Loop 这一层从 claim 到 return 之间一直是 running,分不出「轮到人了」。
        onPhase: (p) => this.phase(p, task),
        onVerifyWindow: (deadlineMs) => this.deps.onVerifyWindow?.(deadlineMs),
      });

      // ── 看门狗 ──
      //
      // 每一步自己都有上界,所以正常情况下永远轮不到它。它防的是那件我们没想到的事:
      // runTask 因为某个原因不返回,busy 闸永不复位,这个标签页从此安静地什么都不干,
      // 面板停在「执行中」,而服务端 15 分钟后把这条判成 CLAIM_TIMEOUT。
      // 厂商的 purchaseBatchInProgress 死法就是这个形状,只是我们的锁叫 busy。
      // 配置里没有(旧存档、自检脚本给的桩)或者被人填坏了,就用默认值。
      // **绝不允许算出 0**:那样看门狗会在每一单刚开跑时就触发,
      // 而它的表现是「这一单跑了超过 0 分钟」—— 一道兜底网变成了绞索。
      const capMs = Number.isFinite(cfg.taskHardCapMs) && cfg.taskHardCapMs > 0
        ? cfg.taskHardCapMs
        : DEFAULTS.taskHardCapMs;
      const cap = hardCap(capMs);
      const outcome = await Promise.race([running, cap.race]).finally(cap.cancel);
      if (outcome === HARD_CAP) {
        return await this.giveUp(task, running, driver, capMs);
      }

      this.noteCart(outcome);
      this.phase(outcome.kind === "purchased" ? "done"
               : outcome.kind === "failed" && outcome.toManual ? "blocked"
               : "idle", task);
      return { kind: "ran", task, outcome };
    } finally {
      this.busy = false;
    }
  }

  /** 一单跑过了硬顶:强行收尾,把这件事说出去,然后**不再等它**。
   *
   *  注意这里没有「取消」——JavaScript 的 Promise 取消不了。能做的是把驱动
   *  dispose 掉(iframe 全部关掉,后面每一步都会立刻抛错),于是那条 runTask
   *  会很快自己走到 finish() 上报失败。在它真的结束之前,zombies 挡住下一次认领。 */
  private async giveUp(
    task: Task,
    running: Promise<Outcome>,
    driver: PageDriver,
    capMs: number,
  ): Promise<TickResult> {
    const mins = Math.round(capMs / 60_000);
    this.deps.log.err(`这一单跑了超过 ${mins} 分钟仍未结束 —— 强制关掉页面收尾。` +
                      `任务在服务端仍是「拍单中」,交给超时清扫转待人工`);
    this.zombies += 1;
    void running.finally(() => {
      this.zombies -= 1;
      this.deps.log.warn("被强制收尾的那一单已经落地,恢复认领");
    });
    try { await driver.dispose(); } catch { /* 关不掉也得往下走 */ }
    // 事件流里要留下这一条:否则运营台上只看到任务停在「拍单中」然后被清扫,
    // 没有任何地方说过「是插件这边先放弃的」。
    await this.deps.client.events(task.task_id, [{
      kind: "step",
      payload: { step: "插件放弃这一单", state: "plugin_hard_cap",
                 cap_ms: capMs, note: "超过单笔硬顶,已强制关闭页面" },
    }]);
    this.phase("idle", null);
    return { kind: "hard-cap", task };
  }

  /** 清车熔断的计数。**只数「试了没清动」**(cartCleared === false):
   *  越过下单点那一路按规矩就不清车(null),把它算进来的话,
   *  三单「可能已下单」就能让一台购物车好好的机器停止认领。 */
  private noteCart(outcome: Outcome): void {
    if (outcome.kind !== "failed" || outcome.cartCleared === null) return;
    if (outcome.cartCleared) {
      this.cartFailStreak = 0;
      return;
    }
    this.cartFailStreak += 1;
    if (this.cartFailStreak >= CART_FAIL_STREAK_MAX) {
      this.cartBlockedUntil = Date.now() + CART_BLOCK_MS;
      this.cartFailStreak = 0;
      this.deps.log.err(
        `连续 ${CART_FAIL_STREAK_MAX} 单清不动购物车 —— 暂停认领 ` +
        `${Math.round(CART_BLOCK_MS / 60_000)} 分钟。多半是 Amazon 改了购物车页的结构,` +
        `请人工去这个买家号的购物车看一眼`);
    }
  }
}

/** 看门狗用的哨兵。用一个独一无二的对象而不是 null/undefined ——
 *  runTask 的返回值里没有它,不可能撞上。 */
const HARD_CAP = Symbol("hard-cap");

/** 定时器要能取消:正常那一路(runTask 先返回)如果不 clearTimeout,
 *  每一单都会留下一个几十分钟才醒的定时器 —— 在 Node 里它还会吊着进程不退出。
 *  「所有等待都有上限」的另一半是「所有定时器都收得掉」(见 dom/wait.ts 的 finally)。 */
function hardCap(ms: number): { race: Promise<typeof HARD_CAP>; cancel: () => void } {
  let t: ReturnType<typeof setTimeout> | undefined;
  const race = new Promise<typeof HARD_CAP>((resolve) => {
    t = setTimeout(() => resolve(HARD_CAP), ms);
  });
  return { race, cancel: () => { if (t !== undefined) clearTimeout(t); } };
}
