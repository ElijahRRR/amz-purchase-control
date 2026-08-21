/** 模拟驱动:不碰 Amazon,只把页面动作换成返回固定值。
 *
 * 用途是自检「和服务端说话的时序」——认领、事件流、护栏裁决、回填断言、失败清车
 * 这一整套能不能真的跑通。场景与 tools/mock_plugin.py 一致,便于两边对照。
 */

import { DriverError, type AddResult, type CheckoutReading, type OrderCard, type PageDriver } from "./driver.js";
import type { Shipping } from "../core/types.js";

export type Scenario =
  | "happy" | "over_cap" | "oos" | "not_fba" | "wrong_asin"
  | "confirm_timeout" | "late_delivery" | "cart_mismatch";

export class SimulatedDriver implements PageDriver {
  readonly name = "simulated";
  readonly ready = true;

  readonly calls: string[] = [];
  private added: Array<{ asin: string; quantity: number }> = [];

  constructor(private readonly scenario: Scenario = "happy") {}

  private mark(step: string) { this.calls.push(step); }

  async dispose(): Promise<void> { this.mark("dispose"); }

  async clearCart(): Promise<void> {
    this.mark("clearCart");
    this.added = [];
  }

  async addProduct(asin: string, quantity: number): Promise<AddResult> {
    this.mark(`addProduct:${asin}x${quantity}`);
    if (this.scenario === "oos") throw new DriverError("OUT_OF_STOCK", `${asin} 无货(模拟)`);
    this.added.push({ asin, quantity });
    // 商品页判不出 FBA 是常态,返回 null 让结算页那道权威判定说了算。
    return { shipperIsAmazon: this.scenario === "not_fba" ? false : null };
  }

  async verifyCart(expected: Array<{ asin: string; quantity: number }>): Promise<boolean> {
    this.mark("verifyCart");
    if (this.scenario === "cart_mismatch") return false;
    return expected.length === this.added.length;
  }

  async proceedToCheckout(): Promise<void> { this.mark("proceedToCheckout"); }

  async fillAddress(_shipping: Shipping): Promise<void> { this.mark("fillAddress"); }

  async readCheckout(): Promise<CheckoutReading> {
    this.mark("readCheckout");
    const total = this.scenario === "over_cap" ? "99.00" : "10.79";
    // 每个商品面板一条交期,故意给两条不同的 —— 服务端要取最晚那条。
    const deliveryTexts = this.scenario === "late_delivery"
      ? ["Monday, August 24", "Friday, September 18"]
      : ["Monday, August 24", "Wednesday, August 27"];
    return {
      actualTotal: total,
      actualShipping: "0.00",
      actualTax: "0.80",
      deliveryTexts,
      isFba: this.scenario === "not_fba" ? false : true,
      paymentLast4: "4417",
      unitPrices: this.added.map((p) => ({ asin: p.asin, unit_price: "9.99" })),
    };
  }

  async placeOrder(): Promise<void> {
    this.mark("placeOrder");
    if (this.scenario === "confirm_timeout") {
      // 已经点下去了,但没见到确认页 —— 最危险的那一格:可能已经下成了。
      throw new DriverError("ORDER_CONFIRM_TIMEOUT", "点了下单但没等到确认页(模拟)");
    }
  }

  async readOrderCard(): Promise<OrderCard> {
    this.mark("readOrderCard");
    return {
      amazonOrderNo: "111-4820193-" + String(7730000 + Math.floor(Math.random() * 9999)),
      observedAsins: this.scenario === "wrong_asin"
        ? ["B0DIFFERENT"]
        : this.added.map((p) => p.asin),
    };
  }
}
