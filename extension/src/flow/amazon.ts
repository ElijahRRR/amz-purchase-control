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
import { sleep, waitFor, waitStable, WaitTimeout } from "./dom/wait.js";
import {
  cartMatches, findInterstitialButton, findQuantityOption, pickQuantitySelect,
  readCartLines, readCheckoutPanels,
  readGrandTotal, readInStock, readOrderCards, readOrderSummary, readPaymentLast4,
  readProductShipper,
} from "./dom/parse.js";
import { DriverError, type AddResult, type CheckoutReading, type OrderCard, type PageDriver } from "./driver.js";
import type { Shipping } from "../core/types.js";

const T = {
  frameLoad: 30_000,
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

export class AmazonDriver implements PageDriver {
  readonly name = "amazon";
  readonly ready = true;

  /** 购物车 → 结算页 → 下单,是同一个 iframe 一路跳过来的。 */
  private checkout: Frame | null = null;

  constructor(private readonly origin: string = "https://www.amazon.com") {}

  async dispose(): Promise<void> {
    this.checkout?.close();
    this.checkout = null;
  }

  // ── 清车 ─────────────────────────────────────────────────────────
  async clearCart(): Promise<void> {
    await withFrame(URLS.cart(this.origin), async (f) => {
      // 上限是防呆:删不动时不能在这里转圈转到天荒地老。
      for (let round = 0; round < 30; round += 1) {
        const before = readCartLines(f.doc()).length;
        if (before === 0) return;
        const scope = f.doc().querySelector(SEL.cart.activeItems);
        let clicked = false;
        for (const sel of SEL.cart.deleteButtons) {
          if (click(scope?.querySelector(sel))) { clicked = true; break; }
        }
        if (!clicked) {
          throw new DriverError("PLUGIN_INTERNAL", `购物车里还有 ${before} 件,但找不到删除控件`);
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
      await waitFor("商品页买家框", () => f.doc().querySelector(SEL.product.addToCart) ||
                                          f.doc().querySelector(SEL.product.outOfStock),
                    { timeoutMs: T.frameLoad });

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

      if (!click(f.doc().querySelector(SEL.product.addToCart))) {
        throw new DriverError("ADD_TO_CART_FAILED", `${asin} 页面上没有加入购物车按钮`);
      }

      try {
        await waitFor("加购后跳转到购物车",
                      () => URLS.cartLanding.some((u) => f.url().includes(u)),
                      { timeoutMs: T.addToCart });
      } catch (e) {
        if (e instanceof WaitTimeout) {
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
  async verifyCart(expected: Array<{ asin: string; quantity: number }>): Promise<boolean> {
    this.checkout?.close();
    this.checkout = await openFrame(URLS.cart(this.origin), T.frameLoad);
    await waitFor("购物车行渲染",
                  () => readCartLines(this.checkout!.doc()).length > 0,
                  { timeoutMs: 15_000 });
    return cartMatches(readCartLines(this.checkout.doc()), expected);
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
    for (let hop = 0; hop < 3; hop += 1) {
      try {
        // 盯 URL 本身连续三次不变,而不是盯它的分类 ——
        // 否则在两个中间页之间来回跳也会被当成"稳定了"。
        await waitStable("跳到结算页",
                         () => {
                           const u = f.url();
                           const hit = u.includes(URLS.finalCheckout) ||
                                       URLS.interstitial.some((x) => u.includes(x));
                           return hit ? u : null;
                         },
                         3, { timeoutMs: T.checkoutNav, everyMs: 400 });
      } catch {
        throw new DriverError("CHECKOUT_TIMEOUT", `等结算页超时,当前 URL:${f.url()}`);
      }
      if (f.url().includes(URLS.finalCheckout)) return;
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

    if (!doc().querySelector(SEL.address.fullName)) {
      // 地址簿里已有地址时,先点"换地址"再点"新建"。
      click(doc().querySelector(SEL.address.changeAddress));
      try {
        await waitFor("地址区加载", () => doc().querySelector(SEL.address.section),
                      { timeoutMs: T.addressForm });
      } catch {
        throw new DriverError("ADDRESS_FORM_TIMEOUT", "地址区没加载出来");
      }
      click(doc().querySelector(SEL.address.addNew));
      try {
        await waitFor("新建地址表单", () => doc().querySelector(SEL.address.fullName),
                      { timeoutMs: T.addressForm });
      } catch {
        throw new DriverError("ADDRESS_FORM_TIMEOUT", "新建地址表单没出来");
      }
    }

    setInput(doc().querySelector(SEL.address.fullName), shipping.name);
    setInput(doc().querySelector(SEL.address.phone), shipping.phone);
    setInput(doc().querySelector(SEL.address.line1), shipping.line1);
    setInput(doc().querySelector(SEL.address.line2), "");
    setInput(doc().querySelector(SEL.address.city), shipping.city);
    setInput(doc().querySelector(SEL.address.postal), shipping.postcode);

    const stateSel = doc().querySelector<HTMLSelectElement>(SEL.address.state);
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

    click(doc().querySelector(SEL.address.save));

    // 两轮弹窗对抗:表单校验提示 / Amazon 的地址建议弹窗。
    await sleep(1200);
    if (SEL.address.validationAlerts.some((s) => doc().querySelector(s)?.textContent?.trim())) {
      click(doc().querySelector(SEL.address.save));
      await sleep(1200);
    }
    if (doc().querySelector(SEL.address.suggestionPopup)) {
      // 选**原始地址**那一项:上游给什么就寄什么,不让 Amazon 替我们改收件地址。
      const radio = doc().querySelector(`${SEL.address.suggestionPopup} input[type=radio]`);
      if (!click(radio)) {
        throw new DriverError("ADDRESS_SUGGESTION_BLOCKED", "地址建议弹窗里选不到原始地址");
      }
      click(doc().querySelector(SEL.address.save));
    }

    try {
      await waitFor("地址生效", () => doc().querySelector(SEL.checkout.addressText),
                    { timeoutMs: T.addressSave });
    } catch {
      throw new DriverError("ADDRESS_FORM_TIMEOUT", "地址保存后没等到收货地址栏");
    }

    // 填完不等于生效。Amazon 可能仍然用着地址簿里原来那条 ——
    // 那就会把货寄到别人家去,后果和实付超限价一样严重,必须当场发现。
    // 厂商只做了「地址文本含邮编」这一条子串判断,姓名/街道/城市/州一概不校验。
    const applied = (doc().querySelector(SEL.checkout.addressText)?.textContent ?? "")
      .replace(/\s+/g, " ");
    const zip = shipping.postcode.split("-")[0];   // 页面常只显示 ZIP5,下发的可能是 ZIP+4
    const missing: string[] = [];
    if (!applied.includes(zip)) missing.push(`邮编 ${zip}`);
    if (!applied.toLowerCase().includes(shipping.city.toLowerCase())) missing.push(`城市 ${shipping.city}`);
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
      throw new DriverError("CHECKOUT_TIMEOUT", "结算页商品面板没渲染出来");
    }

    const panels = readCheckoutPanels(f.doc());
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

    return {
      actualTotal: total,
      actualShipping: summary.shipping,
      actualTax: summary.tax,
      deliveryTexts: panels.map((p) => p.deliveryText).filter((t): t is string => !!t),
      isFba,
      paymentLast4: readPaymentLast4(f.doc()),
      // 只报**读到的**单价。数量结算页上没读(报告说厂商那道数量校验是死代码,
      // 真正的数量比对在购物车页已经做过),所以不在这里编一个 1 出来。
      unitPrices: panels
        .filter((p) => p.asin && p.unitPrice)
        .map((p) => ({ asin: p.asin!, unit_price: p.unitPrice! })),
    };
  }

  // ── 下单 ─────────────────────────────────────────────────────────
  async placeOrder(): Promise<void> {
    const f = this.need();
    if (!click(f.doc().querySelector(SEL.checkout.submitOrder))) {
      throw new DriverError("PLUGIN_INTERNAL", "结算页找不到下单按钮");
    }
    try {
      // 只认 thankyou。被退回购物车不是成功 —— 厂商把它也判成功,
      // 于是失败的单会带着上一单的号被回填(深度分析 §4.2.4 高危)。
      await waitFor("下单确认页", () => f.url().includes(URLS.thankyou),
                    { timeoutMs: T.orderConfirm, everyMs: 500 });
    } catch {
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
