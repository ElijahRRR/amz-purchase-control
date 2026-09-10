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

/** 输入:一个元素 → 输出:它此刻**真的画在页面上**吗。
 *
 *  与上面的 isHidden 是两条不同强度的判据,都要有:
 *   · isHidden 只看 **inline style / [hidden] / [aria-hidden]** 这些标记,
 *     解析文本时够用,而且对 `DOMParser` 造出来的离线文档也成立(没有布局);
 *   · isRendered 看的是**布局结果**(`getClientRects()`),要有真实布局才有意义,
 *     但它能挡住 isHidden 挡不住的那些:class 带来的 display:none、
 *     父级折叠、`visibility:hidden`、宽高为 0 的占位。
 *
 *  **为什么不能只看 `getComputedStyle(el).display`**:实测(SP/wf/address_probe.mjs)
 *  父级 `display:none` 时,子 `<a>` 自己的 computed display 仍然是 `inline`——
 *  只看它等于没判。`getClientRects().length > 0` 才是「有没有被布局出来」。
 *  这条判据抄的是厂商 v2.5.3:2166-2176 的 isRenderedElement,他们是拿真实页面
 *  校出来的。
 *
 *  拿不到 window(离线文档、跨域)时**退回 !isHidden**:
 *  「读不到布局」不是「它是隐藏的」,判成隐藏会让每条判据都落空。 */
export function isRendered(el: Element | null | undefined): boolean {
  if (!el) return false;
  if (!el.isConnected) return false;
  if (isHidden(el)) return false;
  const view = el.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") return true;
  let style: CSSStyleDeclaration;
  try {
    style = view.getComputedStyle(el);
  } catch {
    return true;
  }
  if (style.display === "none" || style.visibility === "hidden") return false;
  return el.getClientRects().length > 0;
}

/** 输入:一个根节点 + **有序**的选择器数组 → 输出:第一个既命中又渲染出来的元素。
 *
 *  数组的顺序是判据的可信度顺序(见 selectors.ts 文件头规矩二),
 *  所以这里是「按顺序试,谁先给出一个**渲染出来的**元素就用谁」,
 *  而不是「哪条命中得多用哪条」。
 *
 *  同一条选择器命中多个时取第一个渲染出来的 —— Amazon 常把隐藏的模板副本
 *  排在真身**前面**,裸 querySelector 取到的就是那一个。 */
