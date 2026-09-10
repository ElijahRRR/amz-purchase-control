/** 页面驱动:一单要在浏览器里做的每一步。
 *
 * 抽成接口是为了让「和服务端说话的时序」与「怎么点 Amazon 的 DOM」分开:
 * 前者用 SimulatedDriver 就能离线跑通并自检,后者(AmazonDriver)换个实现进来,
 * 时序不用重写。Amazon 改版时要改的也只有驱动这一侧。
 *
 * 驱动是**有会话的**:从加购到下单,购物车/结算页是同一个 iframe 上下文。
 * 所以约定调用顺序,并且调用方必须在 finally 里 dispose()。
 */

import type { ErrorCode } from "../core/codes.js";
import type { Shipping } from "../core/types.js";
import type { LoginState } from "./dom/parse.js";

/** 驱动认得出原因的失败。抛这个,上层直接拿 code 上报,不用猜。 */
export class DriverError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "DriverError";
  }
}

/** 执行中发现这个买家号已经被登出(页面落到 /ap/signin,或导航栏明说未签入)。
 *
 * **刻意没有 ErrorCode。** 错误码是封闭集,回答的是「这一单为什么失败」,
 * 而这件事不是这一单的问题 —— 单子本身没毛病,是这台机器的环境坏了。
 * 走到这里的处置是**退回队列**(mayHaveOrdered 为假时),任务的 error_code
 * 一个字都不会写;真给它编一个码,那个码会永远停在 0 次出现,还得硬塞进
 * RETRYABLE / TO_MANUAL / BUSINESS_BLOCKED 三组里的某一组 ——
 * 这个项目已经栽过一次「有码不属于任何一组」了(见 services/error_codes.py)。
 *
 * 登录态本身是**实例的一个字段**(procure.plugin_instances.login_state),
 * 有自己的封闭集、自己的界面标签、自己的那道认领闸,不需要再借错误码表达一遍。
 *
 * 例外:已经越过下单点(mayHaveOrdered)时仍然走既有的转人工路径,
 * 那条路上的码还是 ORDER_CONFIRM_TIMEOUT —— 那时要说的事情已经变了:
 * 「可能已经花了钱」比「被登出了」更要紧。
 */
export class LoginLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginLostError";
  }
}

export class NotImplemented extends Error {
  constructor(step: string) {
    super(`页面动作尚未实现:${step}`);
    this.name = "NotImplemented";
  }
}

export interface AddResult {
  /** 商品页上尽力而为的配送方判断。读不到就是 null(未知),
   *  交给结算页那道权威判定 —— 不要在这里瞎猜。 */
  shipperIsAmazon: boolean | null;
}

export interface CheckoutReading {
  /** **这张卡要扣的钱。** 礼品卡垫过之后它比货款小,全额抵扣时就是 "0.00"。
   *  护栏比的不是它 —— 见 goodsTotal。 */
  actualTotal: string;
  actualShipping?: string;
  actualTax?: string;
  /** 结算页上的礼品卡/余额抵扣。`applied` 与 `amount` 是**两个独立的事实**:
   *  认出抵扣行却读不出金额时 amount 是 undefined,不是 "0"。
   *  服务端收到「用了但不知道多少」会拒 —— 货款基数算不出来就不下单。
   *
   *  可选:模拟驱动不造礼品卡场景,没有这一位就是「这一单没有礼品卡抵扣」。 */
  giftCard?: { applied: boolean; amount?: string };
  /** **这一单的货款** = actualTotal + 礼品卡抵扣额。护栏比的就是它。
   *  插件算好一份报上去只是为了让事件流里看得见,**服务端会自己再算一遍并以自己的为准**
   *  —— 「如果价格超过限价就…」这类判断放在插件里,等于把闸门交给被管的一方。 */
  goodsTotal?: string;
  /** 每个商品面板各有一条交期文案,**全部**报给服务端,由它解析并取最晚的一条。
   *  挑哪条算数是护栏的一部分,不该让插件自己决定。 */
  deliveryTexts: string[];
  /** 结算页读到的配送方判断。null 表示读不到 —— 服务端会按 require_fba 处置。 */
  isFba: boolean | null;
  /** 结算页读到的单价。**没有数量** —— 结算页上的数量没读,不编。
   *  上报给服务端时由 runTask 拿任务里的数量来配对(购物车已经核对过一致)。 */
  unitPrices: Array<{ asin: string; unit_price: string }>;
  /** 结算页上有商品面板,却一个单价都没读到 —— 选择器坏了,不是「这单没单价」。
   *  不中断下单(限价护栏不依赖它),但要在事件流里留痕。 */
  unitPriceSelectorBroken?: boolean;
  paymentLast4?: string;
  /** 结算页上「已选支付方式」的槽位数(礼品卡余额也占一个)。
   *  paymentLast4 只答得出第一个槽位里那张卡 —— 拆分支付时这道闸只管第一张。
   *  undefined = 没数着(读不到支付面板,或模拟驱动不造这个场景)。 */
  paymentSlots?: number;
}

