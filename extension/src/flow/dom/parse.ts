/** 纯解析函数:只吃 Document / Element,不点不等不发请求。
 *
 * 分出来是为了能离线验:test/fixtures 里有按逆向报告造的四张页面 DOM,
 * 这些函数对着夹具跑,选择器写松了当场露馅。真实 Amazon 页面拿不到,
 * 这是能做到的最强验证。
 */

import { ASIN_RE, ORDER_NO_RE, SEL, URLS } from "./selectors.js";

const text = (el: Element | null | undefined): string =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** Amazon 页面上同一个 id 会出现多份(隐藏的模板副本、twister 影子节点)。
 *  querySelector 只给第一个 —— 万一隐藏副本排在前面就读错了。
 *  这里取第一个「没有被标为隐藏」的。 */
function isHidden(el: Element): boolean {
  if (el.closest('[aria-hidden="true"]')) return true;
  if (el.closest("[hidden]")) return true;
  const style = (el as unknown as HTMLElement).style;
  if (style && style.display === "none") return true;
  // 隐藏容器里的节点也算隐藏 —— Amazon 常把整套模板塞进 display:none 的壳里
  let cur: Element | null = el.parentElement;
  while (cur) {
    const st = (cur as unknown as HTMLElement).style;
    if (st && st.display === "none") return true;
    cur = cur.parentElement;
  }
  return false;
}

function visible<T extends Element>(doc: Document | Element, selector: string): T | null {
  for (const el of Array.from(doc.querySelectorAll<T>(selector))) {
    if (!isHidden(el)) return el;
  }
  return null;
}

/** 输入:含金额的文本 → 输出:去掉货币符号与千分位的数字串。认不出返回 undefined。 */
export function parseMoney(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const m = /-?[\d,]+\.\d{2}|-?[\d,]+/.exec(s.replace(/\s/g, ""));
  if (!m) return undefined;
  const n = m[0].replace(/,/g, "");
  return /^-?\d+$/.test(n) ? n + ".00" : n;
}

// ── 商品页 ──────────────────────────────────────────────────────────

/** 报告 §4.2.1:含 Currently unavailable 即无货。用 includes 而非全等
 *  —— 页面上是 "Currently unavailable." 带句点。 */
export function readInStock(doc: Document): boolean {
  const el = visible(doc, SEL.product.outOfStock);
  if (!el) return true;
  return !/currently unavailable/i.test(text(el));
}

/** 报告 §4.2.1:遍历 #quantity 的 options,innerText.trim() 与目标数量比。 */
export function pickQuantitySelect(doc: Document): HTMLSelectElement | null {
  const sel = visible<HTMLSelectElement>(doc, SEL.product.quantitySelect);
  return sel && sel.options.length > 0 ? sel : null;
}

export function findQuantityOption(doc: Document, quantity: number): { has: boolean; matched: boolean } {
  const sel = pickQuantitySelect(doc);
  if (!sel) return { has: false, matched: false };
  const matched = Array.from(sel.options).some((o) => text(o) === String(quantity));
  return { has: true, matched };
}

/** 报告未记载商品页的配送方选择器,所以这是**尽力而为**:
 *  读到了就返回是否 Amazon 自营,读不到返回 null(未知),留给结算页那道权威判定。 */
export function readProductShipper(doc: Document): boolean | null {
  for (const sel of SEL.product.shipperHints) {
    const box = doc.querySelector(sel);
    if (!box) continue;
    const t = text(box);
    const m = /(ships from|dispatched from|sold by)\s*:?\s*([^,.|]+)/i.exec(t);
    if (m) return /amazon/i.test(m[2]);
  }
  return null;
}

// ── 购物车 ──────────────────────────────────────────────────────────

export interface CartLine {
  asin: string;
  quantity: number | null;
}

/** 报告 §4.2.2:只数 Active Items 里的行。
 *  不带这个前缀就会把 "Saved for later" 和推荐位一起算进来。 */
