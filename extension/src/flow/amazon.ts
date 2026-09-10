/** 真实 Amazon 页面驱动。
 *
 * 选择器全部来自 dom/selectors.ts,出处标在那里。这一层只管「怎么走」:
 * 开哪个 iframe、等什么、点什么、什么时候算失败。
 *
 * 照着厂商插件反着写的几处(深度分析 §4.2):
 *  - 加购后**只**认落到购物车页才算成功。厂商那条超时分支只打日志不通知服务端,
 *    任务就那么悬着。
 *  - 下单成功**只**认 thankyou 页。厂商把「被退回购物车」也判成功 ——
 *    而那恰恰是下单失败的典型表现(库存被抢、支付被拒、地址被拒)。
 *  - 没有 `addressFillingInProgress` 这种全局标志位。厂商那个标志位在跳转超时
 *    的分支里不复位,下一单进来命中裸 return,整批静默死锁。
 *    我们一次只跑一单,状态在 runTask 的栈上,没有可泄漏的全局量。
 */

import { SEL, URLS } from "./dom/selectors.js";
import { openFrame, withFrame, type Frame, type UrlState } from "./dom/frame.js";
import { sleep, waitFor, waitStable, WaitTimeout } from "./dom/wait.js";
import {
  cartMatches, describeMiss, findAddNewAddressEntry, findAddToCartButton,
  findAddressChangeEntry, findAddressFormNameField, findAddressSection,
  findInterstitialButton, findQuantityOption, findSubmitOrderButton, findTrackingLink,
  findCardRadioByLast4, findPaymentChangeEntry, findPaymentConfirmButton,
  isRendered,
  readAddressSaveOutcome, readAppliedAddressText,
  pickFirstRendered, pickQuantitySelect, readCarrier, readCartLines, readCartState,
  readCheckoutPanels,
  readDeliveryPromise, readGrandTotal, readInStock, readOrderCards, readOrderState,
  isTrackingUnavailable,
  isSignInUrl,
  readCustomerId,
  readLoginState,
  readGiftCardDeduction,
  readOrderSummary, readPaymentLast4, readPaymentSlots, readProductShipper, readTrackingEvents,
  readTrackingNumber, readTrackingStatus,
  type AddressSaveOutcome, type CartLine, type LoginState, type OrderState,
} from "./dom/parse.js";
import type { ShipmentReader, TrackingRead } from "./shipment.js";
import { DriverError, LoginLostError, type AddResult, type CartReadReporter, type CheckoutReading, type OrderCard, type PageDriver, type PaymentCardHooks, type PaymentCardResult, type PlaceOrderHooks } from "./driver.js";
import { DEFAULTS, type Timeouts } from "../core/config.js";
import type { Shipping } from "../core/types.js";

/** 上一次登录探测里读到的买家号 ID。**只在真读到时才覆盖,读不到不清空。**
 *
 *  为什么可以不清空:清空之后内容脚本就少捎一位上去,而服务端对「没捎」的处置
 *  正是「保留库里那一位」(services/instance.heartbeat 的 CASE)——
 *  两条路殊途同归,留着反而少一处会分叉的判断。
 *
 *  为什么是模块级而不是驱动实例的字段:驱动是**每一轮现造**的
 *  (content/runner.ts 的 `driver()` 每次 `new`),挂在实例上等于每轮清一次。
 *  一个浏览器 profile 只登着一个 Amazon 账号,所以进程内单例正是它的语义。 */
let lastCustomerId: string | undefined;

/** 输入:无 → 输出:上一次登录探测读到的买家号 ID(没读到过就是 undefined)。
 *  内容脚本上报登录态时一起捎走 —— 见 content/runner.ts 的 reportLogin。 */
export function lastReadCustomerId(): string | undefined {
  return lastCustomerId;
}

/** 输入:探测用的那一帧 → 输出:无。读得到就记下来,读不到什么都不做。 */
function rememberCustomerId(f: Frame): void {
  try {
    const id = readCustomerId(f.doc());
    if (id) lastCustomerId = id;
  } catch {
    // 跨域/文档没就绪。这一轮没读到,不是"这台机器换号了" —— 不清空。
  }
}

/** 页面等待预算。**值来自 core/config.ts**(可调参数的唯一来源),这里只留一份
 *  兜底默认值:单元测试直接 `new AmazonDriver()` 时用得上。
 *
 *  为什么 T 还是一个模块级对象、而不是实例字段:一个标签页里同一时刻只有一单在跑
 *  (单飞闸在 content/runner.ts,跨标签页那道在 background/service-worker.ts),
 *  所以它事实上是进程内单例;构造函数把配置灌进来,其余步骤照旧读 `T.xxx`。
 *  这样这次改动只落在「下单之后那一段」,不去动清车/加购/填地址那几处。 */
const DEFAULT_TIMEOUTS: Timeouts = { ...DEFAULTS.timeouts };

const T: Timeouts = { ...DEFAULT_TIMEOUTS };

/** 输入:配置里的超时表(可以残缺)→ 输出:无;就地灌进 T。
 *  没给的键回落到默认值 —— 不让上一个实例的设置渗到下一个实例里。 */
function applyTimeouts(t: Partial<Timeouts> | undefined): void {
  const given = t ?? {};
  for (const k of Object.keys(DEFAULT_TIMEOUTS) as Array<keyof Timeouts>) {
    const v = given[k];
    T[k] = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUTS[k];
  }
}

/** 点了下单之后的三段等待。分开计时,各有各的预算与各自的错误码。 */
type OrderWaitPhase = "normal" | "manual_verify" | "post_verify";

const PHASE_BUDGET: Record<OrderWaitPhase, () => number> = {
  normal: () => T.orderConfirm,
  manual_verify: () => T.manualVerify,
  post_verify: () => T.postVerify,
};

/** 露出验证窗口时贴在上面的那句话。**不给关闭按钮**,所以要写清楚
 *  「关掉这个窗口会怎样」——人只有知道后果才不会去关它。 */
const REVEAL_BANNER =
  "Amazon 把这一单转到了发卡行的验证页。请在下面的窗口里完成验证," +
  "完成前不要关闭或刷新本页 —— 超时后这一单会转为待人工,而订单可能已经提交。";

/** 输入:服务端会把这条判成认领超时的**绝对时刻**(没有就是 null)+ 此刻
 *  → 输出:placeOrder 这一段还能等多久。
 *
 *  为什么上界不能由插件自己拍脑袋:服务端的 task_sweep 只看 claimed_at,
 *  插件发再多 step 事件也不会推迟清扫。等过了头的后果是所有结局里最坏的一个 ——
 *  第 15 分钟任务被转成 manual/CLAIM_TIMEOUT,第 16 分钟操作员做完验证、
 *  订单真下成了、单号也读到了,complete 却拿回一个 409 TASK_NOT_HELD,
 *  **钱花了、货发了,系统里是一条没有单号的待人工**。
 *
 *  入参是绝对时刻而不是「认领超时几分钟」:后者会让这本账从点下单那一刻起算,
 *  而清车/加购/填地址前面那几步(上界加起来能到五六分钟)同样记在服务端的
 *  claimed_at 上。起点由 run.ts 在认领之后取,这里只做减法。
 *
 *  服务端那个值配得特别小、或者前面几步已经把预算吃光的时候这里会算出 0 ——
 *  那就只探一次立刻超时,这是对的:那种情况下本来就没有等的余地。
 *
 *  **导出是为了让它有测试。** 这条算式是 §8.3 那句「上界由服务端反推」的本体,
 *  而它整个人在 DOM 夹具那一套之外(纯函数,不碰页面):不导出的话,把它改成
 *  恒取插件自己的上限,typecheck / DOM / unit / pytest 一条都不会红。 */
export function orderHardCapMs(claimDeadlineMs: number | null, now: number): number {
  const own = T.orderHardCap;
  if (claimDeadlineMs === null || !Number.isFinite(claimDeadlineMs)) return own;
  return Math.max(0, Math.min(own, claimDeadlineMs - T.orderServerMargin - now));
}

/** 输入:一次 urlState 读数 → 输出:写进 detail 的中文。
 *
 *  原先这里是 `当前 URL:${f.url()}`,而 url() 把「跨域(人在验证)」
 *  「iframe 已销毁」「URL 真为空」都渲染成空串 —— 运营台上三种完全不同的现场
 *  长成同一句 `当前 URL:`。两种不同的情况渲染出同一个结果就是缺陷。 */
function describeUrl(s: UrlState): string {
  switch (s.kind) {
    case "ok": return `当前 URL:${s.url || "(空)"}`;
    case "cross_origin": return "当前停在跨域页面上(读 location 抛 SecurityError,多半是发卡行验证页)";
    case "detached": return "结算 iframe 已经不存在";
    case "unreadable": return `结算页读不到 URL(${s.name})`;
  }
}

function click(el: Element | null | undefined): boolean {
  if (!el) return false;
  (el as HTMLElement).click();
  return true;
}

/** 给 React 受控输入赋值:直接改 .value 不会触发框架的 onChange。
 *  厂商也是派发 input 事件,这一点他们做对了。 */
