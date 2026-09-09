/** 认领循环。不碰任何 chrome API —— 这样它能在 Node 里被自检脚本直接驱动。 */

import type { Client } from "../core/client.js";
import { DEFAULTS, posOr, type Config } from "../core/config.js";
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
  /** 一单跑过了硬顶,被看门狗强行收尾。**与 ran 分开**:这一轮没有正常的
   *  outcome 可言。 */
  | { kind: "hard-cap"; task: Task }
  /** 上一单被强行收尾了、但那条 runTask 还没走到 finish(),这一轮不认领。
   *  **与 busy 分开**:busy 是「这一轮正常在跑」,这一格是「什么都没在跑,
   *  但有一件事没收住」—— 两者渲染成同一个结果的话,一台从此再也不拍单的机器
   *  在面板上和一台正忙着的机器长得一样。`since` 是被掐掉的那一刻。 */
  | { kind: "zombie"; since: number }
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

/** 清车熔断的两个数从**配置**来(core/config.cartFailStreakMax / cartBlockMs)。
 *
 *  为什么要有这道熔断:clearCart 是每一单的第一步,它失败的原因通常是
 *  **Amazon 改了购物车页的结构**(删除控件的类名变了)。那种失败对每一单都成立,
 *  而 tickOnce 每 10 秒来一次 —— 一个夜里能把队列里几百单一单一单全部打进
 *  「拍单异常」桶,每一条的错误码还都是 PLUGIN_INTERNAL。
 *  停一会儿不解决问题,但它把「一次坏一整队」变成「一次坏几单」,
 *  剩下的留在队列里等人来看。
 *
 *  这两个数原先是这里的模块级常量。运营台上那一格(cart_fail_24h)让人看得见
 *  该不该调它们,而调不了 —— 要调就得重新打包、全员升级插件,
 *  正是 README 批评厂商的那个毛病。 */

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
  /** 「正在等人确认下单,到点是 deadlineMs」。与 onVerifyWindow 同形状,
   *  但**必须是两条**:一条是「轮到你去发卡行验证」,一条是「轮到你决定买不买」,
   *  处置完全不同 —— 前者已经花过钱了,后者一分钱还没花。 */
  onConfirmWindow?: (deadlineMs: number | null) => void;
  /** 下单前那一屏的应答。**接了它不等于开着** —— 开关在配置里
   *  (`Config.confirmBeforeOrder`,默认关),每一轮现读。
   *  原先这个开关长在「构造 Loop 时传没传这个回调」上,而面板改开关**不重建 Loop**
   *  —— 人在面板上关掉它,机器照旧每一单都停下来等,而开关看起来已经关了。 */
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

  /** 被看门狗强行收尾、但**还没真的结束**的那些 runTask(记的是它们的编号)。
   *
   *  它们的驱动已经 dispose 了,所以每一步都会立刻抛错、很快自己走到 finish();
   *  但在那之前不能再认领下一单 —— 两条 runTask 会去动同一个购物车。
   *  这与「busy 永不复位」不是一回事:busy 在 finally 里照常放掉(相位、
   *  物流那条流、面板都跟着恢复),这里只挡认领。
   *
   *  **但它同样必须有界。** 看门狗存在的理由就是「我们没想到的那件事」,
   *  而 dispose 未必解得开它(等的不是 iframe,而是一个永不 settle 的 promise)。
   *  那种情况下这个集合永远不空,tickOnce 从此每轮返回同一个结果、没有任何新日志,
   *  这个买家号从此一单也不拍 —— 「所有等待都必须有界」这条对它一样成立。
   *  所以再给它一个 taskHardCapMs,到点就不等了(见 tickOnce)。 */
  private zombies = new Set<number>();
  private zombieSeq = 0;
  /** 最早那条僵尸是什么时候被掐掉的,以及等到什么时候为止。 */
  private zombieSince = 0;
  private zombieUntil = 0;

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
    // 僵尸 runTask 的 finish() 里还有一次 clearCart 要跑,它和物流同步一样要开
    // iframe。原先这里只看 busy —— 于是两条流会同时开 iframe 抢焦点,
    // 而这一节的注释说的正是不许发生这件事。
    if (this.zombies.size > 0) return { skipped: "zombie" };

    this.busy = true;
    try {
      return await syncShipments(this.deps.client, reader, this.deps.log);
    } finally {
      this.busy = false;
    }
  }

  /** 这个 Loop **手里有没有活**(此刻在跑 / 有一条被掐掉但还没落地的 runTask)。
   *
   *  执行租约拿它当 busy 报给 SW:租约那条「持有者在跑单就不换手」的判据原先
   *  靠内容脚本猜相位(BUSY_PHASES),而看门狗掐掉一单之后相位是 stuck、
   *  不在那张表里 —— 这个标签页从此报 busy=false,租约到期就被另一个
   *  amazon.com 标签页抢走,而它手上那条僵尸 runTask 还活着:
   *  那条 runTask 走到 finish() 会在同一个买家号上再清一次车,
   *  把新领那一单已经加好的商品删掉。相位是给标签用的,这一位才是事实。 */
  holdsWork(): boolean {
    return this.busy || this.zombies.size > 0;
  }

  /** 跑一轮:认领 → 执行 → 落终态。同一时刻只允许一轮在跑。 */
  async tickOnce(): Promise<TickResult> {
    if (this.busy) return { kind: "busy" };
    const cfg = this.deps.config();

    // 上一单被看门狗掐了但还没落地。挡的是「两条 runTask 动同一个购物车」。
    // 等它也有上限:dispose 解不开的那种挂起会让这个集合永远不空,
    // 而相位落回 idle 的话,面板上是灰色的「待命」、运营台上是「在线 · 可派」,
    // 这台机器从此一单也不拍,却没有任何地方说过这件事。
    if (this.zombies.size > 0) {
      if (Date.now() < this.zombieUntil) {
        this.phase("stuck");
        return { kind: "zombie", since: this.zombieSince };
      }
      // 到点了还没落地:不再等它。这不是「没事了」——
      // 它要是后来真走完了,会和新领的一单动同一个购物车,所以要说清楚。
      this.deps.log.err(
        `被强制收尾的那一单等了 ${Math.round((Date.now() - this.zombieSince) / 60_000)} 分钟` +
        `仍没落地 —— 不再等它,恢复认领。它要是稍后才走完,` +
        `它的收尾清车会和新领的一单撞在同一个购物车上,请人工去这个买家号的购物车看一眼`);
      this.zombies.clear();
    }

    if (cfg.mode === "off") {
      this.phase("off");
      return { kind: "off" };
    }

    // 清车熔断:连着几单清不动车的话,再领下一单也只是再废一单。
    // 相位要报 cart-blocked 而不是 idle:「没单可跑」和「有单也不领」
    // 渲染成同一个「待命」的话,没人会知道这台机器其实停了。
    if (Date.now() < this.cartBlockedUntil) {
      this.phase("cart-blocked");
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
        // 相位也要分开,不能落回 idle:面板上「待命 · 队列里没有本买家号的单」
        // 这一句在这一格是**假话** —— 队列里可能正堆着单,是我们没问到。
        this.phase("no-server");
        return { kind: "transport-error", message: msg };
      }

      const task = claimed.data;
      if (task === null) {
        this.phase("idle");
        return { kind: "no-task" };
      }

      // 服务端从这一刻起数认领超时(task_sweep 只看 claimed_at)。
      // 比库里那个 claimed_at 晚一个 HTTP 来回,余量兜得住。
      const sweepAtMs = typeof task.claim_timeout_min === "number" &&
                        Number.isFinite(task.claim_timeout_min) &&
                        task.claim_timeout_min > 0
        ? Date.now() + task.claim_timeout_min * 60_000
        : null;

      this.deps.log.ok(`认领 task_id=${task.task_id} · ${task.products.map((p) => p.asin).join(",")}`);
      this.phase("claimed", task);

      this.phase("running", task);
      // 看门狗开火之后要让那条 runTask 自己知道「你已经被放弃了」。用一个可变的
      // 小盒子而不是布尔:runTask 在构造时就拿走了 deps,那时还没有 giveUp。
      // 它管住的是**确认窗口**那一格 —— 硬顶被配得比确认窗口紧时,看门狗会在
      // 窗口还开着的时候开火,而此刻人按下的那一下不作数(见 run.ts 那一段)。
      const abandoned = { yes: false };
      const running = runTask(task, {
        client: this.deps.client,
        driver,
        log: this.deps.log,
        askConfirm: this.deps.askConfirm,
        // 开关从**这一轮的配置**读。面板上改它不重建 Loop(runner.setConfig 只在
        // 服务端地址/身份变了才重建),读构造时捕获的那一位会让开关改完不生效。
        confirmBeforeOrder: cfg.confirmBeforeOrder === true,
        // 两个预算都从同一张超时表来,不在这里编译成常量。
        confirmWaitMs: cfg.timeouts?.confirmWait,
        orderServerMarginMs: cfg.timeouts?.orderServerMargin,
        isAbandoned: () => abandoned.yes,
        onLoginLost: () => this.markSignedOut(),
        // 相位由 runTask 说了算的那两格(等人做发卡行验证 / 验证做完了)。
        // Loop 这一层从 claim 到 return 之间一直是 running,分不出「轮到人了」。
        onPhase: (p) => this.phase(p, task),
        onVerifyWindow: (deadlineMs) => this.deps.onVerifyWindow?.(deadlineMs),
        onConfirmWindow: (deadlineMs) => this.deps.onConfirmWindow?.(deadlineMs),
      });

      // ── 看门狗 ──
      //
      // 每一步自己都有上界,所以正常情况下永远轮不到它。它防的是那件我们没想到的事:
      // runTask 因为某个原因不返回,busy 闸永不复位,这个标签页从此安静地什么都不干,
      // 面板停在「执行中」,而服务端 15 分钟后把这条判成 CLAIM_TIMEOUT。
      // 厂商的 purchaseBatchInProgress 死法就是这个形状,只是我们的锁叫 busy。
      const capMs = this.watchdogCapMs(cfg, task);
      const cap = hardCap(capMs);
      const outcome = await Promise.race([running, cap.race]).finally(cap.cancel);
      if (outcome === HARD_CAP) {
        return await this.giveUp(task, running, driver, capMs, sweepAtMs, abandoned);
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

  /** 输入:配置 + 这一单 → 输出:看门狗的硬顶(毫秒)。
   *
   *  两个上界取更紧的那个:插件自己的 `cfg.taskHardCapMs`,以及**服务端的认领
   *  超时**减去留给服务端的余量。后者原先没算进来 —— 默认 20 分钟的硬顶比默认
   *  15 分钟的认领超时还长,于是看门狗触发的时候任务在服务端**必然已经不是
   *  claimed 了**,它那条「插件放弃这一单」的 step 事件会被 TASK_NOT_HELD 拒掉,
   *  事件流里再也没有任何地方说过「是插件这边先放弃的」,而日志还写着
   *  「任务在服务端仍是拍单中」。
   *
   *  **绝不允许算出 0**:那样看门狗会在每一单刚开跑时就触发,而它的表现是
   *  「这一单跑了超过 0 分钟」—— 一道兜底网变成了绞索。所以:配置里没有这一项
   *  (旧存档、自检脚本给的桩)或被人填坏了就用默认值。
   *
   *  **认领窗口本身比余量还小时(claim_timeout_min ≤ 3 分钟)取窗口的一半,
   *  不是窗口本身。** 取窗口本身等于「余量为零」,而插件这本账的起点比服务端的
   *  claimed_at 晚一个 HTTP 来回 —— 看门狗开火那一刻任务在服务端**必然**已经过了
   *  清扫线,giveUp() 那条「插件放弃这一单」的留痕注定被 TASK_NOT_HELD 拒掉,
   *  事件流里再没有任何地方说过是插件先放弃的。§8.3 承诺的是「插件永远给服务端
   *  留出余量」,一半虽然不是配出来的余量,至少是真的余量。 */
  private watchdogCapMs(cfg: Config, task: Task): number {
    // 「下单前确认」那段等待**算在这个硬顶里面,不豁免**。豁免它等于给
    // 「我们没想到的那件事」开一个不设防的口子,而看门狗存在的全部理由就是那件事;
    // 而且确认窗口自己已经被同一把尺子钳过(run.ts 那一段:窗口 − 余量),
    // 两道界限方向一致。代价说在明处:confirmWait 配得比这个硬顶还长时,
    // 先到期的是看门狗(相位 stuck,面板上说得出名字),不是确认窗口。
    const own = posOr(cfg.taskHardCapMs, DEFAULTS.taskHardCapMs);
    const min = task.claim_timeout_min;
    if (typeof min !== "number" || !Number.isFinite(min) || min <= 0) return own;
    const window = min * 60_000;
    const margin = posOr(cfg.timeouts?.orderServerMargin, DEFAULTS.timeouts.orderServerMargin);
    const room = window - margin;
    return Math.min(own, room > 0 ? room : Math.max(1, Math.floor(window / 2)));
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
    sweepAtMs: number | null,
    abandoned: { yes: boolean },
  ): Promise<TickResult> {
    // **第一件事**:告诉那条僵尸 runTask 它已经被放弃了,再把面板上那张
    // 「下单前确认 · 会花真钱」的卡片收掉。顺序不能反 —— 收卡片会让面板
    // 那头 resolve(false),runTask 那边正是靠这一位把它认成「被掐了」
    // 而不是「人按了取消」(两件事渲染成一句话,就是本项目反复记的那种合并)。
    //
    // 不收卡片的后果比停在那儿难看得多:硬顶被配得比确认窗口紧时,看门狗在
    // 窗口还开着的时候开火,而屏幕上那两个按钮照旧能按,一直挂到确认窗口
    // 自己到点(可以是几分钟)。操作员按下「下单」,一张一分钱没花的单会
    // 越过下单点,以「可能已下单、去买家号里看一眼」收场。
    abandoned.yes = true;
    this.deps.onConfirmWindow?.(null);
    const mins = Math.round(capMs / 60_000);
    // 「任务在服务端仍是拍单中」不许写死成一句话:硬顶被配得比认领超时还长时
    // 它就是假的,而那恰恰是最需要看日志的一格。按此刻的钟说话。
    const stillClaimed = sweepAtMs === null || Date.now() < sweepAtMs;
    this.deps.log.err(`这一单跑了超过 ${mins} 分钟仍未结束 —— 强制关掉页面收尾。` +
                      (stillClaimed
                        ? `任务在服务端还是「拍单中」,交给认领超时清扫转待人工`
                        : `服务端的认领超时已经过了,这条多半已经被清扫成待人工`));
    // 认领窗口比留给服务端的余量还小(claim_timeout_min 配成了 1、2 分钟这种):
    // 硬顶只能退一步取窗口的一半,余量不再是配出来的那个数。下面那条留痕
    // 多半写不进去,先把原因说清楚 —— 否则看日志的人只看到一条 TASK_NOT_HELD。
    const min = task.claim_timeout_min;
    const cfgMargin = posOr(this.deps.config().timeouts?.orderServerMargin,
                            DEFAULTS.timeouts.orderServerMargin);
    if (typeof min === "number" && Number.isFinite(min) && min > 0 &&
        min * 60_000 - cfgMargin <= 0) {
      this.deps.log.warn(
        `认领超时被配成了 ${min} 分钟,比留给服务端的余量(` +
        `${Math.round(cfgMargin / 1000)} 秒)还紧 —— 硬顶只能取窗口的一半,` +
        `下面这条「插件放弃这一单」的留痕多半会被 TASK_NOT_HELD 拒掉。` +
        `要么调大 AMZ_CLAIM_TIMEOUT_MIN,要么调小 orderServerMargin`);
    }
    // 编号而不是计数:等超时之后我们会把整个集合清掉,那条 runTask 稍后
    // 真走完时不该再去减一个已经归零的数(会减成负数,下一轮判断就废了)。
    const id = ++this.zombieSeq;
    this.zombies.add(id);
    this.zombieSince = Date.now();
    // 再给它一个 taskHardCapMs。到点就不等了 —— 看门狗防的就是「我们没想到的
    // 那件事」,而 dispose 未必解得开它。
    this.zombieUntil = this.zombieSince + capMs;
    void running.finally(() => {
      if (this.zombies.delete(id)) {
        this.deps.log.warn("被强制收尾的那一单已经落地,恢复认领");
      }
    });
    try { await driver.dispose(); } catch { /* 关不掉也得往下走 */ }
    // 事件流里要留下这一条:否则运营台上只看到任务停在「拍单中」然后被清扫,
    // 没有任何地方说过「是插件这边先放弃的」。
    const noted = await this.deps.client.events(task.task_id, [{
      kind: "step",
      payload: { step: "插件放弃这一单", state: "plugin_hard_cap",
                 cap_ms: capMs, note: "超过单笔硬顶,已强制关闭页面" },
    }]);
    if (!noted.ok) {
      // 写不进去要说出来。默默吞掉的话,运营台上这一单看起来就是「领走了、
      // 停在拍单中、被清扫」,而「是插件先放弃的」这件事谁也不知道。
      this.deps.log.warn(
        "「插件放弃这一单」这条留痕没写进事件流:" +
        (noted.kind === "business" ? `${noted.code} ${noted.message}` : noted.message));
    }
    // **不是 idle。** 「没单可跑」和「有单也不领」渲染成同一个灰色的「待命」的话,
    // 没人会知道这台机器其实停了 —— cart-blocked 那一格已经吃过这个亏。
    this.phase("stuck", null);
    return { kind: "hard-cap", task };
  }

  /** 清车熔断的计数。数的是**这一单收尾时有没有把车留干净**,一单一票:
   *
   *   · true(清干净了 / 拍成了)→ 连续计数清零
   *   · false(试了没清动)→ +1,够数就熔断
   *   · null(越过下单点,按规矩不动购物车;或者没说上话,不知道)→ 既不加也不清
   *
   *  **清零的时机曾经在「这一单开头那次清车成功」上**(runTask 的 onCartCleared),
   *  而每一单都是从清车开始的:只要开头那次成功过,计数在每一单开头就被清零,
   *  连续数永远回不到 2。真实形状是「开头那次(车是空的、走空车早退路径)成功、
   *  收尾那次(车里有东西)失败」—— Amazon 改了购物车删除控件的类名时每一单都成立,
   *  于是这道熔断在它最该起作用的那一格上完全是死的。
   *
   *  purchased 记 true:拍成了说明开头那次清车成功过(它失败会直接抛),
   *  而下单之后车本来就空了。released / unreported 自己带着这一位
   *  (见 run.ts 的 Outcome)——「服务端不知道这一单的结局」不等于
   *  「不知道购物车清没清动」,后者是关于**这台机器**的事实。 */
  private noteCart(outcome: Outcome): void {
    const cleared: boolean | null =
      outcome.kind === "purchased" ? true : outcome.cartCleared;
    if (cleared === null) return;   // 没试过 / 不知道 —— 既不加也不清
    if (cleared) {
      this.cartFailStreak = 0;
      return;
    }
    const cfg = this.deps.config();
    const max = Math.floor(posOr(cfg.cartFailStreakMax, DEFAULTS.cartFailStreakMax));
    const blockMs = posOr(cfg.cartBlockMs, DEFAULTS.cartBlockMs);
    this.cartFailStreak += 1;
    if (this.cartFailStreak >= max) {
      this.cartBlockedUntil = Date.now() + blockMs;
      this.cartFailStreak = 0;
      this.deps.log.err(
        `连续 ${max} 单清不动购物车 —— 暂停认领 ` +
        `${Math.round(blockMs / 60_000)} 分钟。多半是 Amazon 改了购物车页的结构,` +
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