export function readCartLines(doc: Document): CartLine[] {
  const scope = doc.querySelector(SEL.cart.activeItems);
  if (!scope) return [];
  return Array.from(scope.querySelectorAll(SEL.cart.line))
    .map((row) => {
      const asin = row.getAttribute("data-asin") ?? "";
      const qtyEl =
        row.querySelector(SEL.cart.qtyValue) ?? row.querySelector(SEL.cart.qtyNonEditable);
      const n = Number(text(qtyEl).replace(/[^\d]/g, ""));
      return { asin, quantity: Number.isFinite(n) && n > 0 ? n : null };
    })
    .filter((l) => l.asin.length > 0);
}

/** 车里的东西是不是恰好就是本单的东西。多一件少一件、数量对不上都算不符。 */
export function cartMatches(lines: CartLine[], expected: Array<{ asin: string; quantity: number }>): boolean {
  if (lines.length !== expected.length) return false;
  return expected.every((e) => lines.some((l) => l.asin === e.asin && l.quantity === e.quantity));
}

// ── 结算页 ──────────────────────────────────────────────────────────

export interface CheckoutPanel {
  asin: string | null;
  unitPrice: string | undefined;
  shipper: string | null;
  isFba: boolean | null;
  deliveryText: string | null;
}

/** 只认真正装着商品的面板:必须含 .lineitem-container。
 *  Amazon 页面上有隐藏的面板模板,不过滤就会多出空壳。 */
export function readCheckoutPanels(doc: Document): CheckoutPanel[] {
  return Array.from(doc.querySelectorAll(SEL.checkout.itemPanel))
    .filter((p) => p.querySelector(SEL.checkout.lineItemContainer))
    .map((panel) => {
      // 面板内取,不用全文档 querySelectorAll 再按下标 [i] 取
      // —— 厂商就是按下标取的,面板顺序一变就串行(报告 §4.2.4 第 5 项)。
      let asin: string | null = null;
      const asinEl = panel.querySelector(SEL.checkout.panelAsin);
      const asinText = text(asinEl);
      if (ASIN_RE.test(asinText)) asin = ASIN_RE.exec(asinText)![1];
      if (!asin) {
        // 退路:面板里任何指向商品的链接
        for (const a of Array.from(panel.querySelectorAll("a[href]"))) {
          const m = ASIN_RE.exec(a.getAttribute("href") ?? "");
          if (m) { asin = m[1]; break; }
        }
      }

      // 读**全部**配送方行再拼起来。只读第一行的话,
      // 遇到 "Sold by ..." 排在 "Ships from ..." 前面的排版就什么都判不出来。
      const shipperText = Array.from(panel.querySelectorAll(SEL.checkout.panelShipper))
        .map(text).filter(Boolean).join(" | ");
      // FBA 看的是**谁发货**,不是谁卖。
      //   "Ships from Amazon.com / Sold by ThirdParty"  → 是 FBA(这正是 FBA 的定义)
      //   "Ships from ThirdParty / Sold by Amazon.com"  → 不是 FBA
      // 所以只认 ships from / dispatched from,绝不拿 sold by 来判。
      // 厂商的判据是"文案里出现 amazon 就算 FBA"(报告 §4.2.4 第 9 项「判据极弱」),
      // 上面第二种写法在他们那里会被判成 FBA。
      const shipFrom = /(?:ships?|dispatched)\s+from\s*:?\s*([^,.|\n]+)/i.exec(shipperText);
      const shipper = shipFrom ? shipFrom[1].trim() : (shipperText || null);
      // 认不出配送方就是 null(未知),不拿卖家名字凑数 —— 服务端会按 require_fba 处置。
      const isFba = shipFrom ? /amazon/i.test(shipFrom[1]) : null;

      return {
        asin,
        unitPrice: parseMoney(text(panel.querySelector(SEL.checkout.panelUnitPrice))),
        shipper,
        isFba,
        deliveryText: text(panel.querySelector(SEL.checkout.panelDelivery)) || null,
      };
    });
}

/** 购物车点完结算,Amazon 可能插一张中间页(byg/byc)。
 *  做成纯函数是为了能对着夹具验:选错元素会把中间页当成终局页,
 *  下一步就直接去点"下单"了。 */
export function findInterstitialButton(doc: Document): Element | null {
  for (const sel of SEL.checkout.interstitialButtons) {
    const el = visible(doc, sel);
    if (el) return el;
  }
  return null;
}