function setInput(el: Element | null, value: string): boolean {
  if (!el) return false;
  const input = el as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

export class AmazonDriver implements PageDriver, CartReadReporter {
  readonly name = "amazon";
  readonly ready = true;

  /** 购物车 → 结算页 → 下单,是同一个 iframe 一路跳过来的。 */
  private checkout: Frame | null = null;

  /** 超时表从配置来(见 core/config.Timeouts)。不传就是默认值 —— 单元测试里
   *  `new AmazonDriver()` 照旧能用;生产链路由 content/runner.ts 把 cfg.timeouts 传进来。 */
  constructor(
    private readonly origin: string = "https://www.amazon.com",
    timeouts?: Partial<Timeouts>,
  ) {
    applyTimeouts(timeouts);
  }

  async dispose(): Promise<void> {
    this.checkout?.close();
    this.checkout = null;
  }

  // ── 登录态 ───────────────────────────────────────────────────────
  //
  // 为什么要有这一步:买家号的登录态只存在浏览器 profile 里(我们不申请
  // cookies 权限、不读 Cookie)。号被登出之后,插件照样认领、照样开结算 iframe,
  // Amazon 把它导到 /ap/signin,然后 waitFor 超时 → CHECKOUT_TIMEOUT。
  // 于是「被登出」和「页面慢」渲染成同一个结果:重置多少次都不会好,
  // 而运营台上看不出这个买家号其实已经不能用了。

  /** 开一张轻量页面(购物车)读导航栏。读不出来就是 unknown,**不兜底成 ok**。
   *
   *  **顺手把 customerId 也抠了。** 为什么搭在这一步上而不是另开一次页面:
   *  它就在同一张页面的 HTML 里,而这一步本来就有节制地跑(服务端说
   *  「有单在等 + 上次检查过期了」才跑)。另起一条探测等于给同一个买家号
   *  多一次页面加载,换不来任何新东西。
   *
   *  抠到的值存在模块级的 `lastCustomerId` 里,由内容脚本在上报登录态时一起捎走
   *  (content/runner.ts 的 reportLogin)。**驱动接口不为它改签名** ——
   *  PageDriver.readLoginState 的返回值是「登录态」这一件事,
   *  塞进第二样东西会让模拟驱动、租约测试、看门狗那几处全都要跟着动。 */
  async readLoginState(): Promise<LoginState> {
    return withFrame(URLS.loginProbe(this.origin), async (f) => {
      // 未登录时 Amazon 有可能直接把这一页导到 /ap/signin —— 那条判据比 DOM 还硬,
      // 所以两个条件里任一成立就算"读到了",不必干等满超时。
      try {
        await waitFor("导航栏渲染",
                      () => isSignInUrl(f.url()) ||
                            readLoginState(f.doc()) !== "unknown",
                      { timeoutMs: T.loginProbe, everyMs: 300 });
      } catch {
        // 等不到任何判据。这**是** unknown,不是 ok ——
        // 判不出来时放行是这道闸最容易被写坏的地方。
        rememberCustomerId(f);
        return "unknown";
      }
      rememberCustomerId(f);
      if (isSignInUrl(f.url())) return "signed_out";
      return readLoginState(f.doc());
    }, T.frameLoad);
  }

  /** 每一处超时之前先问一句:是不是被登出了。
   *
   *  抛 LoginLostError 而不是 DriverError —— 上层据此**退回队列**(而不是记异常),
   *  并把这台机器的登录态标成 signed_out 上报。见 flow/driver.LoginLostError 的注释。
   *
   *  **两条判据都读不到时,换一张页面再问一次。** 这不是多此一举,而是这条路上
   *  最可能发生的一种情况:Amazon 的 /ap/signin 普遍带 `X-Frame-Options: DENY`,
   *  被 302 过去之后浏览器**拒绝在 iframe 里渲染它** —— contentDocument 变 null
   *  (f.doc() 抛错)、location 落进不透明源(f.url() 返回空串),于是「URL 落在
   *  登录页」和「DOM 说已登出」两条判据一条都不成立,照旧报 CHECKOUT_TIMEOUT,
   *  「被登出」和「页面慢」又长成同一个样子 —— 而这正是这一整件事要修的东西。
   *
   *  换的那张页面是购物车(readLoginState 走的就是它):未登录也照样渲染导航栏、
   *  不会被 XFO 挡,是这条流里唯一确定读得到的判据来源。
   *
   *  XFO 之后那一帧到底什么样,在 Chromium 141 上实测过,也有 DOM 测试盯着这条兜底
   *  (test/dom.test.mjs 那一节给 /ap/signin 真发一顶 X-Frame-Options: DENY 的帽子)。
   *  ⚠ **没验到的是最后一环:Amazon 的登录页到底发不发 XFO、真机上会不会 302 到别处**
   *  —— 这里没有可登录的买家号。第一次真机验证时专门看一眼:登出后跑一单,
   *  事件流里出现的是「登录态失效,退回队列」还是 CHECKOUT_TIMEOUT。
   *  记在 README「验到了什么、没验到什么」与 docs/03 §5.3。 */
  private async guardLogin(f: Frame, where: string): Promise<void> {
    const url = f.url();
    let out = isSignInUrl(url);
    // 「这一帧还读得到东西吗」。**读不到 ≠ 没被登出** —— 两者分开是这段的全部意义。
    let readable = url !== "";
    if (!out) {
      try {
        out = readLoginState(f.doc()) === "signed_out";
        readable = true;
      } catch {
        // 连 document 都拿不到。这一条判据这次用不上,不下结论。
      }
    }
    if (!out && !readable) {
      out = await this.probeSignedOutElsewhere();
    }
    if (out) {
      throw new LoginLostError(`${where}:买家号已被登出(当前 ${f.url() || "URL 读不到"})`);
    }
  }

  /** 输入:无 → 输出:换一张读得到的页面之后,是不是**确定**被登出了。
   *
   *  只在「当前这一帧整个读不到」时才走这里 —— 那条路今天注定以一个可重试超时
   *  收场,多花一次购物车页加载换一个说得准的结论是划算的;页面只是慢的时候
   *  这一段根本不会被走到(那时 doc/url 读得到)。
   *
   *  探测本身失败(断网、连购物车页也开不出来)时返回 false:**不下结论**,
   *  由调用方原本的错误码去说。宁可少报一次,也不要凭"读不到"就说人家被登出。 */
  private async probeSignedOutElsewhere(): Promise<boolean> {
    try {
      return (await this.readLoginState()) === "signed_out";
    } catch {
      return false;
    }
  }

  // ── 清车 ─────────────────────────────────────────────────────────
  async clearCart(): Promise<void> {
    await withFrame(URLS.cart(this.origin), async (f) => {
      // 先确认购物车页真的渲染出来了。「车是空的」和「车还没渲染」看起来一样
      // (都是 0 行),分不开的话会在一张没加载完的页面上报「已清空」,
      // 而车里那件上一单的残留会被带进这一单。
      //
      // 两组标志都走 pickFirstRendered:Amazon 把空车提示的模板留在 DOM 里
      // (与购物车行模板同一个做法),裸 querySelector 会被那个没画出来的壳子
      // 满足 —— 那就等于这道渲染门只要页面**发过来**就成立,而不是**画出来**才成立。
      try {
        await waitFor("购物车页渲染", () =>
          pickFirstRendered(f.doc(), SEL.cart.cartRendered) !== null ||
          pickFirstRendered(f.doc(), SEL.cart.emptyMarkers) !== null,
          { timeoutMs: 20_000 });
      } catch {
        await this.guardLogin(f, "清空购物车");
        throw new DriverError("PLUGIN_INTERNAL", "购物车页没渲染出来,不能断定车是空的");
      }

      // 上限是防呆:删不动时不能在这里转圈转到天荒地老。
      for (let round = 0; round < 30; round += 1) {
        const st = readCartState(f.doc());
        const before = st.lines.length;
        if (before === 0) {
          // **「车是空的」这个结论要有正面证据。**
          //
          // readCartState 的 0 行有两个来源:车真的空了,或者
          // `[data-name="Active Items"]` 这个容器根本没找到(选择器坏了)。
          // 后者今天会被读成「已清空」然后一路往下走 —— 而车里可能还留着
          // 上一单的东西。下游那道 verifyCart 确实会挡住脏车,但故障现场会被
          // 描述成「插件内部异常」,没人会去查是清车环节骗了自己。
          //
          // 正面证据是两条之一:**容器在、而且容器里一个画出来的商品行都没有**,
          // 或者页面上有确凿的空车标志(.sc-your-amazon-cart-is-empty / #sc-empty-cart)。
          //
          // 「容器在」单独一条不够:行 class 改名、或者行上的 data-asin 换个属性名
          // (与容器改名同一量级的改版),容器照样在、lines 照样是 0 ——
          // 而车里实实在在还留着上一单的商品。rowsSeen 就是这一档的判据。
          //
          // 空车标志**必须走 pickFirstRendered**:裸 querySelector 的话,一个
          // display:none 的空车提示模板(Amazon 的常态,见 cart.html 夹具里那份
          // 靠 CSS 类隐藏的 #sc-empty-cart)就能满足这条「正面证据」,
          // 于是容器改名的那一单被判成「已清空」返回 —— 这道闸要堵的洞原样开着,
          // 而它看起来在。下结论用的判据一律看布局,不看「节点在不在」。
          //
          // 三条判据的**顺序**是有讲究的:看得见行却解析不出,排在空车标志前面。
          // 两者同时成立(空车横幅 + 画出来的商品行)是自相矛盾的一页,
          // 而这时候「车是空的」是危险的那个结论 —— 判错了就拿脏车去结算。
          if (st.scopeFound && st.rowsSeen > 0) {
            // 容器在、里面看得见 N 个商品行,却一行都解析不出 ASIN。
            // 这不是「空车」,是**我们读不懂这一页了**。
            throw new DriverError(
              "PLUGIN_INTERNAL",
              `购物车里看得见 ${st.rowsSeen} 个商品行,却一行都解析不出 ASIN —— ` +
              `行选择器坏了(${SEL.cart.line} / data-asin),不能断定车是空的`);
          }
          const emptyMarker = pickFirstRendered(f.doc(), SEL.cart.emptyMarkers) !== null;
          if ((st.scopeFound && st.rowsSeen === 0) || emptyMarker) return;
          throw new DriverError(
            "PLUGIN_INTERNAL",
            `购物车页没渲染出商品区,「车是空的」这个结论没有正面证据:` +
            `${describeMiss(f.doc(), [SEL.cart.activeItems, ...SEL.cart.emptyMarkers])}`);
        }
        const scope = f.doc().querySelector(SEL.cart.activeItems);
        // 判据与动作用同一条规则:选中的必须是**渲染出来的**那个控件。
        // 隐藏模板里的删除按钮点下去不报错也不生效,然后「行数减少」等满 10 秒。
        const clicked = click(pickFirstRendered(scope ?? f.doc(), SEL.cart.deleteButtons));
        if (!clicked) {
          throw new DriverError(
            "PLUGIN_INTERNAL",
            `购物车里还有 ${before} 件,但找不到删除控件:` +
            `${describeMiss(scope ?? f.doc(), SEL.cart.deleteButtons)}`);
        }
        try {
          await waitFor("购物车行数减少", () => readCartLines(f.doc()).length < before,
                        { timeoutMs: 10_000, everyMs: 300 });
        } catch {
          throw new DriverError("PLUGIN_INTERNAL", "点了删除但购物车行数没变");
        }
      }
      throw new DriverError("PLUGIN_INTERNAL", "清空购物车超过 30 轮仍未清完");
    }, T.frameLoad);
  }

  // ── 加购 ─────────────────────────────────────────────────────────
  async addProduct(asin: string, quantity: number): Promise<AddResult> {
    return withFrame(URLS.product(this.origin, asin), async (f) => {
      // 厂商在这里固定等 2 秒。改成等真正要用的那个元素出现 ——
      // 固定等待在慢页面上等不够,在快页面上白等。
      try {
        // 就绪判据与后面那次点击用**同一条规则**(findAddToCartButton):
        // 判的是可见可用的那个、点的却是隐藏副本,是这类页面上最难查的一种错。
        // 也因此,按钮渲染出来但还没 hydrate(disabled)的那一瞬不算就绪 ——
        // 原先只看「元素在不在」,那一瞬就会往下走,然后点一个不会生效的按钮。
        await waitFor("商品页买家框", () => findAddToCartButton(f.doc()) ||
                                            f.doc().querySelector(SEL.product.outOfStock),
                      { timeoutMs: T.frameLoad });
      } catch (e) {
        // 商品页是这一单第一张要读的页。被登出时它照样打得开(商品页不需要登录),
        // 但导航栏会明说 —— 在这里就发现,比拖到结算页超时省 45 秒。
        await this.guardLogin(f, "打开商品页");
        // **「页面上没有加购按钮」与「按钮在、但一直点不动」是两件事。**
        // 后者(disabled / aria-disabled 一直没解除,或页面上只有隐藏副本)
        // 是这一单买不成,该报 ADD_TO_CART_FAILED;而裸抛 WaitTimeout 会被
        // run.ts 兜成 PLUGIN_INTERNAL —— 那是「插件自己出毛病了」的意思,
        // 会把一单商品侧的问题送到研发那里去。
        if (e instanceof WaitTimeout &&
            SEL.product.addToCart.some((sel) => f.doc().querySelector(sel))) {
          throw new DriverError(
            "ADD_TO_CART_FAILED",
            `${asin} 商品页上有加购按钮,但 ${T.frameLoad}ms 内一直没变成可点状态` +
            `(disabled / aria-disabled 没解除,或页面上只有隐藏副本)`);
        }
        throw e;
      }

      if (!readInStock(f.doc())) {
        throw new DriverError("OUT_OF_STOCK", `${asin} 页面显示 Currently unavailable`);
      }

      const q = findQuantityOption(f.doc(), quantity);
      if (!q.has && quantity !== 1) {
        throw new DriverError("QTY_UNAVAILABLE", `${asin} 没有数量选择器,买不了 ${quantity} 件`);
      }
      if (q.has && !q.matched) {
        throw new DriverError("QTY_UNAVAILABLE", `${asin} 的数量下拉里没有 ${quantity}`);
      }
      if (q.has) {
        // 用与判定同一条挑选规则,免得判的是可见的那个、改的是隐藏副本
        const sel = pickQuantitySelect(f.doc())!;
        sel.value = String(quantity);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const shipperIsAmazon = readProductShipper(f.doc());

      if (!click(findAddToCartButton(f.doc()))) {
        throw new DriverError(
          "ADD_TO_CART_FAILED",
          `${asin} 页面上没有可点的加入购物车按钮:` +
          `${describeMiss(f.doc(), SEL.product.addToCart)}` +
          `(命中但点不动的常见原因是 disabled / aria-disabled —— click() 打上去不报错也不生效)`);
      }

      try {
        await waitFor("加购后跳转到购物车",
                      () => URLS.cartLanding.some((u) => f.url().includes(u)),
                      { timeoutMs: T.addToCart });
      } catch (e) {
        if (e instanceof WaitTimeout) {
          // 加购按钮点下去却弹到登录页,是登录态失效最典型的表现之一。
          await this.guardLogin(f, `加购 ${asin}`);
          // 厂商这条分支只打日志、不通知服务端,任务就悬在那里。
          throw new DriverError("ADD_TO_CART_FAILED", `${asin} 点了加购但页面没跳到购物车`);
        }
        throw e;
      }

      // 保修弹窗:出现就选"不购买"。没出现是常态,不等。
      if (f.doc().querySelector(SEL.product.warrantyPane)) {
        click(f.doc().querySelector(SEL.product.warrantyDecline));
      }
      return { shipperIsAmazon };
    }, T.frameLoad);
  }

  // ── 回读购物车 ───────────────────────────────────────────────────

  /** 上一次 verifyCart 读到的行,给 run.ts 写进 CART_MISMATCH 的现场用(CartReadReporter)。 */
  private cartRead: CartLine[] = [];
  lastCartRead(): CartLine[] { return this.cartRead; }

  /** 车里的东西是不是恰好是本单的东西。
   *
   *  **这里不再等「行数 > 0」。** 原先那个等待条件把「车里一件都没有」
   *  (商品加购后被 Amazon 判不可售自动移除 —— 库存刚被抢完时很常见)
   *  变成一次 15 秒的 WaitTimeout,而 WaitTimeout 不是 DriverError,
   *  run.ts 兜底成 PLUGIN_INTERNAL:真实原因是「购物车与本单不符」,
   *  运营台上却写着「插件内部异常」,按错误码建的处置 SOP 会把它分给研发看插件,
   *  而不是回上游重新报价。0 行本来就该走 cartMatches → false → CART_MISMATCH。
   *
   *  换成四种可分辨的结局:
   *   · 读到行,或页面明说空车     → 立刻按 cartMatches 判(空车 = 不符)
   *   · 容器在、里面一行都看不见   → 等满窗口后同样按 cartMatches 判(不符)
   *   · 容器在、看得见行却解析不出 → 行选择器坏了,回读不算数 → PLUGIN_INTERNAL
   *   · 连容器带空车标志都没有     → 这一页压根没渲染,回读不算数 → PLUGIN_INTERNAL
   */
  async verifyCart(expected: Array<{ asin: string; quantity: number }>): Promise<boolean> {
    this.checkout?.close();
    this.checkout = await openFrame(URLS.cart(this.origin), T.frameLoad);
    const f = this.checkout;
    this.cartRead = [];

    const st = await waitFor("购物车回读", () => {
      const got = readCartState(f.doc());
      if (got.lines.length > 0) return got;
      // 页面明说「车是空的」也是一种确定的读数,不必等满 15 秒。
      // 同样走 pickFirstRendered:openFrame 只等到 readyState !== loading,
      // 购物车行常是客户端渲染的 —— 这一拍页面上很可能只有那个还没画出来的
      // 空车模板。认它就等于每一单都在 t≈0 拿一份空读数去判 CART_MISMATCH。
      if (pickFirstRendered(f.doc(), SEL.cart.emptyMarkers) !== null) return got;
      return null;
    }, { timeoutMs: 15_000 }).catch(() => null);

    const final = st ?? readCartState(f.doc());
    // 0 行有四个来源,只有前两个可以拿去和本单比对。判据按「我们到底读到了什么」
    // 排,而不是按「waitFor 有没有超时」—— 后者只说明等没等到,不说明读到了什么。
    if (final.lines.length === 0) {
      if (final.scopeFound && final.rowsSeen > 0) {
        await this.guardLogin(f, "回读购物车");
        throw new DriverError(
          "PLUGIN_INTERNAL",
          `购物车页看得见 ${final.rowsSeen} 个商品行,却一行都解析不出 ASIN —— ` +
          `行选择器坏了(${SEL.cart.line} / data-asin),回读不算数`);
      }
      if (!final.scopeFound && pickFirstRendered(f.doc(), SEL.cart.emptyMarkers) === null) {
        await this.guardLogin(f, "回读购物车");
        throw new DriverError(
          "PLUGIN_INTERNAL",
          `购物车页没渲染出商品区,回读不算数:` +
          `${describeMiss(f.doc(), [SEL.cart.activeItems, ...SEL.cart.emptyMarkers])}`);
      }
    }
    this.cartRead = final.lines;
    return cartMatches(final.lines, expected);
  }

  // ── 去结算 ───────────────────────────────────────────────────────
  async proceedToCheckout(): Promise<void> {
    const f = this.need();
    if (!click(f.doc().querySelector(SEL.cart.proceed))) {
      throw new DriverError("PLUGIN_INTERNAL", "购物车页找不到结算按钮");
    }
    await this.waitForFinalCheckout(f);
  }

  /** Amazon 会插中间页(byg/byc)。到了就再点一次,最多两次。
   *  URL 要求连续稳定 3 次 —— 重定向链里会短暂命中中间态。 */
  private async waitForFinalCheckout(f: Frame): Promise<void> {
    // 记住点击前停在哪一页。不记的话,「连续三次 URL 相同」会被**还没跳走的那一页**
    // 满足 —— 点完继续按钮才 800ms,页面正在提交,URL 当然还没变,
    // 于是这一 hop 直接判成"稳定了",再点一次继续。三个 hop 在 2.4 秒里被吃光,
    // 45 秒的预算一秒都没用上,而中间页的继续按钮被连点了三次(有重复提交风险)。
    let from = f.url();
    for (let hop = 0; hop < 3; hop += 1) {
      try {
        // 盯 URL 本身连续三次不变,而不是盯它的分类 ——
        // 否则在两个中间页之间来回跳也会被当成"稳定了"。
        await waitStable("跳到结算页",
                         () => {
                           const u = f.url();
                           if (u === from) return null;   // 还没离开点击前那一页
                           const hit = u.includes(URLS.finalCheckout) ||
                                       URLS.interstitial.some((x) => u.includes(x));
                           return hit ? u : null;
                         },
                         3, { timeoutMs: T.checkoutNav, everyMs: 400 });
      } catch {
        // **这就是这一整件事的起点。** 被登出时 Amazon 把结算跳转导去 /ap/signin,
        // 这里等不到最终结算页,原先一律报 CHECKOUT_TIMEOUT(RETRYABLE)——
        // 「被登出」和「页面慢」于是渲染成同一个结果,重置多少次都不会好。
        await this.guardLogin(f, "跳转结算页");
        throw new DriverError("CHECKOUT_TIMEOUT", `等结算页超时,当前 URL:${f.url()}`);
      }
      if (f.url().includes(URLS.finalCheckout)) return;
      from = f.url();          // 下一 hop 要离开的是这张中间页
      if (!click(findInterstitialButton(f.doc()))) {
        throw new DriverError("CHECKOUT_TIMEOUT", `卡在中间页且找不到继续按钮:${f.url()}`);
      }
    }
    throw new DriverError("CHECKOUT_TIMEOUT", "中间页跳了三次仍未到最终结算页");
  }

  // ── 填地址 ───────────────────────────────────────────────────────
  async fillAddress(shipping: Shipping): Promise<void> {
    const f = this.need();
    const doc = () => f.doc();

    // 结算页上已经有姓名框 = 这个买家号一条地址都没有,Amazon 直接给了内联表单。
    // 走 findAddressFormNameField 而不是裸 querySelector:隐藏模板里也有这个 id,
    // 取到它就会跳过整段「换地址 → 新建」,然后往一个没人看的 DOM 里填字。
    if (!findAddressFormNameField(doc())) {
      // ── 第 1 步:点结算页上的「更改收货地址」 ──────────────────────
      //
      // 入口选择器有四条(见 selectors.address.changeAddress),全部走 isRendered。
      // **click 的返回值必须看。** 原先这里是裸 `click(querySelector(...))`:
      // 入口选择器一失效就静默什么都不做,然后白等 30 秒报 ADDRESS_FORM_TIMEOUT ——
      // 一个可重试码,而这类失败重试多少次都一样。同一个文件里加购、结算、
      // 中间页、地址建议、下单五处都写成 `if (!click(...)) throw`,唯独这里没有。
      //
      // 等待条件里也带上「内联表单」:刚跳到结算页时地址面板可能还没画完,
      // 而买家号没有任何地址时 Amazon 给的就是内联表单 —— 这两种都要能接住。
      const entry = await waitFor("更改地址入口", () => {
        if (findAddressFormNameField(doc())) return "inline" as const;
        return findAddressChangeEntry(doc());
      }, { timeoutMs: T.addressForm }).catch(() => null);

      if (entry === null) {
        await this.guardLogin(f, "打开地址区");
        // 这一句就是「选择器坏了」与「页面慢」的分界:全落空 = 改版,
        // 命中但没渲染 = 页面还没画完。两者在运营台上必须长得不一样。
        throw new DriverError("ADDRESS_FORM_TIMEOUT",
                              `结算页找不到可点的更改地址入口:` +
                              `${describeMiss(doc(), SEL.address.changeAddress)}`);
      }

      // entry === "inline" 时表单就在眼前,不用点任何东西,直接往下填。
      if (entry !== "inline") {
        if (!click(entry)) {
          throw new DriverError("ADDRESS_FORM_TIMEOUT", "更改地址入口点不动(元素在但 click 没生效)");
        }

        // ── 第 2 步:确认这一下**真的产生了效果** ───────────────────
        //
        // 这一步原先没有,而它是整段最要命的地方:紧接着的「地址区加载」
        // 判据(`[aria-labelledby="delivery-addresses-section-header-id"]`)会被
        // 结算页上**折叠着的地址簿**立刻满足 —— waitFor 的第一次探测是同步的,
        // 连一个周期都不等。于是我们在还没跳走的结算页上,去点折叠容器里那个
        // 不可见的「新建地址」,click 不报错也不跳转,此后 30 秒等一个永远不会
        // 出现的表单。净效果:**只要买家号地址簿里有历史地址(常态),
        // 每一单都 ADDRESS_FORM_TIMEOUT。**
        //
        // 两条判据任一成立都算「产生了效果」,因为这个入口有两种落地形态:
        //   · 整页跳到 /checkout/p/p-…/address(厂商 v2.5.3 走的就是这条)
        //   · 就地弹一个模态框(findings.md:45 记的 checkout-view-modal / isAsync)
        // 只认 URL 会把模态框那种判成失败;只认地址区就是原来那个坑 ——
        // 所以关键不在选哪一条,而在**地址区必须是渲染出来的那个**(findAddressSection
        // 走 isRendered),折叠的地址簿满足不了它。
        const moved = await waitFor("更改地址生效", () => {
          if (f.url().includes(URLS.addressSelect)) return "url" as const;
          if (findAddressSection(doc())) return "section" as const;
          return null;
        }, { timeoutMs: T.addressForm, everyMs: 300 }).catch(() => null);

        if (moved === null) {
          await this.guardLogin(f, "跳到地址选择页");
          throw new DriverError("ADDRESS_FORM_TIMEOUT",
                                `点了更改地址,但既没跳到地址选择页、也没就地渲染出地址区,` +
                                `当前 URL:${f.url() || "读不到(跨域或文档未就绪)"}`);
        }

        // ── 第 3 步:URL 换了但页面还在画时,等地址列表区 ─────────────
        if (moved === "url") {
          try {
            await waitFor("地址区加载", () => findAddressSection(doc()),
                          { timeoutMs: T.addressForm });
          } catch {
            await this.guardLogin(f, "打开地址区");
            throw new DriverError("ADDRESS_FORM_TIMEOUT",
                                  `已经到了地址选择页,但没等到地址列表区:` +
                                  `${describeMiss(doc(), [SEL.address.section])}`);
          }
        }

        // ── 第 4 步:点「新增地址」 ─────────────────────────────────
        //
        // 我们**一律新建、不复用地址簿里已有的条目**(理由写在
        // selectors.address.addNew 的注释里)。这个 id 在结算页折叠的地址簿里
        // 也有一份,所以这里同样走 isRendered。
        const addNew = await waitFor("新增地址入口", () => findAddNewAddressEntry(doc()),
                                     { timeoutMs: T.addressForm }).catch(() => null);
        if (!addNew || !click(addNew)) {
          throw new DriverError("ADDRESS_FORM_TIMEOUT",
                                `地址选择页找不到可点的新建地址入口:` +
                                `${describeMiss(doc(), [SEL.address.addNew])}`);
        }

        // ── 第 5 步:等那张**异步注入**的表单 ────────────────────────
        //
        // 地址选择页本身**不含姓名输入框**(厂商 findings.md:45 的实测结论),
        // 表单是点完入口之后才注入的。走到这里入口都点到了、页面也换过了,
        // 所以这一条超时是货真价实的「慢」,不是「选择器坏了」。
        try {
          await waitFor("新建地址表单", () => findAddressFormNameField(doc()),
                        { timeoutMs: T.addressForm });
        } catch {
          throw new DriverError("ADDRESS_FORM_TIMEOUT",
                                `点了新建地址,但表单在 ${T.addressForm}ms 内没注入出来` +
                                `(入口点到了、页面也换过了 —— 这一条是页面慢,不是选择器坏了):` +
                                `${describeMiss(doc(), [SEL.address.fullName])}`);
        }
      }
    }

    // **每一格都走 pickFirstRendered,不用裸 querySelector。**
    //
    // Amazon 的地址表单是从隐藏模板克隆出来的,页面上常同时挂着一份 display:none
    // 的副本,字段 id 一模一样,而且**排在真身前面**,里面还预填着上一次用过的
    // (也就是别人的)地址。裸 querySelector 会往那一份里写字:setInput 不报错,
    // 保存按钮点下去什么都没发生 —— 表现是 30 秒后 ADDRESS_FORM_TIMEOUT,
    // 而地址其实一个字都没填进去。更坏的分支是模板里预填的地址被 Amazon 采用,
    // 那就是把货寄给别人,而 ADDRESS_NOT_APPLIED 那道校验读的是同一份页面文本,
    // 未必拦得住。
    const field = <T extends Element>(sel: string): T | null =>
      pickFirstRendered<T>(doc(), [sel]);

    const nameField = field<HTMLInputElement>(SEL.address.fullName);
    if (!nameField) {
      throw new DriverError("ADDRESS_FORM_TIMEOUT",
                            `地址表单不见了:${describeMiss(doc(), [SEL.address.fullName])}`);
    }
    setInput(nameField, shipping.name);
    setInput(field(SEL.address.phone), shipping.phone);
    setInput(field(SEL.address.line1), shipping.line1);
    setInput(field(SEL.address.line2), "");
    setInput(field(SEL.address.city), shipping.city);
    setInput(field(SEL.address.postal), shipping.postcode);

    const stateSel = field<HTMLSelectElement>(SEL.address.state);
    if (!stateSel) throw new DriverError("ADDRESS_FORM_TIMEOUT", "地址表单没有州下拉");
    const want = shipping.state.trim().toLowerCase();
    const opt = Array.from(stateSel.options).find(
      (o) => o.value.trim().toLowerCase() === want || o.text.trim().toLowerCase() === want,
    );
    if (!opt) {
      throw new DriverError("ADDRESS_STATE_UNMATCHED", `州下拉里没有 ${shipping.state}`);
    }
    stateSel.value = opt.value;
    stateSel.dispatchEvent(new Event("change", { bubbles: true }));

    // 保存按钮同样要挑渲染出来的那个:模板副本里也有一个同 id 的。
    // 注意这里从 doc() 取而不是从表单里取 —— SEL.address.save 带
    // `#pagelet-layout-section` 前缀,那是表单的**祖先**,在表单子树里查不到。
    // 点保存**之前**先记住收货地址栏现在写的是什么。
    //
    // 「页面上有收货地址栏」不等于「这次保存生效了」:更改地址有一种形态是
    // 就地弹窗(不跳 /address),那条路上文档一直是结算页,而结算页上本来就有
    // 生效中的旧地址栏。不比对文本的话,点完保存的第一拍就判 saved,
    // 校验提示与地址建议弹窗整段处理被跳过 —— 弹窗还挡着,地址一个字没换,
    // 而下游 ADDRESS_NOT_APPLIED 会把它说成「Amazon 用了地址簿里别的地址」。
    // 这一份快照就是「这次保存」与「页面上本来就有」之间的全部区别。
    const addressTextBefore = readAppliedAddressText(doc());

    const save = () => click(pickFirstRendered(doc(), [SEL.address.save]));
    if (!save()) {
      throw new DriverError("ADDRESS_FORM_TIMEOUT",
                            `地址表单上找不到保存按钮:${describeMiss(doc(), [SEL.address.save])}`);
    }

    // ── 保存之后会出现三种结果之一,**谁先出现就处理谁** ──────────────
    //
    // 原先这里是「两轮弹窗对抗」:sleep(1200) 之后**只看一次**校验提示,
    // 再 sleep(1200) 之后**只看一次**地址建议弹窗 —— 那是定时快照,不是轮询。
    // 弹窗晚出现 200ms 就整单失败:我们在 t≈2.4s 那一眼没看见,直接去等
    // #deliver-to-address-text,而弹窗正挡着保存 → 30 秒后 ADDRESS_FORM_TIMEOUT。
    // 同一个订单换一次网络抖动就可能变成成功 —— 这种「时快时慢」的失败最难查,
    // 而且失败时地址其实已经填好了,重试还要从头再来一遍。
    // (这一处厂商 v2.5.3:3409-3455 比我们稳:他们两处都是 6 轮 × 500ms 的轮询。)
    //
    // 整段共用**一个**预算 T.addressSave:每一轮 waitFor 只拿剩下的时间,
    // 所以无论走几轮,「保存 → 地址生效」这一段的总耗时上界不变(任何等待都必须有界)。
    // 轮数上限 3 是防呆:校验提示一直不消失时不能在这里空转。
    //
    // **每一轮动作之后要等的是「状态真的变了」,不是「再读一次同一个状态」。**
    // waitFor 的第一次探测是同步的(dom/wait.ts):选完原始地址、点完保存之后
    // 立刻重读,读到的必然还是刚才那个弹窗 —— 表单提交不可能在同一拍就生效。
    // 不带这一条的话,三轮在同一毫秒里烧光(实测 t=2702ms 结束、保存按钮被点了
    // 4 次、30 秒预算用掉 9%),最后一次保存的结果**从来没有被等过**,
    // 而抛出来那句「校验提示/建议弹窗反复出现」一次都没等过,是假的。
    // 于是探针带上 prev:与上一轮已经处理过的结果相同 = 页面还没反应过来,继续等。
    const deadline = Date.now() + T.addressSave;
    const left = () => Math.max(0, deadline - Date.now());
    /** 上一轮已经动过手的那个结果。再读到它不算新结果。 */
    let prev: AddressSaveOutcome | null = null;
    const nextOutcome = () =>
      waitFor("地址保存结果", () => {
        const o = readAddressSaveOutcome(doc(), addressTextBefore);
        return o !== null && o !== prev ? o : null;
      }, { timeoutMs: left(), everyMs: 300 }).catch(() => null);

    let settled = false;
    let acted = 0;                       // 对校验提示/建议弹窗动过几次手
    for (let round = 0; round < 3 && !settled; round += 1) {
      const hit = await nextOutcome();
      if (hit === "saved") { settled = true; break; }
      if (hit === null) break;           // 预算用完了,下面统一报错
      prev = hit;
      acted += 1;
      if (hit === "suggestion") {
        // 选**原始地址**那一项:上游给什么就寄什么,不让 Amazon 替我们改收件地址。
        const radio = pickFirstRendered(doc(), [`${SEL.address.suggestionPopup} input[type=radio]`]);
        if (!click(radio)) {
          throw new DriverError("ADDRESS_SUGGESTION_BLOCKED", "地址建议弹窗里选不到原始地址");
        }
      }
      // 校验提示则是再点一次保存(Amazon 常在第一次提交时补全/规范化字段)。
      // **save() 的返回值必须看**:保存按钮不见了还接着往下等,等的是一个
      // 永远不会来的结果,最后报一个与真实原因无关的超时。
      if (!save()) {
        throw new DriverError(
          "ADDRESS_FORM_TIMEOUT",
          `${hit === "alerts" ? "校验提示" : "地址建议弹窗"}还在,但保存按钮找不到了:` +
          `${describeMiss(doc(), [SEL.address.save])}`);
      }
    }

    // 最后一次动作之后还要有一次「等结果」的机会 —— 少了它,那一次点击的结果
    // 永远看不到,而它恰恰最可能就是成功的那一次(前面每一轮都是为它铺路)。
    if (!settled && acted > 0 && left() > 0) {
      settled = (await nextOutcome()) === "saved";
    }

    if (!settled) {
      // 三种收场要说三句不一样的话,不然运营台上分不出该找谁。
      const now = readAppliedAddressText(doc());
      const state = now === null
        ? "页面上始终没有收货地址栏"
        : now === addressTextBefore
          ? `收货地址栏还是保存之前那条(「${now.slice(0, 60)}」)`
          : `收货地址栏此刻是「${now.slice(0, 60)}」`;
      throw new DriverError(
        "ADDRESS_FORM_TIMEOUT",
        acted === 0
          ? `点了保存,但 ${T.addressSave}ms 内既没出现收货地址栏,` +
            `也没出现校验提示或地址建议弹窗(${state})`
          : `点了保存,处理了 ${acted} 次校验提示/地址建议弹窗,` +
            `${T.addressSave}ms 的预算里仍没等到地址生效(${state})`);
    }

    // 填完不等于生效。Amazon 可能仍然用着地址簿里原来那条 ——
    // 那就会把货寄到别人家去,后果和实付超限价一样严重,必须当场发现。
    // 厂商只做了「地址文本含邮编」这一条子串判断,姓名/街道/城市/州一概不校验。
    // 同样走 readAppliedAddressText:这一栏也可能有隐藏的第二份,
    // 读到那一份就是拿一段与本单无关的地址去判「寄给谁」。
    const applied = readAppliedAddressText(doc()) ?? "";
    const zip = shipping.postcode.split("-")[0];   // 页面常只显示 ZIP5,下发的可能是 ZIP+4
    const lower = applied.toLowerCase();
    const has = (v: string) => lower.includes(v.trim().toLowerCase());
    const missing: string[] = [];
    // 只比邮编和城市不够:同城不同街道、甚至同城同邮编的另一个人,
    // 这两项都能对上。收件人姓名与街道才是真正区分"寄给谁"的东西。
    // 厂商只做了「地址文本含邮编」一条子串判断,姓名/街道/城市/州一概不校验。
    if (!applied.includes(zip)) missing.push(`邮编 ${zip}`);
    if (!has(shipping.city)) missing.push(`城市 ${shipping.city}`);
    if (!has(shipping.state)) missing.push(`州 ${shipping.state}`);
    if (!has(shipping.name)) missing.push(`收件人 ${shipping.name}`);
    // 街道只比第一个 token(门牌号):Amazon 会把 "St" 规范成 "Street"、
    // 大小写和缩写都可能变,整串比会误报;门牌号不会变。
    const houseNo = shipping.line1.trim().split(/\s+/)[0];
    if (houseNo && !applied.includes(houseNo)) missing.push(`街道 ${houseNo}`);
    if (missing.length) {
      throw new DriverError("ADDRESS_NOT_APPLIED",
                            `收货地址栏里没有 ${missing.join(" / ")},当前是「${applied.slice(0, 80)}」`);
    }
  }

  // ── 读结算页 ─────────────────────────────────────────────────────
  async readCheckout(): Promise<CheckoutReading> {
    const f = this.need();
    try {
      await waitFor("结算页商品面板",
                    () => readCheckoutPanels(f.doc()).length > 0,
                    { timeoutMs: T.checkoutNav });
    } catch {
      await this.guardLogin(f, "读结算页");
      throw new DriverError("CHECKOUT_TIMEOUT", "结算页商品面板没渲染出来");
    }

    const panels = readCheckoutPanels(f.doc());

    // 有面板读不出交期 = 有一件商品的交期未知。
    // 少报一条会让服务端只对看得懂的那几条取最晚(price_guard.adjudicate),
    // 于是「读不懂的那条其实更晚」时会放行一单不该放的 ——
    // 而服务端那条「有一条读不懂就整单转人工」的策略,因为它压根没收到那一条,
    // 在真实链路上根本不成立。与下面「读不到总额就绝不下单」同一个立场。
    const blind = panels.filter((p) => !p.deliveryText).length;
    if (blind) {
      throw new DriverError("DELIVERY_UNPARSEABLE",
                            `${blind}/${panels.length} 个商品面板读不到交期文案`);
    }

    const total = readGrandTotal(f.doc());
    if (total === undefined) {
      // 读不到总额就绝不下单。
      throw new DriverError("CHECKOUT_TIMEOUT", "结算页读不到订单总额");
    }
    const gift = readGiftCardDeduction(f.doc());
    // 礼品卡抵扣把「这张卡要扣多少」和「这一单要花多少」拆成了两个数。
    // 护栏比的是后者 —— 全额抵扣时前者是 0.00,拿它比限价等于护栏不存在。
    // 服务端会自己再算一遍并以自己的为准,这里算是为了两边不一致时看得见。
    const goodsTotal = gift.applied && gift.amount !== undefined
      ? (Number(total) + Number(gift.amount)).toFixed(2)
      : (gift.applied ? undefined : total);

    // **0 和负数在插件这一侧就挡掉。**
    //
    // 结算页金额还在 shimmer、或者那一格短暂显示 $0.00 时读到的就是这种数。
    // 服务端也有同一道闸(price_guard 比的是货款,0 一律拒),但那一档报的是
    // PLUGIN_INTERNAL、转异常;在这里挡住报 CHECKOUT_TIMEOUT —— 它本来就是
    // 可重试的,shimmer 那种情况重试一次就好,不必为它开一张异常单。
    //
    // 判的是**货款**不是实付:礼品卡全额抵扣的单实付确实是 0.00,那是对的。
    // 礼品卡认出来了但金额读不出来(goodsTotal 是 undefined)不在这里拦 ——
    // 那一档要让服务端拒并留痕,插件自己吞掉的话运营看不见发生过什么。
    const giftAmountUnknown = gift.applied && gift.amount === undefined;
    if (!giftAmountUnknown && !(Number(goodsTotal) > 0)) {
      throw new DriverError("CHECKOUT_TIMEOUT",
                            `结算页货款读成 ${goodsTotal}(实付 ${total}` +
                            `${gift.applied ? `,礼品卡抵扣 ${gift.amount}` : ""}),` +
                            "这个数不可信,不下单");
    }

    const summary = readOrderSummary(f.doc());

    // 有一个面板明确不是 Amazon 发货,整单就不是 FBA。
    // 全都读不到才返回 null(未知),交给服务端按 require_fba 处置。
    const known = panels.map((p) => p.isFba).filter((v): v is boolean => v !== null);
    const isFba = known.length === 0 ? null : known.every(Boolean);

    const priced = panels.filter((p) => p.asin && p.unitPrice);

    return {
      actualTotal: total,
      giftCard: { applied: gift.applied, amount: gift.amount },
      goodsTotal,
      actualShipping: summary.shipping,
      actualTax: summary.tax,
      deliveryTexts: panels.map((p) => p.deliveryText as string),
      isFba,
      paymentLast4: readPaymentLast4(f.doc()),
      // 槽位数与卡尾号是两个事实:后者只答得出第一个槽位里那张卡。
      // 拆分支付(公司卡 + 另一张)时第一张对得上就放行,第二张刷了多少
      // 这道闸完全不知道 —— 数出来交服务端裁决,插件自己不拦。
      paymentSlots: readPaymentSlots(f.doc()),
      // 只报**读到的**单价。数量结算页上没读(报告说厂商那道数量校验是死代码,
      // 真正的数量比对在购物车页已经做过),所以不在这里编一个 1 出来。
      unitPrices: priced.map((p) => ({ asin: p.asin!, unit_price: p.unitPrice! })),
      // **少读到一条 ≠ 这单只有一条**,那是选择器坏了。
      //
      // 原先这里只是 .filter 一下就过去了:Amazon 换个类名,unitPrices 静默
      // 变成空数组,护栏照跑(它比的是整单金额,走另一个选择器),
      // 单子照下,只有运营台上「实付单价」那一列悄悄全空 —— 没有任何地方报错,
      // 等有人觉得不对已经是几百单之后。这和 deliveryTexts 那次是同一类问题。
      //
      // 判据从「一个都没读到」放宽成「读到的条数 < 面板数」:实测两件商品的单
      // 只有第一个面板的单价选择器还生效时,priced.length=1 不为 0,
      // 这条告警**不触发**,而库里那一件的 actual_unit_price 就是 NULL,
      // 运营台上「实付单价」半列空着,没有任何事件说明为什么。
      // 半坏和全坏是同一件事(Amazon 改版),不该只有全坏时才说话。
      //
      // 不中断下单:限价护栏不依赖单价,为一个展示字段掀翻一次采购更糟。
      // 但要让它在事件流里留下痕迹。
      unitPriceSelectorBroken: panels.length > 0 && priced.length < panels.length,
    };
  }

  // ── 替买家号切换支付卡(所有者定稿①,2026-09-09)──────────────────
  //
  // **先切后验,验在服务端。** 这一段只做「切」:读结算页之后、报护栏之前,
  // 按服务端下发的 guards.expected_card_last4 把卡换过去。切没切成不由这里
  // 说了算 —— run.ts 切完会重新 readCheckout,服务端 guard-check 拿那一遍
  // 重新读到的尾号自己判(price_guard 那道 PAYMENT_METHOD_UNEXPECTED 一个字没改)。
  //
  // 判据全部来自 SEL.checkout.payselect,那是**厂商按截图推的**(他们自己承认
  // 支付选择页没有 DOM 样本),可信度是全仓最低的一档。所以这一段的形状是
  // **五步、每步有界、每步 fail-closed、每步说得出自己停在哪**:
  //
  //   ① 入口没找到          ② 选卡页没到      ③ 没有唯一命中的那张卡
  //   ④ 确认按钮不可用       ⑤ 切完读到的仍不是期望
  //
  // 五种停法在 detail 里必须分得开:①② 是改版要改代码,③ 是这个买家号钱包里
  // 没那张卡(或者有两张同尾号的),④⑤ 要人去看一眼页面。今天它们共用一个
  // 错误码(PAYMENT_METHOD_UNEXPECTED,归 BUSINESS_BLOCKED、不自动重试),
  // 那一句「切支付卡停在「xxx」」就是运营台上唯一能把它们分开的东西。
  //
  // **五步的每一处「等满了预算」之前都先问一句 guardLogin。** 切卡途中会话过期
  // (Amazon 把 iframe 导去 /ap/signin)在这里的表现全都是「等不到」,而这一段
  // 抛的 PAYMENT_METHOD_UNEXPECTED 是 BUSINESS_BLOCKED、不可自动重试、也不上报
  // signed_out —— 那会让一台已经登出的机器把整队单子刷成「支付卡不符」。
  // 「点不动」那两支不问:元素找着了、也渲染出来了,页面就是我们这一张,
  // 不是登录页;为它多读一遍页面只会把一个说得清的失败拖慢。
  //
  // 为什么整段都用 PAYMENT_METHOD_UNEXPECTED 而不新开一个码:错误码是封闭集
  // (docs/01 §4 ↔ services/error_codes.py ↔ core/codes.ts,有测试盯着),
  // 而这五种停法的处置与「结算页那张卡不是期望的那张」完全一致 ——
  // 不自动重试、不转人工、去改配置或去买家号里把卡准备好。多开一个码要跨三处
  // 改封闭集,换来的区分度已经在 detail 里了。
  async ensurePaymentCard(
    expected: string | null | undefined,
    hooks: PaymentCardHooks = {},
  ): Promise<PaymentCardResult> {
    const f = this.need();
    const doc = () => f.doc();

    // **期望为空 = 一步都不做。** 连结算页都不多读一遍:这个买家号的语义是
    // 「不校验也不切」,任何多余的动作都是在没被授权的情况下动别人的支付配置。
    //
    // last4 直接给 null,**不是** readPaymentLast4(doc()):`doc()` 在结算 iframe
    // 已经跨域/已被销毁时是**抛错**的(frame.ts:129),而这一档抛出来的是一个裸
    // Error,run.ts 只能把它兜成 PLUGIN_INTERNAL —— 一个**根本没配期望卡**的
    // 买家号,因为一个按定义什么都不做的步骤而失败。这一位调用方也不用:
    // run.ts 只看 switched,switched=false 时那一份读数没有任何人读。
    // 契约(driver.ts)写着这一档「不读任何东西」,那句话得是真的。
    const want = (expected ?? "").trim();
    if (!want) return { last4: null, switched: false };

    // 配成了别的形状(填了 "**** 4417"、"4417 Visa"、四位以外的数字)。
    // **不猜、也不当成"不校验"**:当成不校验的话,一格填错的配置会让这个
    // 买家号从此每一单都不再过支付闸,而运营台上那一格看起来是配好了的
    // ——「配了但无效」与「故意留空」渲染成同一个结果,正是这套系统最不许有的事。
    if (!/^\d{4}$/.test(want)) {
      throw new DriverError("PAYMENT_METHOD_UNEXPECTED",
                            `买家号配的期望卡尾号「${want}」不是四位数字,不敢照着切 —— ` +
                            "请在运营台买家号那一页把它改成四位数字,或者清空(清空 = 不校验也不切)");
    }

    // 类型写在变量上(而不是只写在箭头函数的返回值上)是必要的:TypeScript
    // 只有这样才把 stop(...) 之后的代码当成不可达,下面 `hit` 才不用再判一次 null。
    const stop: (stage: string, detail: string) => never = (stage, detail) => {
      throw new DriverError("PAYMENT_METHOD_UNEXPECTED",
                            `切支付卡停在「${stage}」:${detail}`);
    };

    /** 拼 detail 时用的「读不到就算了」。**这一段的每一处取数都要走它。**
     *
     *  五种停法的 detail 里全都还要**再读一次 `doc()`**(数一遍 radio、
     *  再读一次当前卡号、describeMiss 要一个 document),而 `doc()` 在结算 iframe
     *  已经跨域 / 已被销毁时是**抛**的。抛出来的是一个没有 ErrorCode 的裸 Error,
     *  run.ts 只能把它兜成 `PLUGIN_INTERNAL` —— 而那是**可重试**的一组,
     *  开了 AMZ_AUTO_RETRY_MAX 的库会自动重拍这一单;`PAYMENT_METHOD_UNEXPECTED`
     *  归 BUSINESS_BLOCKED,明确不该重。更要紧的是那句「切支付卡停在「xxx」」
     *  整句消失 —— 而它是运营台上唯一能把五种停法分开的东西(docs/01 §5.3 与
     *  driver.ts 的契约都这么写),运营台上只剩「插件内部异常 · iframe 拿不到 document」。
     *
     *  实测过两种现场(Playwright + payselect 夹具):一种 url() 还读得到、
     *  `doc()` 已经抛;一种 urlState 真的 detached、兜底探测判定「还登着」——
     *  两次都拿到裸 Error。49cdda0 为「期望为空」那一档修的是同一个坑,五处 stop 没修。 */
    const safe = <T,>(f2: () => T, dflt: T): T => {
      try { return f2(); } catch { return dflt; }
    };
    /** 帧此刻还读不读得到。读不到时 detail 里要多说一句 —— 否则「页面上真没有
     *  这个按钮」与「页面已经读不到了」在运营台上长成同一句话。 */
    const frameGone = () => { try { doc(); return false; } catch { return true; } };
    const alsoGone = () => (frameGone() ? ";**而且此刻结算 iframe 已经读不到了**" : "");

    const now = () => readPaymentLast4(doc()) ?? null;
    const from = now();
    // 本来就是那张 —— 什么都不做。这是最常见的一条路(买家号平时就配着那张卡),
    // 它必须比"切一遍再说"便宜:多点一次入口就多一次点错链接的机会。
    if (from === want) return { last4: from, switched: false };

    await hooks.onSwitchStart?.({ from, to: want });

    /** 此刻页面上渲染出来的卡片单选钮有几个。判「到没到选卡页」与写失败 detail 都要它。 */
    const radioCount = () => Array.from(doc().querySelectorAll(SEL.checkout.payselect.radio))
      .filter((el) => isRendered(el)).length;

    // ── ① 结算页支付面板里的「更改支付方式」入口 ─────────────────────
    const panel = () => pickFirstRendered(doc(), [SEL.checkout.payment.panel]) ?? doc();
    const entry = await waitFor("更改支付方式入口", () => findPaymentChangeEntry(doc()),
                                { timeoutMs: T.paymentSelect }).catch(() => null);
    if (!entry) {
      // 与填地址那一步同一条规矩:先问一句是不是被登出了。被登出的话这一单
      // 该退回队列(还没花钱),而不是记成一次「支付卡不符」的拍单异常。
      await this.guardLogin(f, "打开支付选择页");
      stop("入口没找到",
           `结算页当前选中的是 ${from ?? "读不出来"},要切到 ${want};` +
           `支付面板里${safe(() => describeMiss(panel(), SEL.checkout.payment.changeEntry),
                            "(页面已读不到,数不出来)")}` + alsoGone());
    }
    // **点之前先记一笔现场。** 下面那道「到没到选卡页」的判据要拿它做对照,
    // 理由见第 ② 步。记在 click 之前,不是之后。
    const radiosBefore = radioCount();
    if (!click(entry)) {
      stop("入口没找到", "更改支付方式入口点不动(元素在、也渲染出来了,但 click 没生效)");
    }

    // ── ② 等支付选择页 ──────────────────────────────────────────────
    //
    // 这一步防的是填地址那一步踩过的那个坑:**判据被我们还没离开的那张页面
    // 立刻满足**。waitFor 的第一次探测是同步的,连一个周期都不等 ——
    // 那次的表现是「在还没跳走的结算页上点折叠容器里的按钮」,此后等一个
    // 永远不会出现的表单,净效果是每一单都超时。
    //
    // 所以判据是两条,而且第二条带对照:
    //   · URL 里出现 payselect —— 整页跳,最硬,不需要解析任何 DOM;
    //   · 卡片单选钮**从无到有** —— 就地换内容(模态框)那种形态。
    //     「从无到有」而不是「有」:结算页上本来就可能渲染着一份支付列表
    //     (折叠的、或者 Amazon 把选卡直接嵌在结算页上),那时单看「有没有 radio」
    //     在点之前就已经为真了。
    //
    // 代价是:页面本来就有 radio、而且点完 URL 也不变的那种形态会走到失败分支。
    // 那是**故意选的那一侧** —— 这一整节的判据是全仓可信度最低的一档
    // (厂商自己承认没有 DOM 样本),分不清的时候宁可停下来让人看一眼,
    // 也不要在一张我们并不确定是什么的页面上点单选钮和确认按钮。
    // 失败 detail 里会写清「点之前就有 N 个」,看的人一眼知道是这一格判的。
    const arrived = await waitFor("支付选择页", () => {
      if (f.url().includes(SEL.checkout.payselect.urlHint)) return "url" as const;
      return radiosBefore === 0 && radioCount() > 0 ? "radios" as const : null;
    }, { timeoutMs: T.paymentSelect, everyMs: 300 }).catch(() => null);
    if (!arrived) {
      await this.guardLogin(f, "跳到支付选择页");
      stop("选卡页没到",
           `点了更改支付方式,但既没跳到 payselect、也没**新**渲染出卡片单选钮` +
           `(点之前页面上就有 ${radiosBefore} 个,现在有 ${safe(radioCount, -1)} 个);` +
           `当前 ${safe(() => describeUrl(f.urlState()), "URL 读不到")}` + alsoGone());
    }

    // ── ③ 唯一命中期望尾号的那张卡 ───────────────────────────────────
    const hit = await waitFor("目标支付卡", () => findCardRadioByLast4(doc(), want),
                              { timeoutMs: T.paymentSelect }).catch(() => null);
    if (!hit) {
      // ①② 同一条规矩,而这三步(③④⑤)比前两步更要紧:切卡的失败落的是
      // PAYMENT_METHOD_UNEXPECTED —— 归 BUSINESS_BLOCKED,**不在 RETRYABLE 里**,
      // 而且不上报 signed_out。少了这一句,一个在切卡途中被登出的买家号会:
      // 这一单落成「支付卡不符」的拍单异常 → login_state 仍是 ok → 下一轮照常
      // 认领 → 照样死在同一步。一台机器就这样把整队单子刷成「支付卡不符」,
      // 而运营看到这个码只会去查买家号钱包里的卡,查不出任何问题。
      // (地址那条链的同类分支落的是 ADDRESS_FORM_TIMEOUT,可重试,轻一档。)
      await this.guardLogin(f, "选支付卡");
      // 这一句要能分开三种现场:一张卡都没渲染出来(还在画/改版)、
      // 有卡但没有一张是那个尾号(钱包里没这张卡)、有两张都是那个尾号(不敢挑)。
      // 只写「没找到」的话,运营唯一能做的事是自己登录买家号去看一遍。
      const radios = safe(radioCount, -1);
      stop("没有唯一命中的那张卡",
           radios <= 0
             ? `支付选择页上一个渲染出来的卡片单选钮都没有:` +
               `${safe(() => describeMiss(doc(), [SEL.checkout.payselect.radio]),
                       "(页面已读不到,数不出来)")}` + alsoGone()
             : `支付选择页上有 ${radios} 个卡片单选钮,但没有**恰好一个**的尾号是 ${want} ` +
               `——「一张都不是」和「有两张都是」都会走到这里,两种都不许点:` +
               `前者是这个买家号钱包里没有这张卡,后者是同尾号两张卡,挑错了就是刷了别人的账`);
    }
    if (!click(hit.radio)) {
      stop("没有唯一命中的那张卡",
           `命中了尾号 ${want} 的那张卡(比中的是「${hit.matchedText}」),但 radio 点不动`);
    }

    // ── ④ 确认按钮 ──────────────────────────────────────────────────
    const confirm = await waitFor("支付方式确认按钮", () => findPaymentConfirmButton(doc()),
                                  { timeoutMs: T.paymentSelect }).catch(() => null);
    if (!confirm) {
      // 同 ③:等满一个预算才走到这里,而「等不到」最常见的成因之一就是页面
      // 已经被导去 /ap/signin 了。先问一句,理由见上面那一段。
      await this.guardLogin(f, "确认支付方式");
      // 「页面上根本没有这个按钮」与「按钮在、但一直是 disabled」是两回事:
      // 前者是改版,后者是这张卡被拒了(过期、额度、地区),等多久都不会变。
      const all = safe(() => Array.from(doc().querySelectorAll(SEL.checkout.payselect.confirm)),
                       [] as Element[]);
      const rendered = all.filter((el) => isRendered(el));
      stop("确认按钮不可用",
           all.length === 0
             ? `勾中了尾号 ${want},但页面上找不到确认按钮:` +
               `${safe(() => describeMiss(doc(), [SEL.checkout.payselect.confirm]),
                       "(页面已读不到,数不出来)")}` + alsoGone()
             : `勾中了尾号 ${want},确认按钮有 ${all.length} 个(渲染出来的 ${rendered.length} 个),` +
               `但在 ${T.paymentSelect}ms 内没有一个是可点的 —— ` +
               `按钮一直 disabled 多半是这张卡被 Amazon 拒了(过期/额度/地区),等下去也不会变`);
    }
    if (!click(confirm)) {
      stop("确认按钮不可用", "确认按钮点不动(元素在、也不 disabled,但 click 没生效)");
    }

    // ── ⑤ 回到结算页,**重新读一遍**必须等于期望 ──────────────────────
    //
    // 这一步不是旁白,是这整段唯一的验收:前面四步全都只证明「我们点了什么」,
    // 只有这一步证明「Amazon 认了」。少了它,一次点空的确认会让事件流里
    // 写着「支付卡已切换」,而结算页上还是原来那张卡 ——
    // 界面上写一句系统没做到的事,比这一单失败更坏。
    const got = await waitFor("结算页重新选中的卡",
                              () => { const v = now(); return v === want ? v : null; },
                              { timeoutMs: T.paymentSelect, everyMs: 300 }).catch(() => null);
    if (!got) {
      // 同 ③④。这一步等的是「回到结算页、而且卡换过来了」——被登出时页面根本
      // 不会回到结算页,等满预算之后报一句「切完读到的仍不是期望」是**错的原因**。
      await this.guardLogin(f, "切卡后回结算页");
      stop("切完读到的仍不是期望",
           `点完确认等了 ${T.paymentSelect}ms,结算页读到的仍是 ` +
           `${safe(now, null) ?? "读不出来"},不是 ${want}(切之前是 ${from ?? "读不出来"});` +
           `当前 ${safe(() => describeUrl(f.urlState()), "URL 读不到")}` + alsoGone());
    }

    await hooks.onSwitched?.({ from, to: want, matched: hit.matchedText });
    return { last4: got, switched: true };
  }

  // ── 下单 ─────────────────────────────────────────────────────────
  //
  // 这一段是整条流水线上唯一「已经花过钱」的地方,所以它的形状与别处不同:
  // **有界、分段、可见、上报**,四件缺一不可。
  //
  //  · 有界:三段各有预算,再压一道硬顶 —— 它按**服务端的认领超时**反推,
  //          而那本账是从认领那一刻开始记的,不是从点下单开始记的。
  //          绝不 while(true) —— 厂商 v2.5.3 把两处结算导航的 maxWaitTime 改成 0,
  //          于是「跨域后回到别的页面」「一直停在跨域页」两格变成永不返回,
  //          连带把他们的全局锁焊死,整个插件不再接受新的拍单请求。
  //  · 分段:normal / manual_verify / post_verify 分开计时。manual_verify
  //          **不重置总时钟**;post_verify 独立且短 —— 那一格就是厂商的永久卡死。
  //  · 可见:进入 manual_verify 必须把 iframe 露出来(frame.reveal)。
  //          我们的 iframe 平时在屏幕外、pointer-events:none —— 不露出来的话,
  //          「等操作员完成验证」是一句假话:他看不见,也点不到,
  //          把 60 秒改成 60 分钟只会把「立刻失败」变成「一小时后失败」。
  //  · 上报:进出 manual_verify 各发一条 step 事件(run.ts 传 hooks 进来),
  //          面板起一个 verify 相位与倒计时,运营台列表挂一个徽标。
  //
  // 到期的码分两种,因为现场是两种:停在发卡行验证页上到期是
  // PAYMENT_VERIFICATION_TIMEOUT(订单多半已经提交,钱可能已经扣了),
  // 其余是 ORDER_CONFIRM_TIMEOUT(常见成因是根本没点动那个按钮)。
  // 两者同属「必须转人工 + 可能已下单」,处置的第一步都是去买家号里看一眼。
  async placeOrder(hooks: PlaceOrderHooks = {}): Promise<void> {
    const f = this.need();
    if (!click(findSubmitOrderButton(f.doc()))) {
      throw new DriverError("PLUGIN_INTERNAL", "结算页找不到下单按钮");
    }

    const startedAt = Date.now();
    const hardCapMs = orderHardCapMs(hooks.claimDeadlineMs ?? null, startedAt);
    let phase: OrderWaitPhase = "normal";
    let phaseStartedAt = startedAt;
    let revealed = false;

    /** 这一段还剩多少时间。取「本段预算」与「总硬顶」里更紧的那个。 */
    const deadlineOf = (p: OrderWaitPhase, from: number) =>
      Math.min(from + PHASE_BUDGET[p](), startedAt + hardCapMs);

    const leaveManualVerify = async () => {
      if (revealed) {
        f.hide();
        revealed = false;
      }
      await hooks.onVerificationDone?.();
    };

    try {
      for (;;) {
        const s = f.urlState();

        // 只认 thankyou。被退回购物车不是成功 —— 厂商把它也判成功,
        // 于是失败的单会带着上一单的号被回填(深度分析 §4.2.4 高危)。
        if (s.kind === "ok" && s.url.includes(URLS.thankyou)) {
          if (phase === "manual_verify") await leaveManualVerify();
          return;
        }

        // iframe 没了(标签页被关、页面被换掉)。等下去没有意义,而且这不是
        // 「验证还没做完」—— 分开说,detail 里写清楚是哪一种。
        if (s.kind === "detached") {
          throw new DriverError("ORDER_CONFIRM_TIMEOUT",
                                "点了下单,但结算 iframe 已经不存在了(页面被关掉或被导走)");
        }

        // ── 相位迁移 ──
        if (s.kind === "cross_origin" && phase !== "manual_verify") {
          phase = "manual_verify";
          phaseStartedAt = Date.now();
          f.reveal(REVEAL_BANNER);
          revealed = true;
          await hooks.onManualVerification?.({
            deadlineMs: deadlineOf("manual_verify", phaseStartedAt),
          });
        } else if (phase === "manual_verify" && s.kind === "ok") {
          // 回到读得到的页面,但还不是确认页:验证做完了(或者被拒了),
          // 页面正在往下走。给一段**短而独立**的预算,总时钟继续走。
          phase = "post_verify";
          phaseStartedAt = Date.now();
          await leaveManualVerify();
        }

        // ── 到期 ──
        const now = Date.now();
        if (now >= deadlineOf(phase, phaseStartedAt)) {
          const overHardCap = now >= startedAt + hardCapMs;
          const waited = Math.round((now - startedAt) / 1000);
          if (phase === "manual_verify") {
            // **这里不问 guardLogin。** 停在发卡行的验证页上读不到 URL 是常态,
            // 再去开一张购物车页问「是不是被登出了」,拿回来的结论会把
            // 「验证没做完」改写成 LoginLostError,而后者在 run.ts 里最终落成
            // ORDER_CONFIRM_TIMEOUT —— 刚分出来的这个码当场就被抹掉了。
            // detail 里写**这一刻**读到的是什么,而不是一句「跨域」了事:
            // 进了这一格之后页面还可能变成别的读不到的样子(unreadable),
            // 两种写成同一句的话,运营台上又是一次「两种情况渲染成同一个结果」。
            throw new DriverError("PAYMENT_VERIFICATION_TIMEOUT",
                                  `点了下单,页面转到发卡行验证页等人完成验证,` +
                                  `等了 ${waited} 秒仍未完成` +
                                  `${overHardCap ? "(已到总硬顶)" : ""};${describeUrl(s)}`);
          }
          // 落到登录页说明 Amazon 在最后一步要求重新认证 —— 单多半没下成。
          // 但**这里已经越过下单点了**:guardLogin 抛出的 LoginLostError 在 run.ts 里
          // 走既有的转人工路径(不退回队列),同时把这台机器标成已登出。
          // 「可能已经花了钱」比「被登出了」更要紧,处置不能变。
          await this.guardLogin(f, "下单后等确认页");
          throw new DriverError("ORDER_CONFIRM_TIMEOUT",
                                `点了下单但没等到确认页,等了 ${waited} 秒,` +
                                `${phase === "post_verify" ? "验证已结束但页面没走到确认页," : ""}` +
                                `${describeUrl(s)}${overHardCap ? "(已到总硬顶)" : ""}`);
        }

        await sleep(T.orderPoll);
      }
    } finally {
      // 无论怎么离开这一段,都不能把那个 1280×900 的窗口留在页面正中央。
      if (revealed) f.hide();
    }
  }

  // ── 回填 ─────────────────────────────────────────────────────────
  async readOrderCard(): Promise<OrderCard> {
    return withFrame(URLS.orderHistory(this.origin), async (f) => {
      let cards;
      try {
        cards = await waitFor("订单历史卡片",
                              () => { const c = readOrderCards(f.doc()); return c.length ? c : null; },
                              { timeoutMs: T.orderCards });
      } catch {
        throw new DriverError("ORDER_NO_AMBIGUOUS", "订单历史页没加载出任何订单卡");
      }
      // readOrderCards 已经把「隐藏模板」和「读不出合法单号」的滤掉了,
      // 所以这里拿到的每一张都是真卡。
      const first = cards[0];
      // 取第一张卡,但把卡上的 ASIN 一并带回去让服务端断言。
      // 厂商到这里就直接写库了 —— 串单时整条任务的单号、金额、邮编全写错。
      return { amazonOrderNo: first.orderNo!, observedAsins: first.asins };
    }, T.frameLoad);
  }

  private need(): Frame {
    if (!this.checkout) {
      throw new DriverError("PLUGIN_INTERNAL", "购物车/结算页会话不存在,调用顺序错了");
    }
    return this.checkout;
  }
}

/** 物流同步用的读取器。与 AmazonDriver 分开:那条流跑在 purchased 之后,
 *  不碰购物车也不下单,共用一个类只会让「什么时候能调什么」变糊涂。 */
export class AmazonShipmentReader implements ShipmentReader {
  readonly name = "amazon";
  readonly ready = true;

  private frame: Frame | null = null;

  constructor(private readonly origin: string = "https://www.amazon.com") {}

  async dispose(): Promise<void> {
    this.frame?.close();
    this.frame = null;
  }

  async readOrder(amazonOrderNo: string): Promise<{ state: OrderState; trackingUrl: string | null }> {
    this.frame?.close();
    this.frame = await openFrame(URLS.orderDetails(this.origin, amazonOrderNo), T.frameLoad);
    const f = this.frame;

    // 状态判定要**先于**抓取:"订单不存在" 和 "还没加载好" 是两回事,
    // 分不开就会把前者当成后者一直等下去。
    let state: OrderState = "loading";
    try {
      state = await waitFor("订单详情页就绪", () => {
        const got = readOrderState(f.doc());
        return got === "loading" ? null : got;
      }, { timeoutMs: 20_000 });
    } catch {
      // 等不到任何可判定的信号,按"打不开"处理 —— 服务端只记不改。
      return { state: "not_found", trackingUrl: null };
    }

    const href = state === "ok" ? findTrackingLink(f.doc()) : null;
    return { state, trackingUrl: href ? new URL(href, this.origin).toString() : null };
  }

  async readTracking(url: string): Promise<TrackingRead> {
    return withFrame(url, async (f) => {
      try {
        await waitFor("跟踪页就绪",
                      // Amazon 那句「这会儿给不了轨迹」也算就绪 —— 不认它的话
                      // 三个选择器一个都等不到,只能干等满 30 秒。
                      // 一批 20 单全是这种,就是白等 10 分钟。
                      () => isTrackingUnavailable(f.doc()) ||
                            SEL.tracking.trackingIds.some((x) => f.doc().querySelector(x)) ||
                            f.doc().querySelector(SEL.tracking.primaryStatus) ||
                            f.doc().querySelector(SEL.tracking.eventsContainer),
                      { timeoutMs: 30_000 });
      } catch {
        // 跟踪页打不开不是采购失败,别把它当错误抛给上层的批处理。
        return { trackingNo: null, carrier: null, status: null, promise: null,
                 events: [], unavailable: false };
      }

      // **「Amazon 暂时给不了」与「我们没解析出来」要分开。**
      // 都记成 0 条轨迹的话,选择器坏了会被当成「这批单都还没发货」,
      // 一直到有人发现整整一周没有任何轨迹为止。
      if (isTrackingUnavailable(f.doc())) {
        return { trackingNo: null, carrier: null, status: null, promise: null,
                 events: [], unavailable: true };
      }
      const doc = f.doc();
      return {
        trackingNo: readTrackingNumber(doc),
        carrier: readCarrier(doc),
        status: readTrackingStatus(doc),
        promise: readDeliveryPromise(doc),
        events: readTrackingEvents(doc),
      };
    }, T.frameLoad);
  }
}