// ── 替买家号切换支付卡(所有者定稿①,2026-09-09)────────────────────

/** 切卡过程说给外面听的两个回调。
 *
 *  为什么是回调而不是让驱动自己发事件:与 PlaceOrderHooks 同一条理由 ——
 *  驱动只管「怎么点 Amazon 的 DOM」,和服务端说话是 runTask 的事。
 *  跨过这条线的话 SimulatedDriver 也得会发事件,离线自检就跑不动了。 */
export interface PaymentCardHooks {
  /** 已经确认「当前不是期望的那张卡」,**马上要动手切**。
   *  `from` 是切之前结算页上选中的尾号,读不出来是 null —— 读不出来照样要切,
   *  但这一位要如实报 null:编一个"未知"字符串会让事件流里那条
   *  「4417 → 9021」和「读不出来 → 9021」长成同一个样子。 */
  onSwitchStart?(info: { from: string | null; to: string }): void | Promise<void>;
  /** 切完了,而且**重新读结算页确认过**尾号真的是期望的那张。
   *
   *  `matched` 是选卡时**比中的那一段文字**(比如 "Visa ending in 4417")。
   *  它要进事件流:payselect 那一整套判据是全仓可信度最低的一档,
   *  Amazon 改一版之后「比中了 4417」和「在有效期/账单邮编里比中了 4417」
   *  会给出同一个结果,而排查时唯一能分开它们的就是这一段原文。
   *  模拟驱动没有页面,给 null —— 「没有这个能力」与「比中的是空字符串」不是一回事。 */
  onSwitched?(info: { from: string | null; to: string; matched: string | null }):
    void | Promise<void>;
}

export interface PaymentCardResult {
  /** 这一刻结算页上选中的卡尾号,读不出来是 null。 */
  last4: string | null;
  /** 有没有真的动过手。false = 本来就是那张,或者期望为空一步没做。
   *  调用方拿它决定要不要**重新读一遍结算页** —— 切卡会让结算页整个重渲染。 */
  switched: boolean;
}

/** 点下单之后那一段要用的东西:一个来自服务端的上界,两个说给外面听的回调。
 *
 *  为什么回调而不是让驱动自己去发事件:驱动只管「怎么点 Amazon 的 DOM」,
 *  和服务端说话是 runTask 的事(见本文件头)。跨过这条线的话,SimulatedDriver
 *  也得会发事件,离线自检就跑不动了。 */
export interface PlaceOrderHooks {
  /** 服务端会在这个时刻把这条判成认领超时(epoch 毫秒)。等待的硬顶按它反推 ——
   *  插件自己拍一个上界的话,task_sweep 会在我们还在等的时候把单收走,
   *  之后连「单下成了」都报不上去。null = 服务端没给,退回插件自己的硬顶。
   *
   *  **是一个绝对时刻,不是一段时长。** 原先传的是 claim_timeout_min(分钟),
   *  于是这本账从「点了下单那一刻」开始算 —— 而清车/加购/填地址那几步花掉的
   *  五六分钟同样记在服务端的 claimed_at 上。两边的起点不一样,插件算出来的
   *  「还剩多久」就一直是偏大的。起点由 run.ts 在**认领之后**取。 */
  claimDeadlineMs?: number | null;
  /** 页面落进了不透明源(发卡行 3DS 验证页),窗口已经露出来等人动手。
   *  `deadlineMs` 是这一段的到期时刻(epoch 毫秒),面板拿它跑倒计时。 */
  onManualVerification?(info: { deadlineMs: number }): void | Promise<void>;
  /** 从验证页回到了读得到的页面(验证做完了,或者被拒了)。 */
  onVerificationDone?(): void | Promise<void>;
}

export interface OrderCard {
  amazonOrderNo: string;
  /** 订单卡上解析出的 ASIN。服务端拿它跟本单断言,不符就拒绝回填。 */
  observedAsins: string[];
}

export interface PageDriver {
  readonly name: string;
  /** 这个驱动能不能真的下单。false 时上层拒绝认领,免得白白烧掉队列里的单。 */
  readonly ready: boolean;

  /** 开一张轻量页面读导航栏,回答「这个浏览器还登着 Amazon 吗」。
   *  **认领之前**问,免得领了单再走到 /ap/signin 白跑一趟。
   *  读不出来就是 `unknown` —— 不许兜底成 `ok`。 */
  readLoginState(): Promise<LoginState>;