export function readGrandTotal(doc: Document): string | undefined {
  return parseMoney(text(doc.querySelector(SEL.checkout.grandTotal)));
}

/** 报告没记结算页的运费/税选择器(厂商是在**订单详情页**读的)。
 *  所以这里按 label 文案扫行,而不是赌一个 id —— 文案比 id 稳。 */
export function readOrderSummary(doc: Document): {
  shipping?: string;
  tax?: string;
  beforeTax?: string;
  total?: string;
} {
  const out: { shipping?: string; tax?: string; beforeTax?: string; total?: string } = {};
  const rows = Array.from(doc.querySelectorAll("tr, .a-row, li"));
  for (const row of rows) {
    const t = text(row);
    if (!t || t.length > 120) continue;
    const money = parseMoney(t);
    if (!money) continue;
    if (out.shipping === undefined && /shipping\s*(&|and)?\s*handling/i.test(t)) out.shipping = money;
    else if (out.tax === undefined && /(estimated\s+)?tax(\s+to\s+be\s+collected)?/i.test(t) && !/before\s+tax/i.test(t)) out.tax = money;
    else if (out.beforeTax === undefined && /total\s+before\s+tax/i.test(t)) out.beforeTax = money;
    else if (out.total === undefined && /(order|grand)\s+total/i.test(t)) out.total = money;
  }
  return out;
}

/** 卡后四位。厂商取的是文案里**第一个** 4 位连续数字(报告 §4.2.4 第 3 项),
 *  文案里的年份、分期数、金额都会被误采。这里先认"ending in/with",
 *  再认掩码,都不中才退到**最后**一组 4 位数字。 */
export function readPaymentLast4(doc: Document): string | undefined {
  const t = text(doc.querySelector(SEL.checkout.paymentText));
  if (!t) return undefined;
  const ending = /ending\s+(?:in|with)\s+(\d{4})/i.exec(t);
  if (ending) return ending[1];
  const masked = /(?:[*•·]\s*){2,}\s*(\d{4})/.exec(t);
  if (masked) return masked[1];
  const all = t.match(/\b\d{4}\b/g);
  return all ? all[all.length - 1] : undefined;
}

// ── 订单历史 ────────────────────────────────────────────────────────

export interface OrderCardRead {
  orderNo: string | null;
  asins: string[];
}

/** 报告 §4.2.5:订单号取 .yohtmlc-order-id 里**第 2 个** span。
 *  加一道形态校验:取到的东西必须长得像 111-xxxxxxx-xxxxxxx,
 *  不像就在这张卡里全局找一个像的。span 顺序变了也不至于把 "ORDER #" 当单号写进库。 */
export function readOrderCards(doc: Document): OrderCardRead[] {
  const primary = Array.from(doc.querySelectorAll(SEL.orders.card));
  // 报告把 .order-card__list 记作 .js-order-card 的退化选择器,但它其实是**列表容器**。
  // 页面上一张订单都没有时,隐藏模板里的那个空容器会被当成一张卡 ——
  // 于是"没有订单"变成"有一张读不出号的订单"。两道闸拦住它:
  //   1. 隐藏的节点不算卡(Amazon 把整套模板塞在 display:none 的壳里)
  //   2. 读不出合法订单号的不算卡(占位符 ###-#######-####### 过不了形态校验)
  const nodes = (primary.length ? primary : Array.from(doc.querySelectorAll(SEL.orders.cardFallback)))
    .filter((el) => !isHidden(el));

  return nodes.map((card) => {
    const spans = Array.from(card.querySelectorAll(SEL.orders.orderIdSpans));
    let orderNo: string | null = null;
    const second = text(spans[1]);
    if (ORDER_NO_RE.test(second)) orderNo = ORDER_NO_RE.exec(second)![0];
    if (!orderNo) {
      const m = ORDER_NO_RE.exec(text(card));
      orderNo = m ? m[0] : null;
    }

    const asins: string[] = [];
    for (const a of Array.from(card.querySelectorAll(SEL.orders.productLinks))) {
      const m = ASIN_RE.exec(a.getAttribute("href") ?? "");
      if (m && !asins.includes(m[1])) asins.push(m[1]);
    }
    return { orderNo, asins };
  }).filter((c) => c.orderNo !== null);
}

