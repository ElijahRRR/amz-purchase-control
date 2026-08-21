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
    paymentText: "#payment-option-text-default",
    itemPanel: '[data-csa-c-slot-id="checkout-itemBlockPanel"]',
    lineItemContainer: ".lineitem-container",
    panelAsin: '[id="col-item-block-description"] > .aok-hidden',
    panelUnitPrice: "span.lineitem-price-text.a-text-bold",
    panelShipper: "p.a-spacing-none span.a-size-small",
    panelDelivery: "h2",
    grandTotal: "#checkout-pyo-button-block .grand-total-cell",
    submitOrder: "#submitOrderButtonId input",
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
    trackLinks: [
      ".a-button-stack.a-spacing-mini a",
      ".a-button.a-button-primary.track-package-button a",
      ".a-button.a-button-base.track-package-button a",
    ],
  },

  // ── 包裹跟踪页 (报告 §4.3 extractTrackingInfo / extractTrackingEvents) ──
  tracking: {
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
} as const;

/** ASIN 形态。报告 §4.2.5 的正则。 */
export const ASIN_RE = /\b(B0\w{8}|\d{10}|\d{9}X)\b/;
export const ORDER_NO_RE = /\b\d{3}-\d{7}-\d{7}\b/;
