/** 模拟驱动:不碰 Amazon,只把页面动作换成返回固定值。
 *
 * 用途是自检「和服务端说话的时序」——认领、事件流、护栏裁决、回填断言、失败清车
 * 这一整套能不能真的跑通。场景与 tools/mock_plugin.py 一致,便于两边对照。
 */

import { NotImplemented, type CheckoutReading, type OrderCard, type PageDriver, type ProductPage } from "./driver.js";
import type { Shipping } from "../core/types.js";

export type Scenario = "happy" | "over_cap" | "oos" | "not_fba" | "wrong_asin" | "confirm_timeout";

export class SimulatedDriver implements PageDriver {
  readonly name = "simulated";
  readonly ready = true;

  readonly calls: string[] = [];

  constructor(
    private readonly scenario: Scenario = "happy",
    private readonly asins: string[] = [],
  ) {}

  private mark(step: string) { this.calls.push(step); }

  async clearCart(): Promise<void> { this.mark("clearCart"); }

  async openProduct(asin: string): Promise<ProductPage> {
    this.mark("openProduct:" + asin);
    return {
      inStock: this.scenario !== "oos",
      isFba: this.scenario !== "not_fba",
      listPrice: "9.99",
    };
  }

  async addToCart(asin: string, quantity: number): Promise<void> {
    this.mark(`addToCart:${asin}x${quantity}`);
  }

  async verifyCart(): Promise<boolean> { this.mark("verifyCart"); return true; }

  async fillAddress(_shipping: Shipping): Promise<void> { this.mark("fillAddress"); }

  async readCheckout(): Promise<CheckoutReading> {
    this.mark("readCheckout");
    const total = this.scenario === "over_cap" ? "99.00" : "10.79";
    return {
      actualTotal: total,
      actualShipping: "0.00",
      actualTax: "0.80",
      deliveryRaw: "Wednesday, August 27",
      isFba: true,
      paymentLast4: "4417",
      lineItems: this.asins.map((asin) => ({ asin, unit_price: "9.99", quantity: 1 })),
    };
  }

  async placeOrder(): Promise<void> {
    this.mark("placeOrder");
    if (this.scenario === "confirm_timeout") {
      // 已经点下去了,但没见到确认页 —— 最危险的那一格:可能已经下成了。
      throw new NotImplemented("确认页未出现(模拟)");
    }
  }

  async readOrderCard(): Promise<OrderCard> {
    this.mark("readOrderCard");
    return {
      amazonOrderNo: "111-4820193-" + String(7730000 + Math.floor(Math.random() * 9999)),
      observedAsins: this.scenario === "wrong_asin" ? ["B0DIFFERENT"] : this.asins,
    };
  }
}