// ── 订单详情页(物流同步流) ───────────────────────────────────────────

export type OrderState = "ok" | "cancelled" | "not_found" | "loading";

/** 报告 §4.3 第 3 步:状态判定要**先于**抓取。
 *  页面还没渲染完就去抓,抓到的是空;而"订单不存在"和"还没加载好"是两回事。 */
export function readOrderState(doc: Document): OrderState {
  const heading = Array.from(doc.querySelectorAll(SEL.orderDetails.alertHeading))
    .map(text).join(" | ");
  if (/unable to load your order details/i.test(heading)) return "not_found";
  if (/cancell?ed/i.test(heading)) return "cancelled";
  const top = text(doc.querySelector(SEL.orderDetails.shipmentTopRow));
  if (/refund/i.test(top)) return "cancelled";
  return doc.querySelector(SEL.orderDetails.root) ? "ok" : "loading";
}

/** 报告 §4.3 extractOrderInfo:#od-subtotals 里每行是「label + 金额」。
 *  按 label 文案扫,不按行下标 —— Amazon 会按订单形态增减行(礼品卡、促销、小费)。 */
export function readOrderSubtotals(doc: Document): {
  shipping?: string; beforeTax?: string; tax?: string; total?: string;
} {
  const out: { shipping?: string; beforeTax?: string; tax?: string; total?: string } = {};
  for (const row of Array.from(doc.querySelectorAll(SEL.orderDetails.subtotalRow))) {
    if (isHidden(row)) continue;
    const t = text(row);
    const money = parseMoney(t);
    if (!money) continue;
    if (out.shipping === undefined && /shipping\s*(&|and)?\s*handling/i.test(t)) out.shipping = money;
    else if (out.beforeTax === undefined && /total\s+before\s+tax/i.test(t)) out.beforeTax = money;
    else if (out.tax === undefined && /tax\s+to\s+be\s+collected|estimated\s+tax|\bgst\b|\bhst\b/i.test(t)) out.tax = money;
    else if (out.total === undefined && /grand\s+total|order\s+total/i.test(t)) out.total = money;
  }
  return out;
}

