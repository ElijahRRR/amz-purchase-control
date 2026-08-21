/** 页面驱动:一单要在浏览器里做的每一步。
 *
 * 抽成接口是为了让「和服务端说话的时序」与「怎么点 Amazon 的 DOM」分开:
 * 前者现在就能跑通并自检,后者(P3)换个实现进来即可,时序不用重写。
 */

import type { Shipping } from "../core/types.js";

export interface ProductPage {
  inStock: boolean;
  isFba: boolean;
  /** 商品页标价,只用于展示与留痕。护栏比的是结算页实付,不是这个数。 */
  listPrice?: string;
}

export interface CheckoutReading {
  actualTotal: string;
  actualShipping?: string;
  actualTax?: string;
  /** Amazon 的交期原文,例如 "Wednesday, August 27"。
   *  原样带回服务端解析并留痕 —— 解析失败时这是唯一线索。 */
  deliveryRaw?: string;
  isFba: boolean;
  lineItems: Array<{ asin: string; unit_price: string; quantity: number }>;
  paymentLast4?: string;
}

export interface OrderCard {
  amazonOrderNo: string;
  /** 订单卡上解析出的 ASIN。服务端拿它跟本单断言,不符就拒绝回填。 */
  observedAsins: string[];
}

export class NotImplemented extends Error {
  constructor(step: string) {
    super(`页面动作尚未实现:${step}`);
    this.name = "NotImplemented";
  }
}

export interface PageDriver {
  readonly name: string;
  /** 这个驱动能不能真的下单。false 时上层拒绝认领,免得白白烧掉队列里的单。 */
  readonly ready: boolean;

  clearCart(): Promise<void>;
  openProduct(asin: string): Promise<ProductPage>;
  addToCart(asin: string, quantity: number): Promise<void>;
  /** 加购后回读购物车,确认车里就是本单的东西。 */
  verifyCart(expected: Array<{ asin: string; quantity: number }>): Promise<boolean>;
  fillAddress(shipping: Shipping): Promise<void>;
  readCheckout(): Promise<CheckoutReading>;
  /** 真花钱的一步。调用之前上层会先把「可能已下单」置位。 */
  placeOrder(): Promise<void>;
  readOrderCard(): Promise<OrderCard>;
}