export function pickFirstRendered<T extends Element>(
  root: Document | Element,
  selectors: readonly string[],
): T | null {
  for (const sel of selectors) {
    for (const el of Array.from(root.querySelectorAll<T>(sel))) {
      if (isRendered(el)) return el;
    }
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

// ── 导航栏:登录态 ────────────────────────────────────────────────────

/** `ok` 已登录 / `signed_out` 已登出 / `unknown` 读不出来。
 *
 *  **unknown 不是 ok。** 上层(认领闸、运营台)必须把这两个分开对待。 */
export type LoginState = "ok" | "signed_out" | "unknown";

/** 输入:一个页面/frame 的 URL → 输出:它是不是 Amazon 的登录页。
 *
 *  **这条判据的唯一定义处。** 用它的地方有五处:readLoginState 的第一句、
 *  账户入口 href 那一条、AmazonDriver.readLoginState 的等待条件与结论、guardLogin。
 *  它是可信度最高的那一条 —— 落到 /ap/signin 就是被登出了,DOM 怎么长都不改变
 *  这个结论。
 *
 *  为什么要单独拎出来:散成五处 `url.includes(URLS.signIn)` 的话,它就成了
 *  「没有任何测试盯着、改一处不会转红、改错方向最坏」的那种判据 ——
 *  写成 `startsWith`、挪个位置、改 `URLS.signIn`,五处一起失灵而测试全绿,
 *  失灵的方向恰好是把被登出的页面读成 ok。收成一处之后,盯住这一处就够了
 *  (test/dom.test.mjs 的 isSignInUrl 那几条),和 `task_queue.login_blocks_claim`
 *  是同一个做法:闸门的判断只有一处定义。
 *
 *  读不到 URL(跨域、文档还没就绪)时传进来的是空串 → `false`:
 *  **「读不到」不是「不在登录页」,只是这条判据这次用不上**,由别的判据接着说。 */
export function isSignInUrl(url: string | null | undefined): boolean {
  return !!url && url.includes(URLS.signIn);
}

/** 输入:一张 Amazon 页面 → 输出:这个浏览器此刻的登录态。
 *
 * **不读 Cookie** —— 插件没申请 `cookies` 权限,登录态留在浏览器 profile 里,
 * 我们只能从页面上看出来(见 CLAUDE.md 安全铁律)。
 *
 * 判据按可信度排,**不只认一个信号**:
 *   1. 页面 URL 落在 `/ap/signin` —— 最硬
 *   2. 账户入口的 href 指向 `/ap/signin` —— 结构判据
 *   3. 问候语是 "Hello, sign in" —— 文案,**只用来把结论推向"已登出"**
 *   4. `#nav-item-signout` 存在 —— 结构判据,这个节点只有签入的页面才发
 *   5. 账户入口的 href 指向账户首页 —— 结构判据
 *
 * 为什么文案只能往"已登出"那边推、不能用来断定"已登录":按英文问候语判
 * "已登录"是最脆的一条 —— 换个站点语言、Amazon 改一版文案就失灵,而失灵的方向
 * 恰好是最坏的那个(把登出的号判成登录正常,于是照样派单、照样超时)。
 * 反过来用它否定则是安全的:最坏结果是多一次误报,而误报会显示在运营台上,
 * 有人看得见。
 *
 * 三个信号一个都读不到 → `unknown`。**不许兜底成 ok** ——
 * 「读不到导航栏」和「读到了、是登录着的」是两件事,渲染成同一个结论
 * 就等于这道闸没有。
 */
export function readLoginState(doc: Document): LoginState {
  let url = "";
  try {
    url = doc.URL ?? "";
  } catch {
    url = "";   // 跨域/文档还没就绪时读不到,当作没有这条判据
  }
  // 最硬的一条:落在登录页上就是被登出了,DOM 里长什么样都不改变这个结论
  // （被登出的 /ap/signin 页面上照样可能挂着一整套"已登录"的导航栏模板）。
  if (isSignInUrl(url)) return "signed_out";

  // 隐藏副本不算数:Amazon 常把整套导航模板塞进 display:none 的壳里,
  // 里面那句 "Hello, sign in" 在一张登录着的页面上照样在 DOM 里。
  const link = visible<HTMLAnchorElement>(doc, SEL.nav.accountLink);
  const greet = visible(doc, SEL.nav.accountGreeting);
  // signOut **不要求可见**:账户浮层默认是 display:none 的,
  // 要求可见的话每一张签入页都会读成 unknown —— 一条永远不成立的判据
  // 比没有这条判据更糟,因为它看起来在那儿。
  const signOut = doc.querySelector(SEL.nav.signOut);

  if (!link && !greet && !signOut) return "unknown";   // 这页没有导航栏

  const href = link?.getAttribute("href") ?? "";
  if (isSignInUrl(href)) return "signed_out";

  // 文案在这里既是判据也是**否决票**:问候语明写着 sign in 时,
  // 哪怕页面上还留着个 signout 节点(模板残留),也按已登出算。
  const greeting = text(greet).toLowerCase();
  if (/^(hello,?\s*)?sign\s*in\b/.test(greeting)) return "signed_out";

  if (signOut) return "ok";
  if (href && SEL.nav.accountHrefHints.some((h) => href.includes(h))) return "ok";

  // 有导航栏,但没有一条判据说得准。宁可说"不知道"。
  return "unknown";
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

/** 输入:商品页 → 输出:**现在真的点得动**的加入购物车按钮,没有就是 null。
 *
 *  三道筛,缺一道都会白烧一个超时窗口:
 *   1. 两种形态都试(SEL.product.addToCart,第二条出自厂商 v2.5.3:2180);
 *   2. 渲染出来的才算(隐藏的模板副本常排在真身前面);
 *   3. `disabled` / `aria-disabled="true"` 的不算 —— 这一道是关键:
 *      `el.click()` 打在 disabled 按钮上**不抛错、返回 true**,浏览器却根本
 *      不派发 click 事件(SP/wf/payment_atc_probe.mjs 实测)。于是流程以为
 *      点成功了,接着等「跳转到购物车」等满 T.addToCart 才报 ADD_TO_CART_FAILED。
 *      真正的原因(按钮还没 hydrate)在事件流里一个字都看不到。
 *
 *  厂商 v2.5.3:2177-2191 同一个做法 —— 他们这一版才补上,而这正是
 *  「拿真实页面校准」才发现得了的那一类。 */
export function findAddToCartButton(doc: Document): HTMLElement | null {
  for (const sel of SEL.product.addToCart) {
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(sel))) {
      if (!isRendered(el)) continue;
      if ((el as HTMLInputElement | HTMLButtonElement).disabled) continue;
      if (el.getAttribute("aria-disabled") === "true") continue;
      return el;
    }
  }
  return null;
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

export interface CartState {
  lines: CartLine[];
  /** Active Items 那个容器**在不在**。
   *
   *  这一位就是「车是空的」与「行容器的选择器坏了」之间的全部区别:
   *  两种情况下 lines 都是 `[]`,而处置正相反 —— 前者可以继续,
   *  后者意味着我们对购物车一无所知,再往下走就是拿上一单的残留去结算。 */
  scopeFound: boolean;
  /** 容器里**画出来的、看起来像商品行**的节点有几个 —— 不管解析得出 ASIN 与否。
   *
   *  只有 scopeFound 是不够的:它只覆盖了「容器改名」这一种改版。行 class 改掉、
   *  或者行上的 data-asin 换个属性名(同一量级、同一概率的改版),容器照样在,
   *  lines 照样是 `[]` —— 于是「容器在而 0 行 = 真的空了」这句话不成立,
   *  而调用方据它认定车是空的,车里却实实在在留着上一单的商品。
   *
   *  `rowsSeen > 0 && lines.length === 0` 就是「我们已经读不懂购物车这一页了」。 */
  rowsSeen: number;
}

/** 报告 §4.2.2:只数 Active Items 里的行,并**同时告诉调用方那个容器在不在**。
 *  不带这个前缀就会把 "Saved for later" 和推荐位一起算进来。 */
export function readCartState(doc: Document): CartState {
  const scope = doc.querySelector(SEL.cart.activeItems);
  if (!scope) return { lines: [], scopeFound: false, rowsSeen: 0 };
  const rows = Array.from(scope.querySelectorAll(SEL.cart.line));
  const lines = rows
    .map((row) => {
      const asin = row.getAttribute("data-asin") ?? "";
      const qtyEl =
        row.querySelector(SEL.cart.qtyValue) ?? row.querySelector(SEL.cart.qtyNonEditable);
      const n = Number(text(qtyEl).replace(/[^\d]/g, ""));
      return { asin, quantity: Number.isFinite(n) && n > 0 ? n : null };
    })
    .filter((l) => l.asin.length > 0);
  // 行节点数按两条判据取**并集**:行 class 改名时 `[data-asin]` 还在,
  // data-asin 换属性名时行 class 还在 —— 两种改版各瞎掉一条,不会同时瞎。
  // 只数**渲染出来**的:容器里躺着的隐藏行模板不是「车里的东西」,
  // 数上它会把一辆真空车说成「行解析坏了」。
  const seen = new Set<Element>([...rows, ...Array.from(scope.querySelectorAll("[data-asin]"))]);
  let rowsSeen = 0;
  for (const el of seen) if (isRendered(el)) rowsSeen += 1;
  return { lines, scopeFound: true, rowsSeen };
}

/** 只要行、不问容器在不在。**新代码尽量用 readCartState** ——
 *  这个薄封装留着是因为「车里有什么」和「读得到吗」在大多数调用点上确实是一件事,
 *  但凡是要拿 `length === 0` 下结论的地方,都必须走 readCartState。 */
export function readCartLines(doc: Document): CartLine[] {
  return readCartState(doc).lines;
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
        unitPrice: parseMoney(firstText(panel, SEL.checkout.panelUnitPrice)),
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

/** 下单按钮。做成纯函数是为了能对着夹具验 ——
 *  之前它只在 amazon.ts 里被裸 querySelector 取,离线自检一条断言都覆盖不到,
 *  于是「选中的其实是隐藏的 csrf input」这种事只能等到真实环境里才发现,
 *  而那时的表现是「每一单都超时,而且全部落进『可能已下单』桶」。 */
export function findSubmitOrderButton(doc: Document): HTMLInputElement | null {
  return doc.querySelector<HTMLInputElement>(SEL.checkout.submitOrder);
}

export function readGrandTotal(doc: Document): string | undefined {
  return parseMoney(text(doc.querySelector(SEL.checkout.grandTotal)));
}

export interface OrderSummary {
  shipping?: string;
  tax?: string;
  beforeTax?: string;
  /** 页面上写着 "Order total" 的那一行。 */
  orderTotal?: string;
  /** 页面上写着 "Grand Total" 的那一行。 */
  grandTotal?: string;
}

/** 报告没记结算页的运费/税选择器(厂商是在**订单详情页**读的)。
 *  所以这里按 label 文案扫行,而不是赌一个 id —— 文案比 id 稳。
 *
 *  但**扫描范围必须先收窄**,两道:
 *
 *  ① 限定在订单小结的容器里(SEL.checkout.summaryTables,出自 v2.5.3 :2530/:2844)。
 *  ② 逐行过滤隐藏节点(复用本文件的 isHidden)。
 *
 *  为什么:实测我们自己的夹具,全文档扫到的 "Order total" 是隐藏粘性底栏
 *  (#checkout-sticky-summary,display:none,排在真表**之前**)里的过期值
 *  $1,299.99,而真值是 $2,241.86。今天只有总额被污染、而总额恰好没人用,
 *  所以这个缺陷是**沉默**的 —— Amazon 哪天往粘性条里也放上 Shipping & handling,
 *  现在正确的运费/税就跟着错,而「非空」那种断言照样绿。
 *
 *  `orderTotal` 与 `grandTotal` **分成两个键**:有礼品卡时这两行同时存在
 *  且含义不同(货款 vs 这张卡要扣的钱)。合成一个 total 等于让「先命中谁」
 *  决定语义 —— 那正是两种不同的情况渲染出同一个结果。 */
export function readOrderSummary(doc: Document): OrderSummary {
  const out: OrderSummary = {};
  let root: ParentNode = doc;
  for (const sel of SEL.checkout.summaryTables) {
    const box = visible(doc, sel);
    if (box) { root = box; break; }
  }
  const rows = Array.from(root.querySelectorAll("tr, .a-row, li"));
  for (const row of rows) {
    if (isHidden(row)) continue;
    const t = text(row);
    if (!t || t.length > 120) continue;
    const money = parseMoney(t);
    if (!money) continue;
    if (out.shipping === undefined && /shipping\s*(&|and)?\s*handling/i.test(t)) out.shipping = money;
    else if (out.tax === undefined && /(estimated\s+)?tax(\s+to\s+be\s+collected)?/i.test(t) && !/before\s+tax/i.test(t)) out.tax = money;
    else if (out.beforeTax === undefined && /total\s+before\s+tax/i.test(t)) out.beforeTax = money;
    else if (out.grandTotal === undefined && /grand\s+total/i.test(t)) out.grandTotal = money;
    else if (out.orderTotal === undefined && /order\s+total/i.test(t)) out.orderTotal = money;
  }
  return out;
}

/** 卡后四位。厂商取的是文案里**第一个** 4 位连续数字(报告 §4.2.4 第 3 项),
 *  文案里的年份、分期数、金额都会被误采。这里先认"ending in/with",
 *  再认掩码,都不中才退到**最后**一组 4 位数字。 */
export function readPaymentLast4(doc: Document): string | undefined {
  // **先收窄到支付面板,再逐条候选取第一个可见的。**
  //
  // 裸 doc.querySelector 会先命中 Amazon 的同 id 隐藏模板副本:实测在一张
  // 隐藏副本(尾号 0000)排在真身(8738)前面的页面上,裸取读出的是 0000。
  // 同一个文件里 readInStock / pickQuantitySelect / findInterstitialButton
  // 都走了 visible(),偏偏支付这条没走 —— 而这一列是拿去跟期望卡比对的。
  //
  // 面板拿不到就当读不到(返回 undefined),**不退到文档级**:退回去就等于
  // 把刚收窄的作用域又放开,而调用方看到的是一个长得很正常的四位数。
  const panel = visible(doc, SEL.checkout.payment.panel);
  if (!panel) return undefined;
  const t = firstVisibleText(panel, SEL.checkout.payment.selectedTexts);
  if (!t) return undefined;
  const ending = /ending\s+(?:in|with)\s+(\d{4})/i.exec(t);
  if (ending) return ending[1];
  const masked = /(?:[*•·]\s*){2,}\s*(\d{4})/.exec(t);
  if (masked) return masked[1];
  const all = t.match(/\b\d{4}\b/g);
  return all ? all[all.length - 1] : undefined;
}

// ── 地址:结算页 → 地址选择页 → 异步注入的表单 ──────────────────────
//
// 这一段原先整个长在 amazon.ts 里(裸 querySelector + 时序混在一起),
// 于是 test/dom.test.mjs 够不着 —— 地址是整条链路上唯一「填错了会把货寄给别人」
// 的环节,而它的离线断言曾经是 **0 条**。下沉成纯函数就是为了能对着夹具验。
//
// 三个函数**全部走 isRendered**,不是 isHidden:结算页上那个折叠着的地址簿
// (aok-hidden + display:none)里有一整套同名节点,包括一个「新建地址」<a>。
// 只按标记判隐藏挡不住它 —— 实测(SP/wf/address_probe.mjs)那个 <a> 自己的
// computed display 是 inline,父级才是 none。

/** 输入:结算页 → 输出:「更改收货地址」入口,四条判据里第一个渲染出来的。
 *  全落空返回 null —— 调用方**必须**据此报错,不许继续往下等。 */
export function findAddressChangeEntry(doc: Document): HTMLElement | null {
  return pickFirstRendered<HTMLElement>(doc, SEL.address.changeAddress);
}

/** 输入:地址选择页 → 输出:「新增地址」入口(渲染出来的那个)。
 *
 *  这个 id 在结算页折叠着的地址簿里也有一份。**先确认页面真的换到 /address 页**
 *  再调它(amazon.ts 用 URL 判据把这件事挡在前面),这里的 isRendered 是第二道。 */
export function findAddNewAddressEntry(doc: Document): HTMLElement | null {
  return pickFirstRendered<HTMLElement>(doc, [SEL.address.addNew]);
}

/** 输入:任意页面 → 输出:地址表单的姓名输入框(渲染出来的那个)。
 *
 *  它是这条流上的两个判据合一:
 *   · 结算页上有它 = 买家号还没有任何地址,Amazon 直接给了内联表单,不用点「更改」;
 *   · 点完「新增地址」之后有它 = 那张**异步注入**的表单到位了。
 *
 *  必须走 isRendered:Amazon 的地址表单是从隐藏模板克隆出来的,
 *  页面上常同时存在一份 display:none 的副本(见 address-form-async.html 夹具)。
 *  取到隐藏那份的后果是 setInput 往一个没人看的 DOM 里写字,然后保存按钮点下去
 *  什么都没发生 —— 表现是 ADDRESS_FORM_TIMEOUT,而地址其实一个字都没填进去。 */
export function findAddressFormNameField(doc: Document): HTMLInputElement | null {
  return pickFirstRendered<HTMLInputElement>(doc, [SEL.address.fullName]);
}

/** 输入:地址选择页 → 输出:地址列表区(渲染出来的那个)。 */
export function findAddressSection(doc: Document): HTMLElement | null {
  return pickFirstRendered<HTMLElement>(doc, [SEL.address.section]);
}

/** 输入:任意页面 → 输出:收货地址栏里**画出来的**那份文本(空白已归一);
 *  没有这一栏就是 null。
 *
 *  走 pickFirstRendered 而不是裸 querySelector:结算页上这个 id 可能有隐藏的
 *  第二份(与地址表单、购物车行同一个模板做法),读到那一份就会拿一段
 *  跟眼前这一单无关的地址文本去下结论。 */
export function readAppliedAddressText(doc: Document): string | null {
  const el = pickFirstRendered(doc, [SEL.checkout.addressText]);
  return el ? text(el) : null;
}

/** 点完保存之后,页面上出现的是哪一种结果。三种之外返回 null(还没出结果)。
 *
 *  `saved`      收货地址栏**换了内容** = 这次保存生效了
 *  `alerts`     表单校验提示有文字 = 得再点一次保存
 *  `suggestion` Amazon 的地址建议弹窗出现了 = 得先选「原始地址」
 *
 *  **三条都要求「渲染出来」而不是「节点在」。** Amazon 把建议弹窗的壳子和三条
 *  校验提示节点一直留在 DOM 里(见 address-form-async.html 夹具),只判
 *  `querySelector(...)` 非空的话,每一单在保存后的第一次探测就会认定
 *  「弹窗出现了」,于是去点一个折叠着的 radio、再点一次保存,来回三轮然后失败。
 *  校验提示那一条还要额外要求**有文字**:空壳节点是常态。
 *
 *  **`before` 是点保存之前收货地址栏的文本,必传。** 「页面上有地址栏」不等于
 *  「这次保存生效了」:更改地址有一种形态是**就地弹窗**(不跳转 /address),
 *  那条路上文档一直是结算页,而结算页上本来就有生效中的旧地址栏
 *  (checkout.html:216 摆的就是它)。不比对文本的话,点完保存的第一拍就判 saved,
 *  校验提示与地址建议弹窗整段处理被跳过 —— 弹窗还挡着、地址根本没换,
 *  而下游只会说「收货地址栏里没有 收件人 X」,也就是「Amazon 用了别的地址」,
 *  与真实原因(我们没等保存结果)完全是两回事,却渲染成同一句话。
 *  页面上没有这一栏时传 null(/address 页那条路),那时「出现了」本身就是变化。
 *
 *  做成纯函数是为了能对着夹具验 —— 这三种结果原先是 amazon.ts 里两段
 *  `sleep(1200)` 之后各看一眼的快照,一条离线断言都覆盖不到。 */
export type AddressSaveOutcome = "saved" | "alerts" | "suggestion";

export function readAddressSaveOutcome(
  doc: Document,
  before: string | null,
): AddressSaveOutcome | null {
  // 少传 before 时**当场报错**,不要静默按「页面上有地址栏 = saved」办。
  // TS 那边这个参数是必填的,这一句拦的是从 JS 调进来的(domkit 就是给测试用的):
  // 少传一个参数就退回缺陷前的行为、而且照样返回一个看着正常的值,
  // 正是这条判据当初没被任何断言拦住的那种坏法。
  if (before === undefined) {
    throw new Error("readAddressSaveOutcome 缺第二个参数 before:保存前的收货地址栏文本(没有就传 null)");
  }
  const now = readAppliedAddressText(doc);
  if (now !== null && now !== before) return "saved";
  for (const sel of SEL.address.validationAlerts) {
    if (text(pickFirstRendered(doc, [sel]))) return "alerts";
  }
  if (pickFirstRendered(doc, [SEL.address.suggestionPopup])) return "suggestion";
  return null;
}

// ── 「选择器坏了」还是「页面慢」 ──────────────────────────────────────

/** 一组选择器一个都没给出可用元素时,到底是哪种情况。 */
export type SelectorMiss =
  /** 一个节点都没匹配到 —— **选择器坏了**(Amazon 改版),重试多少次都一样。 */
  | { kind: "no_match"; tried: number }
  /** 匹配到了节点,但没有一个渲染出来 —— **页面慢**,或者入口被折叠着。 */
  | { kind: "not_rendered"; matched: string; count: number };

/** 输入:根节点 + 那组选择器 → 输出:这次落空属于哪一种。
 *
 *  这个函数存在的理由就是 README 反复说的那条:
 *  **两种不同的情况不许渲染出同一个结果。**「选择器坏了」和「页面慢」
 *  今天都长成 ADDRESS_FORM_TIMEOUT,而前者要改代码、后者重试就好。
 *  错误 detail 里带上这一句,运营台上一眼就能分开。 */
export function diagnoseMiss(root: Document | Element, selectors: readonly string[]): SelectorMiss {
  for (const sel of selectors) {
    const n = root.querySelectorAll(sel).length;
    if (n > 0) return { kind: "not_rendered", matched: sel, count: n };
  }
  return { kind: "no_match", tried: selectors.length };
}

/** diagnoseMiss 的中文说法,直接进 DriverError 的 detail —— 也就是**运营台上的字**。
 *
 *  **只说页面上看到了什么,不预告系统会怎么处置这一单。**
 *  「选择器坏了」这一档今天仍然落在 ADDRESS_FORM_TIMEOUT 上,而那是个可重试码:
 *  services/task_retry.py 的自动重试正是按 error_codes.RETRYABLE 挑单
 *  (registry/settings.py 的 auto_retry_max 默认 0,开关一开就生效)。
 *  detail 里写「重试无用」而系统照样把它重拍 N 次,就是在界面上写一句
 *  系统不会兑现的话 —— 这条判据本身是给人看的,机器读不到它。
 *
 *  要让机器也用上这个区分,得给「选择器坏了」单开一个归 TO_MANUAL 的错误码。
 *  错误码是封闭集(docs/01 §4 ↔ services/error_codes.py ↔ core/codes.ts),
 *  开口子是跨线的事,不在这一条里定。 */
export function describeMiss(root: Document | Element, selectors: readonly string[]): string {
  const d = diagnoseMiss(root, selectors);
  return d.kind === "no_match"
    ? `${d.tried} 条判据在页面上一个节点都没匹配到 —— 多半是 Amazon 改版了:` +
      `这一条要改选择器,原样重拍同一条判据结果相同`
    : `「${d.matched}」匹配到 ${d.count} 个节点但没有一个渲染出来 —— 页面还没画完或入口被折叠着`;
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
  // 「已取消」有两种渲染形态,判据要把两种都盖住:
  //   ① 顶部的告警框 .a-alert-heading(报告 §4.3 记的那种);
  //   ② #shipment-top-row 里的状态行 od-status-message —— 厂商 v2.5.3:4057-4070
  //      专门补的一档,说明线上已经出现了不带告警框的取消页。
  // 实测(SP/wf/orderstate_probe.mjs,对着我们自己的 dist/domkit.js 跑):
  // 只有 ② 的那种形态,我们原先判 "ok",厂商判 cancelled ——
  // 一张已经取消的订单会被当成正常单继续同步物流。
  // US 站不需要厂商正则里的 キャンセル / annul[ée](CLAUDE.md:首期只做 US)。
  const status = text(pickFirstRendered(doc, SEL.orderDetails.statusMessage));
  if (/cancell?ed/i.test(`${heading} | ${status}`)) return "cancelled";
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
  return last4FromText(firstText(doc, SEL.orderDetails.paymentDetails));
}

/** 一组选择器里第一个取到非空文本的。
 *  Amazon 同一样东西在不同页面版本上挂不同 class,一个个试比赌一个稳。 */
function firstText(root: ParentNode, sels: readonly string[]): string {
  for (const sel of sels) {
    const t = text(root.querySelector(sel));
    if (t) return t;
  }
  return "";
}

/** 报告 §4.3 第 1 步:优先用服务端下发的 platformTrackUrl,否则从页面找。
 *  两条路径都要,去重后取第一条。 */
export function findTrackingLink(doc: Document): string | null {
  // **先按 href 找,不管它挂在什么 class 上。**
  //
  // 按钮外壳的 class 是 Amazon 改得最勤的东西;而 /ship-track?、
  // /progress-tracker/package/ 这两个 URL 形状多年没动。
  // 原先拿 class 当入口闸门,class 一变就返回 null —— 而表现是
  // 「这一单还没发货」(shipment.ts 把没有链接当成 not_shipped),
  // 于是一批已经在路上的包裹会被记成未发货,没有任何地方报错。
  // 厂商 v2.5.1 也做了同一个翻转。
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    if (isHidden(a)) continue;
    const href = a.getAttribute("href") ?? "";
    if (URLS.trackHrefHints.some((h) => href.includes(h))) return href;
  }
  // 兜底:href 判据没命中,但按钮确实在那几个已知外壳里。
  //
  // **这里必须再看一眼按钮上的字。** trackLinks 里的
  // `.a-button-stack.a-spacing-mini a` 就是订单卡片右侧那一摞按钮 ——
  // 「Track package」和「Cancel items」「Return items」是邻居。
  // 只要 href 非空就拿,等于允许在 Amazon 改了 URL 形状的那天
  // 把跟踪同步变成一次**取消订单**的跳转。宁可返回 null。
  for (const sel of SEL.orderDetails.trackLinks) {
    for (const a of Array.from(doc.querySelectorAll(sel))) {
      if (isHidden(a)) continue;
      const href = a.getAttribute("href") ?? "";
      if (!href) continue;
      const label = (a.textContent ?? "").toLowerCase();
      if (label.includes("track") || href.toLowerCase().includes("track")) return href;
    }
  }
  return null;
}

/** 跟踪页是不是「Amazon 这会儿给不了轨迹」。
 *
 *  与「我们没解析出来」分开 —— 都表现为 0 条轨迹的话,选择器坏了会被当成
 *  「这批单都还没发货」,一直到有人发现整整一周没有任何轨迹为止。 */
export function isTrackingUnavailable(doc: Document): boolean {
  const body = doc.body?.textContent ?? "";
  return body.toLowerCase().includes(SEL.tracking.unavailableText);
}

// ── 包裹跟踪页 ───────────────────────────────────────────────────────

export function readTrackingNumber(doc: Document): string | null {
  const el = pickFirstRendered(doc, SEL.tracking.trackingIds);
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

// ── 结算页:礼品卡抵扣(护栏基数的另一半)────────────────────────────

/** 一组选择器里第一个**可见**且有文本的。
 *
 *  与上面那个 firstText 的差别只有一处:它不看可见性。
 *  两个都留着是有意的 —— 订单详情页那几处读的是已经成交的静态页,
 *  结算页则满是同 id 的隐藏模板副本,那里必须过滤。 */
function firstVisibleText(root: Document | Element, sels: readonly string[]): string {
  for (const sel of sels) {
    const t = text(visible(root, sel));
    if (t) return t;
  }
  return "";
}

export interface GiftCardRead {
  /** 这张结算页上有没有礼品卡/余额抵扣。 */
  applied: boolean;
  /** 抵扣了多少。**认出抵扣行却读不出金额时是 undefined,不是 "0"** ——
   *  「抵扣 0 元」与「不知道抵扣多少」是两件事,后者根本不许下单。 */
  amount: string | undefined;
}

/** 结算页的礼品卡/余额抵扣。出处 v2.5.3 popup.js:2052-2079。
 *
 * 三段式,与厂商一致:隐藏表单标记 → closest 到所在小结行 → 行内取金额元素。
 * 判据是**表单标记而不是文案**,与页面语言无关 —— v2.5.1 靠
 * `includes("Paying with Amazon Points")` 判,换个站点语言就瞎。
 *
 * 为什么必须有这个函数:readGrandTotal 读的 `.grand-total-cell` 是
 * **这张卡要扣的钱**,礼品卡垫过之后它比货款小,全额抵扣时就是 0.00。
 * 护栏拿它跟 price_cap 比,在任何有礼品卡余额的买家号上就是空的
 * (实测:礼品卡垫 1100 的 2241.86 元单,price_cap=1200 照样放行)。
 *
 * 两个坑,都不是理论上的:
 *
 *  1. **符号。** parseMoney 的正则只认紧贴数字的负号,`"-$5.09"` 会被读成
 *     `"5.09"`(负号在 `$` 前),而 `"$-5.09"` 读成 `"-5.09"`。抵扣行两种写法
 *     都出现过。所以这里显式取绝对值语义 —— 这一格的含义就是「减掉了多少」,
 *     正负号是排版,不是数据。
 *  2. **隐藏模板。** 可见性判在**小结行**上而不是 marker 上:marker 本身就是个
 *     隐藏表单字段,拿 isHidden 判它会把真的那条也一起丢掉。
 *     行都找不到的 marker 按「真的」算(applied=true、金额未知)——
 *     那一档服务端会拒,宁可停一单,不许放行一次没算过的护栏。 */
export function readGiftCardDeduction(doc: Document): GiftCardRead {
  const markers = Array.from(doc.querySelectorAll(SEL.checkout.giftCard.marker));
  let applied = false;
  let sum = 0;
  let parsed = 0;

  for (const marker of markers) {
    let row: Element | null = null;
    for (const sel of SEL.checkout.giftCard.rowAncestors) {
      row = marker.closest(sel);
      if (row) break;
    }
    // 隐藏模板里的抵扣行不算数(Amazon 把整套小结模板塞进 display:none 的壳里)
    if (row && isHidden(row)) continue;
    applied = true;
    if (!row) continue;                       // 行找不到:算数,但金额未知
    const raw = firstVisibleText(row, SEL.checkout.giftCard.amounts);
    const money = parseMoney(raw);
    if (money === undefined) continue;
    const n = Math.abs(Number(money));         // 见上面「坑 1」
    if (!Number.isFinite(n)) continue;
    sum += n;
    parsed += 1;
  }

  if (!applied) return { applied: false, amount: undefined };
  return { applied: true, amount: parsed > 0 ? sum.toFixed(2) : undefined };
}

/** 结算页上「已选支付方式」的槽位数。读不到支付面板时返回 undefined。
 *
 * **为什么单独数一个数,而不是让 readPaymentLast4 多返回一位。**
 * 那一位答的是「第一个槽位里是哪张卡」,而 Amazon 允许把一单拆到多个已选支付
 * 方式上。买家号后台被加了第二张卡、Amazon 把一单拆成「公司卡 4417 + 另一张
 * 9021」时:第一个槽位读出 4417,与买家号配的期望卡一致 → 护栏放行 → 下单 →
 * 另一张卡也被扣了钱。库里 payment_last4 记的是 4417,事件流里没有任何痕迹,
 * 运营看到的是一道「已核过支付卡」的绿灯。**一道只管第一张卡的支付闸,
 * 比没有支付闸更危险** —— 后者至少不会让人以为核过了。
 *
 * 这里只数,不下结论:礼品卡余额自己也占一个槽位(夹具 checkout-giftcard.html
 * 就是这个形态,两个槽位里第二个是 Gift Card Balance),该不该扣掉它,
 * 得由同时知道 gift_card.applied 的那一方来判 —— 那是服务端。
 * 插件在这一档**不拦**:拦了就是插件自己吞掉,运营看不见。
 *
 * 数的是**可见**槽位:Amazon 把整套支付模板塞进 display:none 的壳里,
 * 隐藏副本一起数会把每一张普通单都算成拆分支付。
 *
 * 返回 undefined(而不是 0)表示「没数着」:老形态的结算页把卡文案直接放在
 * 面板里、根本没有 selected-payment-method 这层壳(夹具 checkout.html 就是),
 * 那种页面 0 是真的 0;而面板都找不到时报 0,会让服务端以为「数过了,只有零个」。 */
export function readPaymentSlots(doc: Document): number | undefined {
  const panel = visible(doc, SEL.checkout.payment.panel);
  if (!panel) return undefined;
  return Array.from(panel.querySelectorAll(SEL.checkout.payment.selectedSlots))
    .filter((el) => !isHidden(el)).length;
}

// ── 支付卡切换:结算页入口 → 支付选择页 → 确认 ────────────────────────
//
// 所有者定稿①(2026-09-09):替买家号切换支付卡。**先切后验,验在服务端** ——
// 这一段只回答「页面上该点哪个」,切没切成由服务端 guard-check 说了算。
//
// ⚠️⚠️ 这三个函数吃的判据是 SEL.checkout.payselect,那是**厂商按截图推的**
// (他们自己承认支付选择页没有 DOM 样本),可信度是全仓最低的一档。
// 所以三个函数一律**宁可返回 null**:调用方(amazon.ensurePaymentCard)收到 null
// 就停下、抛 PAYMENT_METHOD_UNEXPECTED,绝不"差不多就是它了"往下点。
// 这一步点错的后果不是这一单失败,是拿**别人的卡**付了钱。

/** 输入:结算页文档 → 输出:支付面板里那个「更改支付方式」入口,没有就是 null。
 *
 *  **限定在 payment.panel 里面**,拿不到面板就直接 null(不退到文档级):
 *  同样的 href 在页脚「管理支付方式」和账户浮层里各有一份,文档级取到那一个
 *  会把 iframe 导到钱包页,再也回不来。这和 readPaymentLast4 收窄作用域是同一条理由,
 *  只是后果更重:那边读错一个数,这边点错一个链接。 */
export function findPaymentChangeEntry(doc: Document): HTMLElement | null {
  const panel = visible(doc, SEL.checkout.payment.panel);
  if (!panel) return null;
  return pickFirstRendered<HTMLElement>(panel, SEL.checkout.payment.changeEntry);
}

/** 输入:支付选择页文档 → 输出:确认按钮,**不可用时是 null**。
 *
 *  两道过滤缺一不可:
 *   · 渲染出来的那一个 —— Amazon 把整套 ppw 组件的模板塞在隐藏壳里,
 *     隐藏副本上的 disabled 常常是没置的,裸取会取到一个"可用"的假按钮;
 *   · 没有 disabled —— click() 打在 disabled 按钮上**返回 true**(元素在),
 *     浏览器却根本不派发事件。于是「点过了」和「没点动」长成同一个结果,
 *     然后等满一个预算才报错,而报出来的原因还是错的。
 *     (同一个坑在商品页加购按钮上踩过一次,见 findAddToCartButton。) */
export function findPaymentConfirmButton(doc: Document): HTMLElement | null {
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(SEL.checkout.payselect.confirm))) {
    if (!isRendered(el)) continue;
    if ((el as HTMLButtonElement).disabled) continue;
    if (el.getAttribute("aria-disabled") === "true") continue;
    return el;
  }
  return null;
}

export interface CardRadioHit {
  /** 要点的那个单选钮。 */
  radio: HTMLInputElement;
  /** 它所属的那张卡的最小块 —— 尾号就是在这个块里比中的。 */
  block: Element;
  /** **比中的是哪一段文字**。写进事件流与失败 detail:选择器改版时,
   *  「比中了 4417」和「在有效期里比中了 4417」得能分开看。 */
  matchedText: string;
}

/** 页面上此刻**渲染出来的**卡片单选钮。隐藏模板里的那些一概不算 ——
 *  它们既不该被点中,也不该在「这个块里有几个 radio」那道计数里占位。
 *
 *  厂商数的是全部(含隐藏),那会让一张自带隐藏模板的卡永远判不出唯一命中;
 *  我们数渲染出来的,同时把二次比对也限定在渲染出来的细节元素上 ——
 *  隐藏副本里预填的那张卡号就够不着了。 */
function renderedRadios(root: Document | Element): HTMLInputElement[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>(SEL.checkout.payselect.radio))
    .filter((el) => isRendered(el));
}

