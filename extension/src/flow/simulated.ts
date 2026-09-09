/** 模拟驱动:不碰 Amazon,只把页面动作换成返回固定值。
 *
 * 用途是自检「和服务端说话的时序」——认领、事件流、护栏裁决、回填断言、失败清车
 * 这一整套能不能真的跑通。场景与 tools/mock_plugin.py 一致,便于两边对照。
 */

import { DriverError, LoginLostError, type AddResult, type CheckoutReading, type OrderCard, type PageDriver, type PaymentCardHooks, type PaymentCardResult, type PlaceOrderHooks } from "./driver.js";
import type { LoginState } from "./dom/parse.js";
import type { ShipmentReader, TrackingRead } from "./shipment.js";
import type { Shipping } from "../core/types.js";

export type Scenario =
  | "happy" | "over_cap" | "oos" | "not_fba" | "wrong_asin"
  | "confirm_timeout" | "late_delivery" | "cart_mismatch"
  /** 跑到一半发现买家号被登出。**没到下单点**,所以这一单该退回队列,
   *  而不是记成一次拍单异常 —— 单子本身没毛病,是这台机器的环境坏了。 */
  | "login_lost"
  /** 点了下单 → Amazon 转到发卡行验证页(跨域)→ 操作员做完 → 确认页。
   *  验的是「等人」这条路真的能走通:两条 step 事件发得出去、面板起得来相位、
   *  回填照常发生。 */
  | "manual_verify"
  /** 同上,但人没在时限内做完。这一格必须落成 PAYMENT_VERIFICATION_TIMEOUT
   *  且 to_manual —— 订单可能已经提交,退回队列就是重复下单。 */
  | "manual_verify_timeout"
  /** 买家号当前刷的是 9021,任务下发的期望卡是 4417 → 切成功 → 照常拍单。
   *  验的是所有者定稿①那条链:期望卡随认领下发、插件切、**切完重读结算页**、
   *  护栏拿重读的那一份裁决。 */
  | "card_switch"
  /** 同上但切不动(模拟「没有唯一命中的那张卡」)。这一格必须落成
   *  PAYMENT_METHOD_UNEXPECTED、**to_manual=false**(归 BUSINESS_BLOCKED:
   *  重试多少次结果都一样,而且这一步在下单**之前**,钱一分没花)、且清车。 */
  | "card_switch_fail";

export class SimulatedDriver implements PageDriver {
  readonly name = "simulated";
  readonly ready = true;

  readonly calls: string[] = [];
  private added: Array<{ asin: string; quantity: number }> = [];

  /** 结算页此刻选中的卡尾号。切卡那两个场景故意从"不是期望的那张"开始 ——
   *  其余场景照旧是 4417,与 tests/test_server_flow.py 里那条护栏用例同一个数。
   *
   *  **它是可变的**:切成功之后 readCheckout 必须读到新的那张。写死成常量的话,
   *  「切了」和「没切」在事件流与护栏上报里长成同一个样子,这个场景就白跑了。 */
  private card: string;

  constructor(private readonly scenario: Scenario = "happy") {
    this.card = (scenario === "card_switch" || scenario === "card_switch_fail")
      ? "9021" : "4417";
  }

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
    // 相对今天算,不写死月日:写死的日期过了当天就会被交期解析(正确地)判成
    // 「已过去 → 不凭空滚到明年 → 解析不出」,整套 smoke 跟着日历一起坏掉。
    const deliveryTexts = this.scenario === "late_delivery"
      ? [weekdayMonthDay(2), weekdayMonthDay(14)]
      : [weekdayMonthDay(2), weekdayMonthDay(5)];
    return {
      actualTotal: total,
      actualShipping: "0.00",
      actualTax: "0.80",
      deliveryTexts,
      isFba: this.scenario === "not_fba" ? false : true,
      paymentLast4: this.card,
      unitPrices: this.added.map((p) => ({ asin: p.asin, unit_price: "9.99" })),
    };
  }

  /** 期望为空一步不做;已经是那张就不动;否则"切"一下(改一个字段)。
   *
   *  `card_switch_fail` 抛的是真驱动那一段会抛的东西:同一个错误码、
   *  同一句「切支付卡停在「...」」的前缀。smoke 那一格断言的就是这条链
   *  在服务端落成 PAYMENT_METHOD_UNEXPECTED / to_manual=false / 清了车。 */
  async ensurePaymentCard(expected: string | null | undefined,
                          hooks: PaymentCardHooks = {}): Promise<PaymentCardResult> {
    this.mark("ensurePaymentCard:" + (expected ?? "-"));
    const want = (expected ?? "").trim();
    if (!want) return { last4: this.card, switched: false };
    if (this.card === want) return { last4: this.card, switched: false };

    const from = this.card;
    await hooks.onSwitchStart?.({ from, to: want });
    if (this.scenario === "card_switch_fail") {
      throw new DriverError(
        "PAYMENT_METHOD_UNEXPECTED",
        `切支付卡停在「没有唯一命中的那张卡」:支付选择页上有 2 个卡片单选钮,` +
        `但没有**恰好一个**的尾号是 ${want}(模拟)`);
    }
    this.card = want;
    this.mark(`cardSwitched:${from}->${want}`);
    // matched 给 null:模拟档没有页面,编一段"比中的原文"出来就是假证据。
    await hooks.onSwitched?.({ from, to: want, matched: null });
    return { last4: want, switched: true };
  }

  async placeOrder(hooks: PlaceOrderHooks = {}): Promise<void> {
    this.mark("placeOrder");
    if (this.scenario === "confirm_timeout") {
      // 已经点下去了,但没见到确认页 —— 最危险的那一格:可能已经下成了。
      throw new DriverError("ORDER_CONFIRM_TIMEOUT", "点了下单但没等到确认页(模拟)");
    }
    if (this.scenario === "manual_verify" || this.scenario === "manual_verify_timeout") {
      // 真驱动这里是「结算 iframe 落进不透明源」;模拟档没有页面,直接把
      // 两个回调按真实顺序调一遍 —— 验的是 run.ts 那两条 step 事件与相位切换。
      // deadline 用真驱动同一个形状:epoch 毫秒,面板拿它跑倒计时。
      this.mark("manualVerification");
      await hooks.onManualVerification?.({ deadlineMs: Date.now() + 6 * 60_000 });
      if (this.scenario === "manual_verify_timeout") {
        throw new DriverError("PAYMENT_VERIFICATION_TIMEOUT",
                              "点了下单,页面转到发卡行验证页,等了 360 秒仍未完成(模拟)");
      }
      this.mark("verificationDone");
      await hooks.onVerificationDone?.();
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
/** 「Wednesday, September 9」这种 Amazon 结算页的交期写法,从今天往后数 n 天。 */
function weekdayMonthDay(daysFromToday: number): string {
  const d = new Date(); d.setDate(d.getDate() + daysFromToday);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

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