  clearCart(): Promise<void>;
  /** 打开商品页 → 校验库存 → 选数量 → 加购。失败抛 DriverError。 */
  addProduct(asin: string, quantity: number): Promise<AddResult>;
  /** 打开购物车回读:车里必须恰好是本单的东西。 */
  verifyCart(expected: Array<{ asin: string; quantity: number }>): Promise<boolean>;
  /** 购物车 → 结算页(含 Amazon 可能插进来的中间页)。 */
  proceedToCheckout(): Promise<void>;
  fillAddress(shipping: Shipping): Promise<void>;
  readCheckout(): Promise<CheckoutReading>;
  /** 按买家号配的期望尾号把支付卡切过去(所有者定稿①)。
   *
   *  **`expected` 为空(null/undefined/空串)时一步都不做** —— 不点入口、
   *  不开支付选择页、**不读任何东西**,直接回 `{ last4: null, switched: false }`。
   *  这一位来自服务端 `guards.expected_card_last4`,留空的语义是
   *  「这个买家号不校验也不切」,与 require_fba 同形态的可关闸。
   *  「不读任何东西」不是修辞:真驱动这一档连 `doc()` 都不碰 —— 结算 iframe
   *  已跨域/已销毁时 `doc()` 会抛,而一个根本没配期望卡的买家号不该因为
   *  一个按定义什么都不做的步骤失败。`switched === false` 时 `last4` 没有人读。
   *
   *  **fail-closed**:任何一步判据不满足就不点确认,抛
   *  `DriverError("PAYMENT_METHOD_UNEXPECTED")`,detail 里写清停在哪一步、
   *  读到了什么。五种停法必须分得开(入口没找到 / 选卡页没到 /
   *  没有唯一命中的那张卡 / 确认按钮不可用 / 切完读到的仍不是期望)——
   *  它们的处置完全不同:前两种是选择器改版要改代码,第三种是这个买家号
   *  钱包里根本没那张卡(去配置或去买家号里加卡),后两种要人去看一眼页面。
   *
   *  **但「被登出」要先于这五种说出来。** 五步里每一处「等满了预算」的失败
   *  在会话过期时长得一模一样,而 PAYMENT_METHOD_UNEXPECTED 是不可自动重试的
   *  业务码、也不会让实例报 signed_out。所以真驱动在每个超时分支之前先探一次
   *  登录态,是的话抛 `LoginLostError` —— 这一单退回队列、这台机器停止派单。
   *
   *  **切换是插件的动作,校验仍在服务端。** 这里返回成功不代表这一单能过 ——
   *  服务端 guard-check 会拿插件重新读的那一遍尾号自己判。 */
  ensurePaymentCard(expected: string | null | undefined,
                    hooks?: PaymentCardHooks): Promise<PaymentCardResult>;
  /** 真花钱的一步。调用之前上层会先把「可能已下单」置位,并上报一条 step 事件。
   *
   *  实现必须是**有界**的:三段分开计时(等确认页 / 等人做发卡行验证 / 验证之后),
   *  再压一道由 hooks.claimDeadlineMs 反推出来的硬顶。绝不允许「一直等下去」——
   *  在我们的架构里那不是耐心,是一个等不到任何人的死循环:iframe 在屏幕外,
   *  服务端 15 分钟后把这条任务判成 CLAIM_TIMEOUT,而这个标签页的单飞闸永不复位。 */
  placeOrder(hooks?: PlaceOrderHooks): Promise<void>;
  readOrderCard(): Promise<OrderCard>;
  /** 关掉所有 iframe。无论成败都会被调用,必须幂等。 */
  dispose(): Promise<void>;
}

// ── 可选能力:回读购物车的现场 ───────────────────────────────────────

/** 上一次 `verifyCart` 实际从购物车页读到的行。
 *
 * 为什么要有它:`verifyCart` 返回 boolean,于是 CART_MISMATCH 的 detail 只能写
 * 「购物车回读与本单不符」—— 运营看到这句话唯一能做的事是自己登录买家号去开购物车。
 * 而「车里少了一件(被判不可售自动移除)」「车里多了一件(上一单没清干净)」
 * 「车里数量不对」是三种完全不同的处置,它们今天渲染出同一句话。
 *
 * **做成可选而不是塞进 PageDriver**:模拟驱动没有购物车 DOM,不该被迫编一个;
 * `run.ts` 拿不到就少写一段现场,判定本身不受影响。 */
export interface CartReadReporter {
  lastCartRead(): Array<{ asin: string; quantity: number | null }>;
}

/** 输入:任意驱动 → 输出:它上一次读到的购物车行,不具备这个能力就是 null。
 *  `null`(不具备)与 `[]`(读到了、就是空车)是两件事,别合并。 */
export function cartReadOf(d: unknown): Array<{ asin: string; quantity: number | null }> | null {
  const fn = (d as Partial<CartReadReporter> | null)?.lastCartRead;
  return typeof fn === "function" ? fn.call(d) : null;
}
