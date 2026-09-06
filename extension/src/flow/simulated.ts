/** 模拟驱动:不碰 Amazon,只把页面动作换成返回固定值。
 *
 * 用途是自检「和服务端说话的时序」——认领、事件流、护栏裁决、回填断言、失败清车
 * 这一整套能不能真的跑通。场景与 tools/mock_plugin.py 一致,便于两边对照。
 */

import { DriverError, LoginLostError, type AddResult, type CheckoutReading, type OrderCard, type PageDriver } from "./driver.js";
import type { LoginState } from "./dom/parse.js";
import type { ShipmentReader, TrackingRead } from "./shipment.js";
import type { Shipping } from "../core/types.js";

export type Scenario =
  | "happy" | "over_cap" | "oos" | "not_fba" | "wrong_asin"
  | "confirm_timeout" | "late_delivery" | "cart_mismatch"
  /** 跑到一半发现买家号被登出。**没到下单点**,所以这一单该退回队列,
   *  而不是记成一次拍单异常 —— 单子本身没毛病,是这台机器的环境坏了。 */
  | "login_lost";

export class SimulatedDriver implements PageDriver {
  readonly name = "simulated";
  readonly ready = true;

  readonly calls: string[] = [];
  private added: Array<{ asin: string; quantity: number }> = [];

  constructor(private readonly scenario: Scenario = "happy") {}

  private mark(step: string) { this.calls.push(step); }

  async dispose(): Promise<void> { this.mark("dispose"); }

  /** 模拟档**一次页面都没读过,所以只能说"不知道"**。
   *
   *  这里返回 "ok" 是很自然的写法,也很危险:这一位会随心跳上到服务端,
   *  而 ok 是唯一能解封 signed_out 的信号(services/instance._KEEPS_OLD_LOGIN_STATE)。
   *  于是运营在面板上点一下「模拟」,就能把一台确实被登出、库里已经记着
   *  signed_out 的机器洗成绿色的「已登录 · 刚刚检查过」,认领闸随之打开 ——
   *  「从没检查过」与「真读过页面、登录着」渲染成同一个结果,
   *  正是这一列存在的理由的反面。
   *
   *  unknown 不拦认领,所以模拟档该跑的闭环照样跑得通;login_lost 场景在执行到
   *  一半时才抛 LoginLostError,模拟的是「认领时还在、跑着跑着掉了」,也不受影响。 */
  async readLoginState(): Promise<LoginState> {
    this.mark("readLoginState");
    return "unknown";
  }

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

  async proceedToCheckout(): Promise<void> {
    this.mark("proceedToCheckout");
    if (this.scenario === "login_lost") {
      throw new LoginLostError("跳转结算页:买家号已被登出(模拟)");
    }
  }

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

/** 物流同步的模拟读取器。场景与 SimulatedDriver 分开给,
 *  因为这条流跑在 purchased 之后,和拍单场景不是同一批。 */
export type ShipScenario =
  | "in_transit" | "delivered" | "not_shipped" | "cancelled" | "not_found"
  /** Amazon 跟踪页明说「这会儿给不了轨迹」—— 与「我们没解析出来」是两回事,
   *  这一条把那条分支也跑进闭环里(服务端要认 tracking_unavailable)。 */
  | "unavailable";

export class SimulatedShipmentReader implements ShipmentReader {
  readonly name = "simulated";
  readonly ready = true;
  readonly calls: string[] = [];

  constructor(private readonly scenario: ShipScenario = "in_transit") {}

  async dispose(): Promise<void> { this.calls.push("dispose"); }

  async readOrder(amazonOrderNo: string) {
    this.calls.push("readOrder:" + amazonOrderNo);
    if (this.scenario === "not_found") return { state: "not_found" as const, trackingUrl: null };
    if (this.scenario === "cancelled") return { state: "cancelled" as const, trackingUrl: null };
    if (this.scenario === "not_shipped") return { state: "ok" as const, trackingUrl: null };
    return {
      state: "ok" as const,
      trackingUrl: "https://www.amazon.com/progress-tracker/package/ref=x?orderId=" + amazonOrderNo,
    };
  }

  async readTracking(_url: string): Promise<TrackingRead> {
    this.calls.push("readTracking");
    if (this.scenario === "unavailable") {
      return { trackingNo: null, carrier: null, status: null, promise: null,
               events: [], unavailable: true };
    }
    const delivered = this.scenario === "delivered";
    return {
      trackingNo: "TBA305271884221",
      carrier: "AMZL US",
      status: delivered ? "delivered" : "in_transit",
      promise: delivered ? null : "Wednesday, August 27",
      events: [
        ...(delivered
          ? [{ raw_day: "August 27, 2026", raw_time: "2:15 PM",
               description: "Delivered, Left with individual",
               city: "Santa Ana", state_code: "CA" }]
          : []),
        { raw_day: "August 26, 2026", raw_time: "8:42 AM",
          description: "Out for delivery", city: "Santa Ana", state_code: "CA" },
        { raw_day: "August 25, 2026", raw_time: "11:03 PM",
          description: "Package arrived at carrier facility",
          city: "Los Angeles", state_code: "CA" },
        { raw_day: "August 24, 2026", raw_time: null,
          description: "Package has left the carrier facility", city: null, state_code: null },
      ],
    };
  }
}
