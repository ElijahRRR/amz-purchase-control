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

/** 驱动认得出原因的失败。抛这个,上层直接拿 code 上报,不用猜。 */
export class DriverError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "DriverError";
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
  actualTotal: string;
  actualShipping?: string;
  actualTax?: string;
  /** 每个商品面板各有一条交期文案,**全部**报给服务端,由它解析并取最晚的一条。
   *  挑哪条算数是护栏的一部分,不该让插件自己决定。 */
  deliveryTexts: string[];
  /** 结算页读到的配送方判断。null 表示读不到 —— 服务端会按 require_fba 处置。 */
  isFba: boolean | null;
  /** 结算页读到的单价。**没有数量** —— 结算页上的数量没读,不编。
   *  上报给服务端时由 runTask 拿任务里的数量来配对(购物车已经核对过一致)。 */
  unitPrices: Array<{ asin: string; unit_price: string }>;
  paymentLast4?: string;
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

  clearCart(): Promise<void>;
  /** 打开商品页 → 校验库存 → 选数量 → 加购。失败抛 DriverError。 */
  addProduct(asin: string, quantity: number): Promise<AddResult>;
  /** 打开购物车回读:车里必须恰好是本单的东西。 */
  verifyCart(expected: Array<{ asin: string; quantity: number }>): Promise<boolean>;
  /** 购物车 → 结算页(含 Amazon 可能插进来的中间页)。 */
  proceedToCheckout(): Promise<void>;
  fillAddress(shipping: Shipping): Promise<void>;
  readCheckout(): Promise<CheckoutReading>;
  /** 真花钱的一步。调用之前上层会先把「可能已下单」置位。 */
  placeOrder(): Promise<void>;
  readOrderCard(): Promise<OrderCard>;
  /** 关掉所有 iframe。无论成败都会被调用,必须幂等。 */
  dispose(): Promise<void>;
}