/** 把文本里「像有效期的那一段」抹掉,再拿去比尾号。
 *
 *  **这是这一整段最要紧的一条。** 卡片块里必然写着有效期:
 *      Visa ending in 4417 · Expires 08/2029
 *  而尾号判据是「四位连续数字」。不抹的话,一个买家号被配成期望卡 `2029`
 *  时,这张 4417 的卡会被判成命中 —— 然后我们替他刷了一张根本不是他要的卡。
 *  服务端那道 PAYMENT_METHOD_UNEXPECTED 事后会拦住这一单(它读的是结算页
 *  真正选中的尾号 4417 ≠ 2029),所以钱不会花错;但事件流里会写着
 *  「支付卡已切换 → 2029」,而实际切成了 4417 —— 一句假话比一次失败更难查。
 *
 *  抹的是 `数字/数字` 与 `数字-数字` 这种月/年写法(08/2029、8-29、08/29),
 *  不管前面有没有 "Expires":换个站点语言那个词就变了,而斜杠不变。 */
function stripExpiry(t: string): string {
  return t.replace(/\b\d{1,2}\s*[/-]\s*\d{2,4}\b/g, " ");
}

/** 输入:支付选择页文档 + 期望尾号 → 输出:**唯一**命中的那张卡,否则 null。
 *
 *  与厂商 v2.5.3 :2081-2144 同一套判据,但有三处刻意的不同,三处都是同一个立场:
 *  **宁可不切,不可切错。**
 *
 *   1. **唯一才算数。** 厂商 `return radio` 在第一个命中处就返回。一个买家号
 *      钱包里有两张尾号相同的卡(换卡不换号、虚拟卡、同号的借记/信用)不是奇事,
 *      那时厂商点的是排在前面的那一张 —— 而两张卡是两个账、两笔额度、
 *      甚至两个持卡人。我们数完全部命中,不是恰好一个就返回 null,
 *      让这一单转人工由人去看。
 *   2. **隐藏的不算。** radio 的计数与细节元素的二次比对都只看渲染出来的,
 *      理由见 renderedRadios。
 *   3. **有效期年份不能当尾号。** 见 stripExpiry。
 *
 *  期望尾号不是四位数字时直接 null:这一列是人在运营台上手填的,
 *  填了个 "**** 4417" 或者 "4417 (Visa)" 的话,与其用一条模糊匹配去猜他的意思,
 *  不如什么都不做 —— 猜错的代价是刷错卡。 */
