/** 所有 Amazon 选择器集中在这里。
 *
 * §10.5 说这套东西对 Amazon 的页面结构是硬依赖:Amazon 改版就得改这里。
 * 集中放的意义就在于改版时只改一个文件。
 *
 * ── 这个文件的三条规矩 ────────────────────────────────────────────
 *
 * **一、每条都要标出处,而且要标到「哪一版」。** 出处有两种:
 *   · `报告 §x.x` —— `AMZ-Purchase-Assistant/docs/插件功能深度分析.md`,
 *     对厂商插件 **v2.4.1** 的源码级分析,记着他们几万单实际在用的选择器;
 *   · `厂商 v2.5.3:行号` —— 厂商 2.5.3 版 popup.js(`SP/v253.pretty.js`)。
 *     这一档**可信度最高**:那是他们拿真实 Amazon 页面校准出来的,
 *     而且能看出哪几条是被他们**换掉**的(换掉说明线上已经变了)。
 *   · `报告未记载` —— 我们自己按常见形态补的,坏了先怀疑它们。
 *   · `厂商按截图推的` —— 厂商 2.5.3 写了、但他们**自己承认没有 DOM 样本**
 *     (task_plan.md:25、findings.md:10)的那些。**可信度比上一档还低一档**:
 *     上一档至少是我们按见过的页面形态补的,这一档连页面都没人见过。
 *     眼下只有 checkout.payselect 那一整节属于这一档,它标着 ⚠️⚠️。
 *     「同一个出处」不等于「同样可信」—— 一条从没在真页面上验过的判据,
 *     混在几万单跑出来的判据里不标出来,下次改版排查时就没人知道该先怀疑谁。
 *
 * **二、一样东西有多种形态时写成有序数组,顺序是「结构判据在前、文案判据垫底」。**
 * 文案判据(`[aria-label="Change delivery address"]`、`input[value="Delete"]`)
 * 换个站点语言、Amazon 改一版文案就失灵,而且**失灵时不报错**:
 * querySelector 返回 null,点击静默落空,然后等满一个超时窗口。
 * 厂商 2.5.3 就是把地址那条 aria-label 整条删掉换成三条结构判据的。
 *
 * **三、数组要配 parse.pickFirstRendered 用,不要裸 querySelector。**
 * Amazon 同一个 id / class 在页面上常有隐藏的模板副本,而且经常**排在真身前面**;
 * 数组只解决「形态变了」,解决不了「选中的是隐藏副本」。两件事要一起做。
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
    /** 加购按钮的两种形态。第二条出自厂商 v2.5.3:2180(2.5.3 新增)。
     *
     *  配 parse.findAddToCartButton 用 —— 那里还要再排掉 disabled /
     *  aria-disabled 的那一个:`click()` 打在 disabled 按钮上**返回 true**
     *  (元素在),浏览器却根本不派发 click 事件,于是这一单白等满 T.addToCart
     *  才报 ADD_TO_CART_FAILED,而真正的原因(按钮还没激活)在事件流里看不出来。 */
    addToCart: ['#add-to-cart-button', 'input[name="submit.add-to-cart"]'],
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
    /** 报告未记载:**购物车页渲染出来了**的标志。只回答「这一页画完了没有」,
     *  不回答「车里有没有东西」—— 两个问题混在一起正是下面那条要防的事。 */
    cartRendered: ["#sc-active-cart", '[data-name="Active Items"]', "#sc-buy-box-ptc-button"],
    /** 报告未记载:**空车页**的标志。用来把「车是空的」与「车还没渲染」分开 ——
     *  分不开的话,一个没加载完的购物车会被当成已清空,上一单的残留被带进这一单。
     *
     *  `#sc-active-cart` 曾经在这个数组里,那是错的:它是购物车页的**外层容器**,
     *  空车、满车、还在加载都有它。一个「空车标志」在车满的时候也成立,
     *  等于这道判据不存在 —— 而它看起来在。已挪到上面的 cartRendered。 */
    emptyMarkers: [".sc-your-amazon-cart-is-empty", "#sc-empty-cart"],
    /** 删除控件。**前三条出自厂商 v2.5.3:687-703,且 2.4.1 起就在产线上用**
     *  (SP/wf/verify_origin.mjs 逐版数过),不是这次新加的 ——
     *  也就是说图标形态才是他们几万单里真正遇到的那种。
     *
     *  后三条是我们原先「按常见形态推测」的文字按钮形态,降为垫底:
     *  `input[value="Delete"]` 是英文文案判据,换个站点语言就失灵。
     *
     *  实测(SP/wf/cart_delete_probe.mjs):按厂商形态造的图标购物车上,
     *  我们原来那四条**全部落空** → clearCart 第一轮就抛
     *  PLUGIN_INTERNAL「找不到删除控件」,车里的东西原样留着;
     *  而按「失败必清车」,清车失败会连带废掉后面每一单。
     *
     *  注意第三条带 `-active`:我们原先写的 `.sc-action-delete input` 选不中它。 */
    deleteButtons: [
      ".a-declarative > .a-icon.a-icon-small-trash",
      ".a-declarative > .a-icon.a-icon-small-remove",
      ".sc-action-delete-active input",
      '[data-action="delete"] input[type="submit"]',
      'input[data-action="delete"]',
      'input[value="Delete"]',
    ],
  },

  // ── 中间页与结算页 (报告 §4.2.2 第 7 步 / §4.2.4) ───────────────────
  checkout: {
    interstitialButtons: ["#checkout-byg-ptc-button a", "#sc-byc-ptc-button-lower a"],
    addressText: "#deliver-to-address-text",

    // ── 支付区(出处 v2.5.3 popup.js:2021-2050)────────────────────────
    //
    // **先切后验,验在服务端。**(所有者定稿①,2026-09-09)
    //
    // 此前这里写的是「只读不写」—— 那句话现在不成立了,所有者定了要替买家号切卡。
    // 但决定改的只是「切不切」,没有改「谁说了算」:
    //   · 切:插件的动作。读结算页之后、报护栏之前,按 guards.expected_card_last4
    //         把卡切过去(flow/amazon.ensurePaymentCard)。
    //   · 验:仍然只在服务端。price_guard 那道 PAYMENT_METHOD_UNEXPECTED 一个字
    //         没改 —— 插件说"我切成了"不算数,服务端拿插件重新读的那一遍尾号
    //         自己判。把校验也搬进插件就是把闸门交给被管的一方。
    // 与厂商的另一处不同:期望卡尾号来自**服务端下发的 buyer_envs 那一列**,
    // 不是插件本地 localStorage 里一个操作员随手能改的输入框(v2.5.3 :266-270)。
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
      /** 「已选支付方式」的槽位(v2.5.3 :2041 用的就是这个前缀)。
       *
       *  selectedTexts 只答得出**第一个**槽位里那张卡。Amazon 允许把一单拆到
       *  多个已选支付方式上,那时第一张对得上、第二张刷了多少,这道闸完全不知道。
       *  数出来交服务端裁决 —— 礼品卡余额自己也占一个槽位(见夹具
       *  checkout-giftcard.html 的两个槽位),扣不扣得由知道 gift_card.applied
       *  的那一方来做,插件这里只报个数。 */
      selectedSlots: '[id^="selected-payment-method-"]',
      /** 「更改支付方式」入口,三候选按序试(v2.5.3 :2248-2260)。
       *
       *  ⚠️ **厂商按截图推的,可信度低** —— 见下面 payselect 那一节的说明,
       *  这三条与那一整节同属一档。前两条是结构判据(href 里的参数),
       *  第三条是 Amazon 那套「页面跳转」声明式壳子里的任意 a,最松,垫底。
       *
       *  **必须限定在 payment.panel 里面**(厂商也是 paymentPanel.querySelector):
       *  同样的 href 在页脚「管理支付方式」、账户浮层里也有一份,
       *  文档级取到那一个会把整个 iframe 导到钱包页 —— 从那里再也回不到结算页,
       *  表现是等满预算之后一句「切完读到的仍不是期望」,而真实原因是点错了链接。 */
      changeEntry: [
        'a[href*="/pay?"][href*="redirectReason=ChangePaymentMethod"]',
        'a[href*="toPage=payselect"]',
        '[data-action="page-transit-no-update-action"] a',
      ],
    },

    /** ── 支付选择页 payselect(v2.5.3 popup.js:2081-2144 / :2283)──────
     *
     *  ⚠️⚠️ **这一整节的可信度是全文件最低的一档,比「报告未记载」还低一档。**
     *
     *  为什么:厂商自己在 task_plan.md:25 与 findings.md:10 里承认,支付选择页
     *  **只有截图、没有 DOM 样本** —— 这 17 条判据是照着截图和通用的 pmts/ppw
     *  命名猜出来的。别的条目至少是他们在真页面上校准过、几万单在跑的;
     *  这一节没有任何东西担保。我们的夹具 payselect.html 也是照这些判据造的,
     *  所以「夹具上跑通」这件事在这一节**不构成证据**,只说明我们按自己写的
     *  语义在读。第一次开 live 档跑到这一步,请在真页面上先核一遍。
     *
     *  正因为如此,ensurePaymentCard 的每一步都是 fail-closed:判据不满足就
     *  **不点确认**,抛 PAYMENT_METHOD_UNEXPECTED 并在 detail 里写清停在哪一步、
     *  读到了什么。一道"看起来能切卡、实际点错了地方"的流程,比不切更危险 ——
     *  不切最坏是这一单转人工,点错了是拿别人的卡付了钱。 */
    payselect: {
      /** URL 里认得出「这是支付选择页」的那一段(v2.5.3 :2256 的 toPage 参数)。 */
      urlHint: "payselect",
      /** 卡片行的单选钮(v2.5.3 :2082-2084)。第二条是他们自己留的宽松兜底。 */
      radio: 'input[type="radio"][name="ppw-instrumentRowSelection"],'
           + ' input[type="radio"][name*="instrumentRowSelection"]',
      /** 一张卡的容器,四候选(v2.5.3 :2088-2090)。
       *  只有「容器内恰好一个 radio」才认 —— 否则说明这个候选圈大了,
       *  往上爬去找更小的块(见 parse.findCardRadioByLast4)。 */
      blocks: [
        ".pmts-instrument-box",
        "[data-pmts-instrument-id]",
        '[data-pmts-component-id*="instrument"]',
        '[class*="instrument-row"]',
      ],
      /** 块内真正写着卡号的那一格,用来做尾号的二次比对(v2.5.3 :2121-2124)。
       *  不拿整块文本比是因为块里还有有效期(Expires 08/2029)、账单地址邮编、
       *  积分数 —— 拿整块比,一个 2029 就能被当成尾号。 */
      details: [
        '[data-testid="method-details-number"]',
        '[data-testid*="card-number"]',
        ".pmts-instrument-number-tail",
        '[class*="instrument-number"]',
      ],
      /** 确认按钮(v2.5.3 :2278-2280)。**必须同时不 disabled** ——
       *  click() 打在 disabled 按钮上返回 true(元素在),浏览器却不派发事件,
       *  于是「点过了」和「没点动」长成同一个样子,然后等满一个预算。
       *  与商品页加购按钮那条是同一个坑(见 product.addToCart)。 */
      confirm: '[name="ppw-widgetEvent:SetPaymentPlanSelectContinueEvent"]',
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

    /** 订单小结的容器。**按 label 扫行优先限定在这里面,一个都不在就退回文档级。**
     *
     * 两条都出自 v2.5.3 :2530 / :2844 —— 厂商就是按这两个 id 限定容器再取
     * `li` 小结行的。不限容器的后果实测过:我们自己的夹具里,隐藏的粘性底栏
     * (#checkout-sticky-summary,display:none)排在真表**之前**,
     * 全文档扫到的 Order total 是加第二件商品之前的过期值 $1,299.99,
     * 而真值是 $2,241.86。
     *
     * **这里只放真的装着小结行的容器。** 曾经多列过一条
     * `#checkout-pyo-button-block`,它是**下单按钮那个盒子**,厂商拿它只取
     * `.grand-total-cell`(v2.5.3 :2473),从不用来扫小结行。列进来的后果是
     * 把「限容器、否则退回文档级」变成了「收窄到一个根本没有小结行的盒子」:
     * Amazon 哪天把两张 subtotals 表的 id 改掉(正是收窄想防的那件事),
     * 前两条落空、第三条命中 → root 变成按钮盒 → 运费/税费对**每一单**
     * 都读成 undefined,落库是 NULL,导出两列全空,而且不报任何错。
     * 收窄之前反倒读得到 —— 一条「防改版」的措施本身成了改版时的单点。 */
    summaryTables: [
      "#subtotals-marketplace-table",
      "#subtotals-transactional-table",
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
    /** 结算页上的「更改收货地址」入口,四条按可信度排。
     *
     *  前三条出自**厂商 v2.5.3:3159-3163**,是这一版新增的;第四条
     *  `[aria-label="Change delivery address"]` 是厂商 2.4.1/2.5.1 用的那条,
     *  **他们在 2.5.3 里把它整条删掉了**(findings.md:46「不再依赖英/日文 aria-label」)。
     *
     *  我们原先只有被删掉的那一条。它失灵的样子是最坏的一种:
     *  querySelector 返回 null → click 静默什么都不做 → 紧接着等 30 秒
     *  → 每一单都报 ADDRESS_FORM_TIMEOUT(可重试码,而重试多少次都一样)。
     *  运营看到「地址表单加载超时」,真实原因是「入口选择器坏了,要改代码」。
     *
     *  这里保留它当垫底而不是跟着删:厂商的新形态是他们在自己那批买家号上
     *  校准出来的,不能确定所有账号都已经换过去。但它排在最后 ——
     *  前三条命中就用不到它。
     *
     *  配 parse.findAddressChangeEntry 用(逐条走 isRendered)。 */
    changeAddress: [
      "#checkout-deliveryAddressPanel #change-delivery-link",
      '#checkout-deliveryAddressPanel a[data-toPage="shipaddressselect"]',
      '#checkout-deliveryAddressPanel [data-action="page-transit-no-update-action"] a[href*="/address?"]',
      '#checkout-deliveryAddressPanel [aria-label="Change delivery address"]',
    ],
    /** 「新增地址」。**我们一律新建,从不复用地址簿里已有的条目。**
     *
     *  这是个明写下来的决定,不是没做:复用要先比对几十条地址文本才能确认
     *  选中的是哪一条(厂商真实买家号上的样本是 55 条,findings.md:45),
     *  比对写松一点就寄错人 —— 而寄错人和实付超限价是同一量级的后果。
     *  新建的代价是地址簿越攒越长、/address 页越来越慢,已知并接受。
     *
     *  这里原先还有一条 `editNth: (i) => '#edit-address-desktop-tango-sasp-' + i`
     *  (厂商 v2.5.3:3222 真在用),而我们全仓库**没有任何调用点**。
     *  已删:一条躺在选择器表里、看起来在用其实没人取的条目,
     *  会让下一个读代码的人以为「复用已有地址」这条路径是实现过的。 */
    addNew: "#add-new-address-desktop-sasp-tango-link",
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
    /** 订单状态行的第二形态。第一条出自**厂商 v2.5.3:4067(这一版新增)** ——
     *  他们专门补这一档,说明线上已经出现了「状态不在 .a-alert-heading 里」的页面。
     *
     *  第二条是同一条判据去掉 `.a-color-base`:那是个纯配色工具类,
     *  Amazon 换一版主题就可能不一样,而 `od-status-message` 才是语义所在。
     *
     *  不裸取 `#shipment-top-row` 的原因:那一整块里混着运单号、商品名、
     *  按钮文案,拿它去判 /cancell?ed/ 会被稀释(也会被别的词误伤)。 */
    statusMessage: [
      "#shipment-top-row .a-color-base.od-status-message",
      "#shipment-top-row .od-status-message",
    ],
    subtotalRow: "#od-subtotals .a-row.od-line-item-row",
    productLinks: ".a-fixed-left-grid-col.a-col-right .a-row .a-link-normal",
    /** 订单详情页上的卡尾号。第二条出自**厂商 v2.5.3:4399**,verify_origin 确认
     *  2.4.1 起三版都有 —— 是我们照抄报告时漏掉的一条老形态,不是新形态。
     *  落空的表现是 payment_last4 一列静静全空,没有任何地方报「选择器坏了」。 */
    paymentDetails: [
      ".pmts-payments-instrument-details",
      '[data-component="viewPaymentPlanSummaryWidget"] > div [data-testid="method-details-number"]',
    ],
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
    /** 运单号的三种形态。中间那条出自**厂商 v2.5.3:4851**(extractTrackingEvents 里),
     *  verify_origin 确认 2.4.1 起三版都有 —— 同样是我们照抄报告时漏掉的老形态。
     *
     *  漏掉它的表现:跟踪页只渲染了事件区(轨迹已经在更新、顶部的 delivery card
     *  还没画出来或被折叠)时,前后两条都落空 → readTrackingNumber 返回 null
     *  → 这一单在库里长得跟「还没发货」一模一样。 */
    trackingIds: [
      ".pt-delivery-card-trackingId",
      ".tracking-event-trackingId-text h4",
      "#carrierRelatedInfo-container > div h4",
    ],
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
  /** 地址选择页 `/checkout/p/p-…/address`。
   *
   *  点完「更改地址」之后**先确认页面真的换过去了**,再去等地址区 ——
   *  否则结算页上那个折叠着(display:none)的地址簿会在页面还没跳走的那一刻
   *  就满足「地址区加载」,于是我们在错误的页面上点一个不可见的「新建地址」。
   *  这条判据只在结算 iframe 里用,不会撞上账户里的 /gp/css/account/address。 */
  addressSelect: "/address",
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
