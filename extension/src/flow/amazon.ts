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
import { openFrame, withFrame, type Frame } from "./dom/frame.js";
import { waitFor, waitStable, WaitTimeout } from "./dom/wait.js";
import {
  cartMatches, describeMiss, findAddNewAddressEntry, findAddToCartButton,
  findAddressChangeEntry, findAddressFormNameField, findAddressSection,
  findInterstitialButton, findQuantityOption, findSubmitOrderButton, findTrackingLink,
  readAddressSaveOutcome,
  pickFirstRendered, pickQuantitySelect, readCarrier, readCartLines, readCartState,
  readCheckoutPanels,
  readDeliveryPromise, readGrandTotal, readInStock, readOrderCards, readOrderState,
  isTrackingUnavailable,
  isSignInUrl,
  readLoginState,
  readOrderSummary, readPaymentLast4, readProductShipper, readTrackingEvents,
  readTrackingNumber, readTrackingStatus,
  type CartLine, type LoginState, type OrderState,
} from "./dom/parse.js";
import type { ShipmentReader, TrackingRead } from "./shipment.js";
import { DriverError, LoginLostError, type AddResult, type CartReadReporter, type CheckoutReading, type OrderCard, type PageDriver } from "./driver.js";
import type { Shipping } from "../core/types.js";