export function findCardRadioByLast4(doc: Document, last4: string): CardRadioHit | null {
  const want = (last4 ?? "").trim();
  if (!/^\d{4}$/.test(want)) return null;

  const S = SEL.checkout.payselect;
  const pattern = new RegExp(`(^|\\D)${want}(\\D|$)`);
  const hits: CardRadioHit[] = [];

  for (const radio of renderedRadios(doc)) {
    // ① 先按容器候选找块,并要求块内**恰好一个**渲染出来的 radio。
    //    多于一个说明这个候选圈大了(整个列表都挂着 instrument-row 之类的 class),
    //    那时块里的文本是所有卡的文本拼在一起,拿它比尾号必然比中。
    let block: Element | null = radio.closest(S.blocks.join(", "));
    if (block && renderedRadios(block).length !== 1) block = null;

    // ② 圈大了就往上爬,最多 8 层,找「只含这一个 radio 且文本里有目标尾号」
    //    的**最小**块。爬到某一层出现两个 radio 就停 —— 再往上只会更大。
    let cur: Element | null = radio.parentElement;
    for (let depth = 0; !block && cur && depth < 8; depth += 1) {
      const n = renderedRadios(cur).length;
      if (n === 1 && pattern.test(stripExpiry(text(cur)))) { block = cur; break; }
      if (n > 1) break;
      cur = cur.parentElement;
    }
    if (!block) continue;

    // ③ 在**细节元素**上二次比对。块里还有有效期、账单邮编、积分数,
    //    拿整块文本比等于把这些都当成候选尾号。细节元素一个都没有时
    //    才退回整块(厂商也是这么退的)—— 那一档更容易误判,所以 stripExpiry
    //    在两条路上都要走。
    const details = Array.from(block.querySelectorAll<HTMLElement>(S.details.join(", ")))
      .filter((el) => isRendered(el));
    const candidates: Element[] = details.length > 0 ? details : [block];

    const values: string[] = [];
    for (const el of candidates) {
      values.push(text(el));
      for (const attr of ["aria-label", "placeholder", "value", "data-last-four", "data-tail"]) {
        const v = el.getAttribute(attr);
        if (v) values.push(v.replace(/\s+/g, " ").trim());
      }
    }

    const matched = values.find((v) => pattern.test(stripExpiry(v)));
    if (matched !== undefined) {
      hits.push({ radio, block, matchedText: matched.slice(0, 120) });
    }
  }

  return hits.length === 1 ? hits[0] : null;
}
