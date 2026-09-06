/** 所有 Amazon 选择器集中在这里,每一条都标出处。
 *
 * 出处是 `AMZ-Purchase-Assistant/docs/插件功能深度分析.md` —— 对厂商插件 v2.4.1
 * 的源码级分析,里面记着他们几万单实际在用的选择器。标了「报告未记载」的是我们
 * 自己按 Amazon 常见形态补的,可信度低一档,坏了先怀疑它们。
 *
 * §10.5 说这套东西对 Amazon 的页面结构是硬依赖:Amazon 改版就得改这里。
 * 集中放的意义就在于改版时只改一个文件。
 */

export const SEL = {
  // ── 全站导航栏:判登录态 (报告未记载 —— 厂商不判登录态,他们读 Cookie) ──
  //
  // 我们**不申请 cookies 权限**,登录态只能从页面上看出来。判据按可信度排:
  //   1. URL 落在 /ap/signin —— 最硬,不需要解析任何 DOM
  //   2. #nav-item-signout 在不在 —— 结构判据。这个节点只有签入时才会渲染出来
  //   3. #nav-link-accountList 的 href 指向哪 —— 结构判据。未签入时它指向
  //      /ap/signin?openid...,签入时指向 /gp/css/homepage.html
  //   4. #nav-link-accountList-nav-line-1 的文案 —— **只做辅助**。
  //      按英文文案硬判是最脆的一种:换个站点语言、Amazon 改一版问候语就失灵,
  //      而且页面上到处都能出现 "sign in" 这三个字(页脚链接、商品标题)。
  //      所以文案只用来把结论往 signed_out 推,从不用来断定"已登录"。
  nav: {
    /** 账户入口。未签入时 href 指向 /ap/signin,签入时指向账户首页。 */
    accountLink: "#nav-link-accountList",
    /** 问候语那一行:签入是 "Hello, <名字>",未签入是 "Hello, sign in"。 */
    accountGreeting: "#nav-link-accountList-nav-line-1",
    /** 「Sign Out」。**只有签入的页面才有这个节点** —— 未签入时 Amazon 压根不发它。
     *  不要求它可见:账户浮层默认 display:none,要求可见的话每张签入页都会读成"未知"。 */
    signOut: "#nav-item-signout",
    /** 账户入口指向这里 = 已签入。 */
    accountHrefHints: ["/gp/css/homepage.html", "/gp/your-account"],
  },

  // ── 商品页 /dp/{ASIN}?th=1&psc=1 (报告 §4.2.1) ──────────────────────
  product: {
    outOfStock: "#outOfStock span.a-color-price.a-text-bold",
    quantitySelect: "#quantity",
    couponCheckbox: "input[id^=checkboxpctch]",
    couponClickMe: "span[id^=clickMepctch] input",
    addToCart: "#add-to-cart-button",
    warrantyPane: "#attach-warranty-pane",
    warrantyDecline: "#attachSiNoCoverage input",
    /** 报告未记载:商品页上的配送方文案。判不出来时返回"未知",交给结算页那道权威判定。 */
    shipperHints: ["#fulfillerInfoFeature_feature_div", "#merchant-info", "#tabular-buybox"],
  },

  // ── 购物车 /gp/cart/view.html (报告 §4.2.2) ─────────────────────────
  cart: {
    activeItems: '[data-name="Active Items"]',
    line: ".sc-list-item",
    qtyValue: '[data-a-selector="value"]',
    qtyNonEditable: ".sc-non-editable-quantity",
    proceed: "#sc-buy-box-ptc-button > span > input",
    /** 报告未记载:空车页的标志。用来把「车是空的」与「车还没渲染」分开 —— 
     *  分不开的话,一个没加载完的购物车会被当成已清空。 */
    emptyMarkers: ["#sc-active-cart", ".sc-your-amazon-cart-is-empty", "#sc-empty-cart"],
    /** 报告未记载 clearShoppingCart 的选择器,按常见形态推测。 */
    deleteButtons: [
      'input[value="Delete"]',
      '[data-action="delete"] input[type="submit"]',
      'input[data-action="delete"]',
      ".sc-action-delete input",
    ],
  },

  // ── 中间页与结算页 (报告 §4.2.2 第 7 步 / §4.2.4) ───────────────────
  checkout: {
    interstitialButtons: ["#checkout-byg-ptc-button a", "#sc-byc-ptc-button-lower a"],
    addressText: "#deliver-to-address-text",

    // ── 支付区(出处 v2.5.3 popup.js:2021-2050)────────────────────────
    //
    // **只读不写。** 厂商 v2.5.3 :2229-2310 会点开 payselect 页、替买家号勾选
    // 指定尾号的卡、再点 SetPaymentPlanSelectContinueEvent 确认 —— 依据是插件
    // 本地 localStorage 里一个操作员随手能改的输入框。我们不做:
    // 改一个买家号的支付配置是**人**的动作,不是拍单流程的动作;
    // 而且那等于把闸门交给被管的一方。不符就转人工(PAYMENT_METHOD_UNEXPECTED)。
    payment: {
      /** 一切支付读取的作用域(v2.5.3 :2029-2031)。
       *  **拿不到就当读不到,不要退到文档级** —— Amazon 结算页有同 id 的隐藏
       *  模板副本,文档级 querySelector 会先命中它(实测:隐藏副本尾号 0000
       *  排在真身 8738 前面时,裸取读出的是 0000)。 */
      panel: "#checkout-payment-option-panel",
      /** 面板内按序试,第一个出文本的赢(v2.5.3 :2034-2042)。
       *  第一条是报告 §4.2.4 检查 3 记的老形态,后两条是 2.5.3 新增。 */
      selectedTexts: [
        "#payment-option-text-default",
        '#selected-payment-method-_default [data-testid="_default"]',
        '[id^="selected-payment-method-"] [data-testid="_default"]',
      ],
    },

    /** 礼品卡 / 余额抵扣行(出处 v2.5.3 popup.js:2054、2062、2066-2068)。
     *
     * 这是这次从厂商那儿最值得抄的一条:判据是**隐藏表单标记**,与页面语言无关。
     * v2.5.1 靠 `includes("Paying with Amazon Points")` 这类文案判,换个站点语言就瞎。
     *
     * 为什么必须有它:结算页的 grand-total-cell 读到的是「这张卡要扣多少」,
     * 礼品卡垫过之后它比货款小,甚至是 0.00。没有这条选择器,
     * 限价护栏在任何有礼品卡余额的买家号上就是空的。 */
    giftCard: {
      marker: 'input[name="subtotalLineType"][value="SPECIAL_PAYMENTS_GIFT_CARD_BALANCE"]',
      /** 从 marker 往上 closest 到抵扣行(v2.5.3 :2062,按序试)。 */
      rowAncestors: [".order-summary-grid", "li"],
      /** 行内的金额格(v2.5.3 :2066-2068)。 */
      amounts: [
        '.order-summary-line-definition [data-shimmer-target="ordertotals-amount"]',
        ".order-summary-line-definition .aok-nowrap",
      ],
    },

    /** 订单小结的容器。**按 label 扫行必须限定在这里面。**
     *
     * 前两条出自 v2.5.3 :2530 / :2844(厂商是按 id 限定容器再取行的)。
     * 不限容器的后果实测过:我们自己的夹具里,隐藏的粘性底栏
     * (#checkout-sticky-summary,display:none)排在真表**之前**,
     * 全文档扫到的 Order total 是加第二件商品之前的过期值 $1,299.99,
     * 而真值是 $2,241.86。 */
    summaryTables: [
      "#subtotals-marketplace-table",
      "#subtotals-transactional-table",
      "#checkout-pyo-button-block",
    ],
    itemPanel: '[data-csa-c-slot-id="checkout-itemBlockPanel"]',
    lineItemContainer: ".lineitem-container",
    panelAsin: '[id="col-item-block-description"] > .aok-hidden',
    /** 结算页每个商品面板上的单价。
     *
     * **两个都要试。** Amazon 已经在部分结算页把这一格换成了
     * `apex-price-to-pay-value` —— 依据不是猜的:厂商 v2.5.1 在原选择器上
     * 补了同一个兜底,而他们是在真实 Amazon 上以万单规模跑的,
     * 这是我们能拿到的最强的线上 DOM 信号。
     *
     * 我们的夹具是照 v2.4.1 那份报告造的,只有旧类名 ——
     * 所以这条要是不补,68 条断言会一路绿灯,而线上一个单价都读不到。 */
    panelUnitPrice: [
      // 旧版:靠 a-text-bold 甩掉划线原价(List price 那个不带 bold)
      "span.lineitem-price-text.a-text-bold",
      // 新版:划线原价也挂同一个类名,判据在**祖先**上 —— .a-price[data-a-strike]。
      // 不排它的话会读到划线原价:那个数比实付高,写进「实付单价」是反的,
      // 而且它排在实付价前面,谁先取到谁赢。
      ".a-price:not([data-a-strike]) .apex-price-to-pay-value",
    ],
    panelShipper: "p.a-spacing-none span.a-size-small",
    panelDelivery: "h2",
    grandTotal: "#checkout-pyo-button-block .grand-total-cell",
    // 必须带 [type="submit"]。块里排在前面的是隐藏的 anti-csrftoken-a2z,
    // 后代选择器会选中它 —— click() 打在隐藏 input 上不报错也不跳转,
    // 于是等满 60 秒抛 ORDER_CONFIRM_TIMEOUT,任务落进「可能已下单」桶,
    // 运营被迫逐单登录买家号确认一个根本不存在的订单。
    submitOrder: '#submitOrderButtonId input[type="submit"]',
  },

  // ── 地址表单 (报告 §4.2.3) ─────────────────────────────────────────
  address: {
    section: '[aria-labelledby="delivery-addresses-section-header-id"]',
    changeAddress: '#checkout-deliveryAddressPanel [aria-label="Change delivery address"]',
    addNew: "#add-new-address-desktop-sasp-tango-link",
    editNth: (i: number) => `#edit-address-desktop-tango-sasp-${i}`,
    fullName: "#address-ui-widgets-enterAddressFullName",
    phone: "#address-ui-widgets-enterAddressPhoneNumber",
    line1: "#address-ui-widgets-enterAddressLine1",
    line2: "#address-ui-widgets-enterAddressLine2",
    city: "#address-ui-widgets-enterAddressCity",
    postal: "#address-ui-widgets-enterAddressPostalCode",
    state: "#address-ui-widgets-enterAddressStateOrRegion-dropdown-nativeId",
    save: "#pagelet-layout-section #checkout-primary-continue-button-id input",
    validationAlerts: [
      "#address-ui-widgets-enterAddressLine1-full-validation-alerts",
      "#address-ui-widgets-enterAddressLine2-full-validation-alerts",
      "#address-ui-widgets-enterAddressPhoneNumber-full-validation-alerts",
    ],
    suggestionPopup: "#address-ui-widgets-original-address-block_id-outer",
  },

  // ── 订单详情 /gp/your-account/order-details (报告 §4.3) ─────────────
  orderDetails: {
    root: "#orderDetails",
    alertHeading: ".a-alert-heading",
    shipmentTopRow: "#shipment-top-row",
    subtotalRow: "#od-subtotals .a-row.od-line-item-row",
    productLinks: ".a-fixed-left-grid-col.a-col-right .a-row .a-link-normal",
    paymentDetails: ".pmts-payments-instrument-details",
    /** 跟踪链接的**兜底** class 选择器。
     *
     * 正常路径是直接按 href 找(见 parse.findTrackingLink)——
     * 按钮外壳的 class 是 Amazon 改得最勤的东西,而 `/ship-track?`、
     * `/progress-tracker/package/` 这两个 URL 形状多年没动。
     * 拿 class 当入口闸门,class 一变就找不到,哪怕那个 <a> 就在页面上。
     *
     * 留着这几个只是为了兜住「href 判据没命中但按钮确实在」的情况,
     * 不再是主路径。厂商 v2.5.1 也做了同样的翻转。 */
    trackLinks: [
      ".a-button-stack.a-spacing-mini a",
      ".a-button.a-button-primary.track-package-button a",
      ".a-button.a-button-base.track-package-button a",
    ],
  },

  // ── 包裹跟踪页 (报告 §4.3 extractTrackingInfo / extractTrackingEvents) ──
  tracking: {
    /** Amazon 说「这会儿给不了轨迹」时页面上的原话。
     *
     * 认出它是为了**分开两件长得一样的事**:
     *   · Amazon 暂时给不了 —— 等下一轮就好,不是我们的问题
     *   · 我们没解析出来   —— 选择器坏了,要人去看
     * 都表现为「0 条轨迹」的话,选择器坏了会被当成「这批单都还没发货」,
     * 一直到有人发现整整一周没有任何轨迹为止。
     *
     * 顺带省掉 30 秒:不认它的话,三个就绪选择器一个都等不到,
     * 只能干等满超时。一批 20 单就是白等 10 分钟。 */
    unavailableText: "unable to get the tracking information",
    trackingId: ".pt-delivery-card-trackingId",
    trackingIdFallback: "#carrierRelatedInfo-container > div h4",
    cardWrapper: ".pt-delivery-card-wrapper",
    cardSmall: ".pt-delivery-card-wrapper .a-spacing-small",
    promiseNowrap: ".pt-promise-main-slot .nowrap",
    promise: ".pt-promise-main-slot",
    primaryStatus: "#primaryStatus",
    eventsContainer: "#tracking-events-container > div.a-container",
    eventRow: ".a-row.a-spacing-large.a-spacing-top-medium",
    eventTime: ".tracking-event-time",
    eventMessage: ".tracking-event-message",
    eventLocation: ".tracking-event-location",
    dateHeader: ".tracking-event-date-header .tracking-event-date",
  },

  // ── 订单历史 /gp/css/order-history (报告 §4.2.5) ────────────────────
  orders: {
    card: ".js-order-card",
    cardFallback: ".order-card__list",
    orderIdSpans: ".yohtmlc-order-id span",
    productLinks: ".yohtmlc-product-title a",
  },
} as const;