const T = {
  frameLoad: 30_000,
  /** 判登录态那一次:只要导航栏渲染出来就够,不等整页加载完。 */
  loginProbe: 20_000,
  addToCart: 30_000,
  checkoutNav: 45_000,
  addressForm: 30_000,
  addressSave: 30_000,
  orderConfirm: 60_000,
  orderCards: 20_000,
};

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

  constructor(private readonly origin: string = "https://www.amazon.com") {}

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

  /** 开一张轻量页面(购物车)读导航栏。读不出来就是 unknown,**不兜底成 ok**。 */
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
        return "unknown";
      }
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
      try {
        await waitFor("购物车页渲染", () =>
          SEL.cart.cartRendered.some((m) => f.doc().querySelector(m)) ||
          SEL.cart.emptyMarkers.some((m) => f.doc().querySelector(m)),
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
          // 正面证据是两条之一:容器在(容器在而 0 行 = 真的空了),
          // 或者页面上有确凿的空车标志(.sc-your-amazon-cart-is-empty / #sc-empty-cart)。
          const emptyMarker = SEL.cart.emptyMarkers.some((m) => f.doc().querySelector(m));
          if (st.scopeFound || emptyMarker) return;
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
   *  换成三种可分辨的结局:
   *   · 读到行,或页面明说空车     → 立刻按 cartMatches 判(空车 = 不符)
   *   · 容器在、就是 0 行          → 等满窗口后同样按 cartMatches 判(不符)
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
      if (SEL.cart.emptyMarkers.some((m) => f.doc().querySelector(m))) return got;
      return null;
    }, { timeoutMs: 15_000 }).catch(() => null);

    const final = st ?? readCartState(f.doc());
    if (!st && !final.scopeFound) {
      await this.guardLogin(f, "回读购物车");
      throw new DriverError(
        "PLUGIN_INTERNAL",
        `购物车页没渲染出商品区,回读不算数:` +
        `${describeMiss(f.doc(), [SEL.cart.activeItems, ...SEL.cart.emptyMarkers])}`);
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
    const deadline = Date.now() + T.addressSave;
    let settled = false;
    for (let round = 0; round < 3 && !settled; round += 1) {
      const hit = await waitFor("地址保存结果", () => readAddressSaveOutcome(doc()),
                                { timeoutMs: Math.max(0, deadline - Date.now()), everyMs: 300 })
        .catch(() => null);

      if (hit === "saved") { settled = true; break; }
      if (hit === "alerts") {
        // 校验提示:再点一次保存(Amazon 常在第一次提交时补全/规范化字段)。
        save();
        continue;
      }
      if (hit === "suggestion") {
        // 选**原始地址**那一项:上游给什么就寄什么,不让 Amazon 替我们改收件地址。
        const radio = pickFirstRendered(doc(), [`${SEL.address.suggestionPopup} input[type=radio]`]);
        if (!click(radio)) {
          throw new DriverError("ADDRESS_SUGGESTION_BLOCKED", "地址建议弹窗里选不到原始地址");
        }
        save();
        continue;
      }
      // 三种结果一个都没等到,预算也用完了。
      throw new DriverError("ADDRESS_FORM_TIMEOUT",
                            `点了保存,但 ${T.addressSave}ms 内既没出现收货地址栏,` +
                            `也没出现校验提示或地址建议弹窗(第 ${round + 1} 轮)`);
    }
    if (!settled) {
      throw new DriverError("ADDRESS_FORM_TIMEOUT",
                            "地址保存对抗了 3 轮仍没等到收货地址栏(校验提示/建议弹窗反复出现)");
    }

    // 填完不等于生效。Amazon 可能仍然用着地址簿里原来那条 ——
    // 那就会把货寄到别人家去,后果和实付超限价一样严重,必须当场发现。
    // 厂商只做了「地址文本含邮编」这一条子串判断,姓名/街道/城市/州一概不校验。
    const applied = (doc().querySelector(SEL.checkout.addressText)?.textContent ?? "")
      .replace(/\s+/g, " ");
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
    if (!total) {
      // 读不到总额就绝不下单 —— 护栏比的就是这个数。
      throw new DriverError("CHECKOUT_TIMEOUT", "结算页读不到订单总额");
    }
    const summary = readOrderSummary(f.doc());

    // 有一个面板明确不是 Amazon 发货,整单就不是 FBA。
    // 全都读不到才返回 null(未知),交给服务端按 require_fba 处置。
    const known = panels.map((p) => p.isFba).filter((v): v is boolean => v !== null);
    const isFba = known.length === 0 ? null : known.every(Boolean);

    const priced = panels.filter((p) => p.asin && p.unitPrice);

    return {
      actualTotal: total,
      actualShipping: summary.shipping,
      actualTax: summary.tax,
      deliveryTexts: panels.map((p) => p.deliveryText as string),
      isFba,
      paymentLast4: readPaymentLast4(f.doc()),
      // 只报**读到的**单价。数量结算页上没读(报告说厂商那道数量校验是死代码,
      // 真正的数量比对在购物车页已经做过),所以不在这里编一个 1 出来。
      unitPrices: priced.map((p) => ({ asin: p.asin!, unit_price: p.unitPrice! })),
      // **一个都没读到 ≠ 这单没有单价**,那是选择器坏了。
      //
      // 原先这里只是 .filter 一下就过去了:Amazon 换个类名,unitPrices 静默
      // 变成空数组,护栏照跑(它比的是 actual_total,走另一个选择器),
      // 单子照下,只有运营台上「实付单价」那一列悄悄全空 —— 没有任何地方报错,
      // 等有人觉得不对已经是几百单之后。这和 deliveryTexts 那次是同一类问题。
      //
      // 不中断下单:限价护栏不依赖单价,为一个展示字段掀翻一次采购更糟。
      // 但要让它在事件流里留下痕迹。
      unitPriceSelectorBroken: panels.length > 0 && priced.length === 0,
    };
  }

  // ── 下单 ─────────────────────────────────────────────────────────
  async placeOrder(): Promise<void> {
    const f = this.need();
    if (!click(findSubmitOrderButton(f.doc()))) {
      throw new DriverError("PLUGIN_INTERNAL", "结算页找不到下单按钮");
    }
    try {
      // 只认 thankyou。被退回购物车不是成功 —— 厂商把它也判成功,
      // 于是失败的单会带着上一单的号被回填(深度分析 §4.2.4 高危)。
      await waitFor("下单确认页", () => f.url().includes(URLS.thankyou),
                    { timeoutMs: T.orderConfirm, everyMs: 500 });
    } catch {
      // 落到登录页说明 Amazon 在最后一步要求重新认证 —— 单多半没下成。
      // 但**这里已经越过下单点了**:guardLogin 抛出的 LoginLostError 在 run.ts 里
      // 走既有的转人工路径(不退回队列),同时把这台机器标成已登出。
      // 「可能已经花了钱」比「被登出了」更要紧,处置不能变。
      await this.guardLogin(f, "下单后等确认页");
      throw new DriverError("ORDER_CONFIRM_TIMEOUT",
                            `点了下单但没等到确认页,当前 URL:${f.url()}`);
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