export function readOrderAsins(doc: Document): string[] {
  const root = doc.querySelector(SEL.orderDetails.root) ?? doc;
  const out: string[] = [];
  for (const a of Array.from(root.querySelectorAll(SEL.orderDetails.productLinks))) {
    if (isHidden(a)) continue;
    const m = ASIN_RE.exec(a.getAttribute("href") ?? "");
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** 卡后四位的取法与结算页一致:先认 ending in,再认掩码,都不中才退到最后一组。
 *  厂商取的是**第一个** 4 位连续数字,文案里的年份、分期数都会被误采。 */
export function last4FromText(t: string): string | undefined {
  if (!t) return undefined;
  const ending = /ending\s+(?:in|with)\s+(\d{4})/i.exec(t);
  if (ending) return ending[1];
  const masked = /(?:[*•·]\s*){2,}\s*(\d{4})/.exec(t);
  if (masked) return masked[1];
  const all = t.match(/\b\d{4}\b/g);
  return all ? all[all.length - 1] : undefined;
}

export function readOrderPaymentLast4(doc: Document): string | undefined {
  return last4FromText(text(doc.querySelector(SEL.orderDetails.paymentDetails)));
}

/** 报告 §4.3 第 1 步:优先用服务端下发的 platformTrackUrl,否则从页面找。
 *  两条路径都要,去重后取第一条。 */
export function findTrackingLink(doc: Document): string | null {
  for (const sel of SEL.orderDetails.trackLinks) {
    for (const a of Array.from(doc.querySelectorAll(sel))) {
      if (isHidden(a)) continue;
      const href = a.getAttribute("href") ?? "";
      if (URLS.trackHrefHints.some((h) => href.includes(h))) return href;
    }
  }
  return null;
}

// ── 包裹跟踪页 ───────────────────────────────────────────────────────

export function readTrackingNumber(doc: Document): string | null {
  const el = visible(doc, SEL.tracking.trackingId) ?? visible(doc, SEL.tracking.trackingIdFallback);
  const m = /tracking\s*id:?\s*([A-Za-z0-9]+)/i.exec(text(el));
  if (m) return m[1];
  // 退化选择器那条常常只有号本身,没有 "Tracking ID:" 前缀
  const bare = text(el);
  return /^[A-Za-z0-9]{8,}$/.test(bare) ? bare : null;
}

/** 承运商。
 *
 * 厂商的取法是 `.pt-delivery-card-wrapper .a-spacing-small` 文本 `split(" ")[2]`
 * —— 盲取第 3 个词(报告 §4.3)。"Shipped with AMZL US" 取到 "AMZL" 还算对,
 * "Package was shipped by USPS" 取到的是 "shipped"。所以这里按语义取,
 * 认不出返回 null:宁可是空,也不要往库里写一个 "shipped"。
 */
export function readCarrier(doc: Document): string | null {
  const t = text(visible(doc, SEL.tracking.cardSmall) ?? doc.querySelector(SEL.tracking.cardSmall));
  const m = /(?:shipped\s+(?:with|by)|carrier|delivered\s+by)\s*:?\s*([A-Za-z0-9][A-Za-z0-9 .&/-]{1,29})/i.exec(t);
  return m ? m[1].trim().replace(/[.,]$/, "") : null;
}

export function readDeliveryPromise(doc: Document): string | null {
  return text(visible(doc, SEL.tracking.promiseNowrap) ?? visible(doc, SEL.tracking.promise)) || null;
}

/** 把跟踪页的主状态文案映射到我们的封闭集。
 *  认不出返回 null —— 由服务端保留原状态,不猜。 */
export function readTrackingStatus(doc: Document): "not_shipped" | "in_transit" | "delivered" | "cancelled" | null {
  const t = text(visible(doc, SEL.tracking.primaryStatus));
  if (!t) return null;
  if (/cancell?ed/i.test(t)) return "cancelled";
  if (/delivered/i.test(t)) return "delivered";
  if (/out for delivery|in transit|on (its|the) way|shipped|arriving|package (has )?left/i.test(t)) return "in_transit";
  if (/not yet shipped|preparing|order placed|label created/i.test(t)) return "not_shipped";
  return null;
}

export interface TrackingEvent {
  raw_day: string | null;
  raw_time: string | null;
  description: string | null;
  city: string | null;
  state_code: string | null;
}

/** 报告 §4.3 extractTrackingEvents:在 #tracking-events-container 内遍历事件行,
 *  日期靠**向上回溯兄弟节点**找最近的日期头。
 *
 *  容器前缀不能丢 —— 页面别处也有同样类名的 .a-row 结构。 */
export function readTrackingEvents(doc: Document): TrackingEvent[] {
  const container = doc.querySelector(SEL.tracking.eventsContainer);
  if (!container) return [];

  const out: TrackingEvent[] = [];
  let currentDay: string | null = null;

  // 按文档顺序走:遇到日期头就更新当前日期,遇到事件行就带上它。
  // 比逐行向上回溯兄弟节点简单,结果一样,而且不会在结构嵌套时失效。
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (isHidden(child)) continue;
      const dateEl = child.matches(SEL.tracking.dateHeader)
        ? child
        : child.querySelector(SEL.tracking.dateHeader);
      if (dateEl && !child.matches(SEL.tracking.eventRow)) {
        currentDay = text(dateEl) || currentDay;
        continue;
      }
      if (child.matches(SEL.tracking.eventRow)) {
        const loc = text(child.querySelector(SEL.tracking.eventLocation));
        let city: string | null = null;
        let state: string | null = null;
        if (loc) {
          const parts = loc.split(",").map((x) => x.trim()).filter(Boolean);
          city = parts[0] ?? null;
          if (parts.length > 1) {
            // "CA 90001" → 去掉最后一个 token(邮编)剩下的是州
            const tail = parts[parts.length - 1].split(/\s+/);
            state = (tail.length > 1 ? tail.slice(0, -1).join(" ") : tail[0]) || null;
          }
        }
        out.push({
          raw_day: currentDay,
          raw_time: text(child.querySelector(SEL.tracking.eventTime)) || null,
          description: text(child.querySelector(SEL.tracking.eventMessage)) || null,
          city, state_code: state,
        });
        continue;
      }
      walk(child);
    }
  };
  walk(container);
  return out;
}