/** URL 形态。报告 §4.2.1 / §4.2.2 记的判定串。 */
export const URLS = {
  product: (origin: string, asin: string) => `${origin}/dp/${asin}?th=1&psc=1`,
  orderDetails: (origin: string, orderNo: string) =>
    `${origin}/gp/your-account/order-details?ie=UTF8&orderID=${encodeURIComponent(orderNo)}`,
  cart: (origin: string) => `${origin}/gp/cart/view.html`,
  orderHistory: (origin: string) => `${origin}/gp/css/order-history`,
  /** 加购成功后会落到这两个之一 */
  cartLanding: ["/cart/smart-wagon", "/gp/cart/view.html"],
  /** 结算中间页 */
  interstitial: ["checkout/byg/ref", "/cart/byc/ref"],
  /** 最终结算页 */
  finalCheckout: "/checkout/p/p-",
  /** 跟踪页链接的两种形态(报告 §4.3 第 1 步) */
  trackHrefHints: ["/ship-track?", "/progress-tracker/package/"],
  /** 下单成功。**只认 thankyou** —— 厂商把 /gp/cart/view.html 也判成功
   *  (深度分析 §4.2.4 高危),而被退回购物车恰恰是下单失败的典型表现。 */
  thankyou: "/gp/buy/thankyou",
  /** 登录页。执行中任何一步落到这里,都是「这个买家号被登出了」,
   *  不是「页面慢」—— 后者重试有用,前者重试多少次都不会好。 */
  signIn: "/ap/signin",
  /** 判登录态时开的那一页。
   *
   *  选购物车页的三个理由:① 有完整导航栏(判据全在那儿);
   *  ② 未登录也能打开、不会 302 到 signin —— 我们要的是**读导航栏**这条稳定判据,
   *  不是赌一次重定向;③ 这条流本来就要开购物车,不多引入一种新的页面形态,
   *  Amazon 改版时要盯的页面不会因此多一张。 */
  loginProbe: (origin: string) => `${origin}/gp/cart/view.html`,
} as const;

/** ASIN 形态。报告 §4.2.5 的正则。 */
export const ASIN_RE = /\b(B0\w{8}|\d{10}|\d{9}X)\b/;
export const ORDER_NO_RE = /\b\d{3}-\d{7}-\d{7}\b/;
