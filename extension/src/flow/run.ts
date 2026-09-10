/** 一单的执行时序。
 *
 * 三条来自 CLAUDE.md 的硬约束,在这里是代码而不是注释:
 *
 *  1. **失败必上报、必清车。** 每一条终止路径都走 finish(),它保证先清车再上报,
 *     不存在"只写本地日志"的出口。(厂商插件有 30+ 条只写日志的失败路径。)
 *  2. **点下单那一刻起,禁止 release。** mayHaveOrdered 一旦置位,任何失败都
 *     to_manual —— 退回队列等于让下一个实例把同一单再买一遍。
 *     而「越过下单点」这件事必须先在**服务端**留下一行才允许点:那条 step
 *     没落地就不点(见 placeOrder 之前那一段),否则库里那一位是 false,
 *     四道回队列的闸对这一单全是空的。
 *  3. **护栏裁决在服务端。** 这里只负责把结算页读到的数报上去,不自己比。
 */

import type { Client } from "../core/client.js";
import type { ErrorCode } from "../core/codes.js";
import { toManual } from "../core/codes.js";
import type { Log } from "../core/log.js";
import type { Phase } from "../core/status.js";
import type { Task } from "../core/types.js";
import { cartReadOf, DriverError, LoginLostError, type PageDriver } from "./driver.js";

export type Outcome =
  | { kind: "purchased"; amazonOrderNo: string }
  /** `cartCleared` 三个值都有意思,别归并成布尔:
   *   true  清干净了
   *   false **清车失败**(残留商品会污染这个买家号的下一单)
   *   null  没试过 —— 越过下单点之后按规矩不动购物车,这不是一次失败。
   *  Loop 的熔断只数 false;把 null 也数进去的话,每一单「可能已下单」
   *  都会被当成清不动车,三单之后整台机器停止认领,而购物车其实好好的。 */
  | { kind: "failed"; code: ErrorCode; toManual: boolean; cartCleared: boolean | null }
  /** 退回队列。`cartCleared` 与 failed 那一位同义(true 清干净了 / false 清不动 /
   *  null 没试过)——Loop 的清车熔断数的是「这一单有没有把车留干净」,
   *  而这条路上照样清过车,不带这一位的话它在熔断那本账上是一格空白。 */
  | { kind: "released"; cartCleared: boolean | null }
  /** 没跟服务端说上话。任务此刻仍是 claimed,交给服务端的超时清扫去收
   *  —— 它 15 分钟后转待人工,而不是退回队列。
   *
   *  `cartCleared` 与另外两个终态同义(true / false / null=没试过或不知道)。
   *  **任务的结局没说上话,不等于购物车的结局也不知道**:护栏裁决那一路
   *  (guard-check 传输失败)确确实实清过一次车,那一次清没清动是关于**这台机器**
   *  的事实,与服务端知不知道这一单无关。不带这一位的话,一台每一单都清不动车的
   *  机器在这条路上对清车熔断是隐形的。 */
  | { kind: "unreported"; message: string; cartCleared: boolean | null };

export interface RunDeps {
  client: Client;
  driver: PageDriver;
  log: Log;
  /** 下单前是否停下来等人按。**只有真的传了 askConfirm 才有意义。**
   *
   *  ⚠️ 现状:全仓**没有任何调用点提供 askConfirm**(content/runner.ts 构造 Loop 时
   *  没传),所以这一步实际不发生,core/status 里的 `confirm` 相位是死代码。
   *  这条注释原先写着「默认 true —— 花钱这一步永远有预览」,那是一句
   *  系统不会兑现的承诺,比不写更坏。
   *
   *  要接上的话,难的不是弹窗,是**等待必须有界**:人一直不按怎么办?
   *  超时默认「取消 → 清车 → 退回队列」是个说得通的答案,但它意味着
   *  「操作员去吃了个饭」和「他看了一眼觉得不对」落成同一个结果,
   *  而且那个上界还要和服务端的认领超时对齐(与 placeOrder 的硬顶同一条道理)。
   *  那是一个要单独定的决定,不在这一轮里顺手做。 */
  confirmBeforeOrder?: boolean;
  /** 预览步的应答。返回 false 表示人按了取消。 */
  askConfirm?: (task: Task, reading: { total: string; deliveryRaw?: string }) => Promise<boolean>;
  /** 执行中发现这个浏览器已被登出。**这一单怎么落地是另一回事** ——
   *  这个回调只负责把「这台机器登录态没了」这个事实往上说:
   *  Loop 据此停止认领,服务端据此拦住下一次认领,运营台据此把那个买家号标红。 */
  onLoginLost?: () => void;
  /** 相位变了(面板拿它换标签、换步骤条)。**只有 runTask 知道**「此刻在等人」
   *  这件事 —— Loop 那一层从 claim 到 return 之间一直是 running,
   *  而「正在等操作员做发卡行验证」和「机器正常在跑」必须是两个样子。 */
  onPhase?: (phase: Phase) => void;
  /** 进入/离开「等人做发卡行验证」。面板拿 deadlineMs 跑倒计时;
   *  离开时传 null。与 onPhase 分开:相位是给标签用的,这个是给倒计时用的。 */
  onVerifyWindow?: (deadlineMs: number | null) => void;
}

class Abort extends Error {
  constructor(readonly code: ErrorCode, readonly detail: string) {
    super(detail);
  }
}

export async function runTask(task: Task, deps: RunDeps): Promise<Outcome> {
  const { client, driver, log } = deps;

  // 服务端会在这个时刻把这条判成认领超时(task_sweep 只看 claimed_at)。
  // **起点在这里取,不在 placeOrder 里取**:清车/加购/填地址那几步的上界加起来
  // 就有五六分钟,它们同样记在服务端那本账上。少了这一段的话,插件算出来的
  // 「还能等多久」永远偏大,最坏的一格是:第 15 分钟服务端把单转成待人工,
  // 第 16 分钟这边订单下成了、单号也读到了,complete 拿回 409 TASK_NOT_HELD。
  // 这里比服务端的 claimed_at 晚一个 HTTP 来回(claim 的响应刚回来),
  // 偏乐观的那点由 orderServerMargin 兜着。
  const claimMin = task.claim_timeout_min;
  const claimDeadlineMs =
    typeof claimMin === "number" && Number.isFinite(claimMin) && claimMin > 0
      ? Date.now() + claimMin * 60_000
      : null;

  // 点下单那一刻起就是 true。注意置位时机在 placeOrder **之前** ——
  // 如果在点击过程中崩了,我们同样不知道单下没下成。
  // 置位排在「那条 step 已经落库」之后:留痕没写进去就根本不点,
  // 那时这一单还没花钱,退回队列才是对的。
  let mayHaveOrdered = false;

  /** 上报一条执行步骤。**返回值是有用的** —— 「点击下单按钮」那一条是下单的
   *  前置条件(见下面 armOrderLine),调用方要判它落没落地。别的几条是旁白,
   *  丢掉返回值无妨。 */
  const step = (text: string, payload: Record<string, unknown> = {}) => {
    log.info(text);
    return client.events(task.task_id, [{ kind: "step", payload: { step: text, ...payload } }]);
  };

  /** 清车,但**清不动不改变这一单的结局**。
   *
   *  裸调 clearCart 的两处(护栏没说上话、人按了取消)会让 DriverError 掉进最外层
   *  catch,于是「人主动按了取消」被渲染成 PLUGIN_INTERNAL 拍单异常 ——
   *  两件完全不同的事长成一个样子,而本该走的 /release 根本没发出去。
   *  失败要说出来(事件流 + 日志),但由调用方决定这一单怎么落地。 */
  const tryClear = async (where: string): Promise<boolean> => {
    try {
      await driver.clearCart();
      return true;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log.err(`${where}:清车失败 —— ${detail}(残留商品会污染这个买家号的下一单)`);
      // 先写事件流再返回:调用方接着可能会 release,那之后 /events 就会被
      // TASK_NOT_HELD 拒掉,这条痕迹就永远写不进去了。
      await client.events(task.task_id, [
        // 键名是 `warning` 而不是 `state`:服务端在 /fail 那一路写的就是
        // `warning=cart_not_cleared`(server/routes/tasks.py),运营台实例页那格
        // cart_fail_24h 数的也是它。同一件事两个生产者用两个键名的话,
        // 走这两条路(护栏没说上话 / 人按了取消)清不动车的机器在运营台上是隐形的。
        // `state` 那个键留给「此刻在哪一段」那套语义(manual_verification / plugin_hard_cap)。
        { kind: "step", payload: { step: "清车失败", warning: "cart_not_cleared", where, detail } },
      ]);
      return false;
    }
  };

  try {
    await step("清空购物车");
    await driver.clearCart();

    for (const p of task.products) {
      const added = await driver.addProduct(p.asin, p.quantity);
      // 商品页判得出「不是 Amazon 发货」就当场停,省掉后面几步。
      // 判不出来(null)不下结论 —— 结算页那道判定才是权威的。
      if (task.guards.require_fba && added.shipperIsAmazon === false) {
        throw new Abort("NOT_FBA", `${p.asin} 商品页显示配送方非 Amazon`);
      }
      await step(`加购 ${p.asin} × ${p.quantity}`);
    }

    if (!(await driver.verifyCart(task.products))) {
      // detail 里必须带上**实际读到的**是什么。只写「与本单不符」的话,
      // 「车里少了一件(被 Amazon 判不可售自动移除)」「车里多了一件(上一单没清干净)」
      // 「数量对不上」这三种处置完全不同的情况在运营台上长得一模一样,
      // 唯一能做的事是自己登录买家号去开购物车看。
      // 模拟驱动不具备这个能力(cartReadOf 返回 null),那就少写一段,别编。
      const got = cartReadOf(driver);
      const want = task.products.map((p) => `${p.asin}×${p.quantity}`).join(", ");
      const has = got === null
        ? ""                                        // 这个驱动不回报车里的行,那就别编
        : got.length === 0
          ? ",而车里一件都没有"
          : `,车里是 ${got.map((l) => `${l.asin}×${l.quantity ?? "?"}`).join(", ")}`;
      throw new Abort("CART_MISMATCH", `购物车回读与本单不符:本单要 ${want}${has}`);
    }
    await step("购物车核对通过");

    await driver.proceedToCheckout();
    await driver.fillAddress(task.shipping);
    await step("收货地址已填写");

    let reading = await driver.readCheckout();
    await step("读到结算页", {
      actual_total: reading.actualTotal,
      // 实付与货款分开报:礼品卡全额抵扣时前者是 0.00,后者才是这一单花的钱。
      // 只报前者的话,事件流里那条「实付 0.00」看起来像这单没花钱。
      gift_card_amount: reading.giftCard?.applied ? (reading.giftCard.amount ?? null) : null,
      goods_total: reading.goodsTotal ?? null,
      delivery_texts: reading.deliveryTexts,
    });

    // ── 替买家号切换支付卡(所有者定稿①)────────────────────────────
    //
    // **先切后验,验在服务端。** 切是插件的动作(这一行),验仍然只在
    // guard-check 那一侧 —— 服务端拿下面重读的那一份尾号自己判,
    // price_guard 的 PAYMENT_METHOD_UNEXPECTED 一个字没改。
    //
    // guards.expected_card_last4 为空(旧服务端 / 这个买家号不校验)时
    // ensurePaymentCard 一步都不做,这一行等于不存在。
    const cardSwitch = await driver.ensurePaymentCard(task.guards.expected_card_last4, {
      onSwitchStart: async ({ from, to }) => {
        await step("切换支付卡", { from, to });
      },
      onSwitched: async ({ from, to, matched }) => {
        // matched 是选卡时比中的那一段原文。留在事件流里是为了让
        // 「比中了 4417」与「在有效期里比中了 4417」将来分得开 ——
        // payselect 的判据没有任何真实页面担保,出事时这一段是唯一的现场。
        await step("支付卡已切换", { from, to, matched });
      },
    });

    if (cardSwitch.switched) {
      // **切完必须重读结算页。** 切卡会让 Amazon 把结算页整个重渲染:
      // 这张卡要扣多少变了(礼品卡抵扣的槽位跟着变)、有的卡会带来不同的
      // 促销与税、支付槽位数也可能从 1 变 2。拿切之前那份读数去报 guard-check,
      // 等于让服务端对着一张**已经不存在的页面**裁决 —— 而它放行之后我们真的
      // 会照着新页面下单。这不是保险起见,是切卡这个动作本身的定义。
      reading = await driver.readCheckout();
      await step("切卡后重读结算页", {
        actual_total: reading.actualTotal,
        gift_card_amount: reading.giftCard?.applied ? (reading.giftCard.amount ?? null) : null,
        goods_total: reading.goodsTotal ?? null,
        payment_last4: reading.paymentLast4 ?? null,
        payment_slots: reading.paymentSlots ?? null,
        note: "切支付卡会让结算页重渲染,下面报给护栏的是这一份重读的数",
      });
    }

    // 结算页有商品、却一个单价都没读到 —— 那是选择器坏了,不是「这单没单价」。
    // 不拦下单(限价护栏比的是 actual_total,走另一个选择器,仍然有效),
    // 但必须在事件流里留下痕迹:静默的话,运营台上「实付单价」整列悄悄变空,
    // 没有任何地方报错,等有人觉得不对已经是几百单之后。
    if (reading.unitPriceSelectorBroken) {
      await step("结算页单价读不全", {
        note: "有商品面板的单价没解析出来,多半是 Amazon 换了类名;" +
              "限价护栏不受影响(它比的是整单货款),但实付单价这一列会缺行",
        panels: reading.deliveryTexts.length,
        priced: reading.unitPrices.length,
      });
      log.warn(`结算页单价只读到 ${reading.unitPrices.length}/${reading.deliveryTexts.length} 条`
               + " —— 选择器可能失效了,单子照下但实付单价缺行");
    }

    // 单价来自结算页实测,数量来自任务 —— 购物车那一步已经核对过车里就是这些。
    const lineItems = reading.unitPrices.map((u) => ({
      ...u,
      quantity: task.products.find((p) => p.asin === u.asin)?.quantity ?? 1,
    }));

    // 护栏:插件只报数,服务端裁决。
    const verdict = await client.guardCheck(task.task_id, {
      actual_total: reading.actualTotal,
      actual_shipping: reading.actualShipping,
      actual_tax: reading.actualTax,
      // 礼品卡与货款:护栏比的是货款,不是这张卡要扣的钱。
      // amount 为 null = 认出抵扣行但读不出金额,服务端会拒 —— 算不出基数就不下单。
      gift_card: reading.giftCard
        ? { applied: reading.giftCard.applied, amount: reading.giftCard.amount ?? null }
        : undefined,
      goods_total: reading.goodsTotal,
      // 下单**之前**就把卡尾号报上去。此前它只在 complete 里出现,
      // 也就是说下单前从不过问支付方式,换了卡只能等对账时才发现。
      payment_last4: reading.paymentLast4,
      // 槽位数:服务端扣掉礼品卡那一个之后 >1 即拆分支付。
      payment_slots: reading.paymentSlots,
      line_items: lineItems,
      delivery_raws: reading.deliveryTexts,
      is_fba: reading.isFba,
    });
    if (!verdict.ok) {
      // 没拿到裁决就绝不下单 —— 宁可这一单不做,也不在没闸门的情况下花钱。
      if (verdict.kind === "transport") {
        log.err("护栏裁决没说上话:" + verdict.message + " —— 不下单,清车");
        const cleared = await tryClear("护栏没说上话");
        return { kind: "unreported", message: verdict.message, cartCleared: cleared };
      }
      throw new Abort("PLUGIN_INTERNAL", `护栏裁决被拒:${verdict.code} ${verdict.message}`);
    }
    if (!verdict.data.allow) {
      const code = (verdict.data.error_code ?? "PLUGIN_INTERNAL") as ErrorCode;
      throw new Abort(code, verdict.data.detail ?? "护栏拦截");
    }
    // 这行字必须说的是服务端**真正比过**的那个数。写「实付 0.00 ≤ 限价 2500」
    // 而实际比的是货款 2241.86,人看着就以为这单没花钱。
    log.ok(`护栏放行 · 货款 ${verdict.data.goods_total ?? reading.actualTotal}`
           + ` ≤ 限价 ${task.guards.price_cap}`
           + (reading.giftCard?.applied ? `(其中礼品卡抵扣 ${reading.giftCard.amount})` : ""));

    // 服务端最终采信哪条交期,回填时要原样带回,不能让插件另挑一条。
    const deliveryUsed = verdict.data.delivery_raw_used ?? undefined;

    if (deps.confirmBeforeOrder !== false && deps.askConfirm) {
      const go = await deps.askConfirm(task, {
        total: reading.actualTotal,
        deliveryRaw: deliveryUsed,
      });
      if (!go) {
        log.warn("人按了取消 —— 清车,退回队列");
        // 清不干净也照样 release:这一单本身没毛病,人只是不想现在买它。
        // 把它记成 PLUGIN_INTERNAL 拍单异常,等于用「插件崩了」去表达「人按了取消」。
        const cleared = await tryClear("人按了取消");
        const rel = await client.release(task.task_id);
        return rel.ok
          ? { kind: "released", cartCleared: cleared }
          : { kind: "unreported", message: "release 失败", cartCleared: cleared };
      }
    }

    // **先说,再点 —— 而且是「说上了才点」。** 这条事件不是旁白,是下单的
    // **前置条件**:服务端收到 may_have_ordered 才会把 tasks.may_have_ordered 置上,
    // 而那四道「回队列之前先看一眼」的闸(人工重置 / 批量重置 / 自动重试选单 /
    // 插件自己调的 /release)没有一道自己看得出「越过下单点了」,全都在等这一位。
    //
    // 原先这里丢掉了返回值:一次网络抖动、一次服务端重启、一次 15 秒超时,
    // 这条 POST 就没说上话,而下一行照点不误 —— 单在 Amazon 上真下成了,
    // 库里那一位却还是 false,四道闸一起退化成招牌,这张已经花过钱的单
    // 会被人一键重置、或被 task_retry 自动放回队列,在亚马逊上再买一遍。
    //
    // 所以:没落地就不点。**这一刻还没花钱**,清车退回队列是安全的那一边;
    // 点下去才是不安全的那一边。
    let armed = await step("点击下单按钮", { may_have_ordered: true });
    if (!armed.ok && armed.kind === "transport") {
      // 没说上话就重发一次:服务端那条 `UPDATE ... WHERE NOT may_have_ordered`
      // 是幂等的,事件表只追加 —— 多一条重复的 step,比让四道闸失效便宜太多。
      log.warn("「点击下单按钮」这条留痕没说上话,重发一次 —— 它没落地就不能点下单");
      armed = await step("点击下单按钮", { may_have_ordered: true });
    }
    if (!armed.ok) {
      const why = armed.kind === "business" ? `${armed.code} ${armed.message}` : armed.message;
      log.err(`「越过下单点」这条留痕没能写进服务端(${why}) —— 不点下单,清车退回队列。` +
              `服务端不知道我们要点下单的话,那四道「重置前先确认」的闸对这一单全是空的`);
      const cleared = await tryClear("下单点留痕没落地");
      // release 被 409 POSSIBLY_ORDERED 拒掉是**正常的**:说明第一次 POST 其实
      // 落了库、只是响应没回来。那时任务停在 claimed,由服务端的超时清扫
      // 转待人工 —— 比退回队列更该走的那条路。
      const rel = await client.release(task.task_id);
      return rel.ok
        ? { kind: "released", cartCleared: cleared }
        : { kind: "unreported", message: rel.message, cartCleared: cleared };
    }

    mayHaveOrdered = true;               // ← 从这里开始,退回队列是被禁止的
    await driver.placeOrder({
      // 上界由服务端给,不让插件自己拍。见 flow/amazon.orderHardCapMs。
      claimDeadlineMs,
      onManualVerification: async ({ deadlineMs }) => {
        deps.onPhase?.("verify");
        deps.onVerifyWindow?.(deadlineMs);
        log.warn("Amazon 转到了发卡行验证页 —— 请在本页弹出的窗口里完成验证,不要关闭它");
        await step("等待人工完成支付验证",
                   { state: "manual_verification", deadline_ms: deadlineMs });
      },
      onVerificationDone: async () => {
        deps.onPhase?.("running");
        deps.onVerifyWindow?.(null);
        await step("人工支付验证已完成", { state: "manual_verification_done" });
      },
    });
    await step("下单 · 确认页已出现");

    const card = await driver.readOrderCard();
    const done = await client.complete(task.task_id, {
      amazon_order_no: card.amazonOrderNo,
      actual_total: reading.actualTotal,
      actual_shipping: reading.actualShipping,
      actual_tax: reading.actualTax,
      payment_last4: reading.paymentLast4,
      delivery_raw: deliveryUsed,
      observed_asins: card.observedAsins,
      // 同一份实测单价,护栏那一步报过一次,落库要在这一步 ——
      // 被护栏拦下的单没有"实付单价"可言,不该往库里写
      line_items: lineItems,
    });

    if (done.ok) {
      log.ok(`回填 ${card.amazonOrderNo} · ASIN 断言通过`);
      return { kind: "purchased", amazonOrderNo: card.amazonOrderNo };
    }
    if (done.kind === "business") {
      // 断言不过时服务端已经把任务转成待人工了,插件这边不用再报一次。
      log.err(`回填被拒:${done.code} ${done.message}`);
      // cartCleared 是 null 而不是 false:这一单已经越过下单点,按规矩就不该动
      // 购物车 —— 没试过和试了没成是两回事(Loop 的清车熔断只数后者)。
      return { kind: "failed", code: done.code as ErrorCode, toManual: true, cartCleared: null };
    }
    log.err("回填没说上话:" + done.message + " —— 单可能已经下成,交给服务端超时清扫");
    // 越过下单点之后按规矩没动过购物车 —— null 是「没试过」,不是「清不动」。
    return { kind: "unreported", message: done.message, cartCleared: null };

  } catch (e) {
    if (e instanceof LoginLostError) {
      // 无论这一单最后怎么落地,「这台机器被登出了」都是既成事实,先说出去。
      // 不说的话,下一单会照样被领走、照样走到 /ap/signin —— 一个被登出的
      // 买家号能这样一口气废掉整队的单,而每一单看起来都只是"页面慢"。
      deps.onLoginLost?.();
      if (!mayHaveOrdered) {
        return releaseAfterLoginLost(task, e.message, deps);
      }
      // 越过下单点了:退回队列是被禁止的(见文件头第 2 条),往下走既有的转人工路径。
      // 那时要说的事情已经变了 —— 「可能已经花了钱」比「被登出了」更要紧。
    }
    // 驱动认得出原因的失败(DriverError)直接用它的码;认不出的才兜底。
    const code: ErrorCode = e instanceof Abort || e instanceof DriverError
      ? e.code
      : (mayHaveOrdered ? "ORDER_CONFIRM_TIMEOUT" : "PLUGIN_INTERNAL");
    const detail = e instanceof Error ? e.message : String(e);
    return finish(task, code, detail, mayHaveOrdered, deps);
  } finally {
    // 面板上那条倒计时不能留在屏幕上:这一单已经结束了,而它长得像还在等人。
    deps.onVerifyWindow?.(null);
    // iframe 一定要收掉,不管这一单是怎么结束的。
    try { await driver.dispose(); } catch { /* 收尾失败不改变这一单的结局 */ }
  }
}

/** 登录态失效且**还没到下单点**:退回队列,不记异常。
 *
 * 为什么是 release 而不是 fail:这一单本身没有任何毛病 —— 没缺货、没超限价、
 * 地址也没问题,只是这台机器的浏览器被登出了。记成 exception 会把一堆好单
 * 堆进「拍单异常」桶,让人挨个去看一遍才发现原因都一样;
 * 而退回队列之后,这些单在人重新登录之后自己就会被领走。
 *
 * 队列不会因此空转:服务端那道闸(login_state = signed_out 拒绝认领)已经
 * 把这个买家号关在门外,退回去的单会安静地等着,不会被同一台机器立刻再领一次。
 */
async function releaseAfterLoginLost(
  task: Task,
  detail: string,
  deps: RunDeps,
): Promise<Outcome> {
  const { client, driver, log } = deps;
  log.err(`登录态失效 —— 这个买家号的浏览器已被登出,这一单退回队列。` +
          `请在这个浏览器里重新登录 Amazon,插件复检到之后会自己继续。(${detail})`);

  // **先写事件流,再退回队列。** release 之后这条任务就不再归本实例持有,
  // /events 会被 TASK_NOT_HELD 拒掉 —— 那条 step 就永远写不进去了,
  // 而运营台上这一单看起来会是「领走了又回来了,什么也没说」。
  await client.events(task.task_id, [
    { kind: "step", payload: { step: "登录态失效,退回队列", detail } },
  ]);

  // 清车:没到下单点,车里可能还留着这一单的东西,不清会污染下一单。
  // 清不掉不改变结局(页面多半已经在登录页上了,本来也清不动),但**要说出来**:
  // 这一位要带回给 Loop 的清车熔断,那本账上不该有空白格。
  let cartCleared = false;
  try {
    await driver.clearCart();
    cartCleared = true;
  } catch (e) {
    log.warn("退回队列前清车失败:" + (e instanceof Error ? e.message : String(e)));
  }

  const rel = await client.release(task.task_id);
  if (!rel.ok) {
    // 没说上话:任务仍是 claimed,交给服务端的超时清扫(15 分钟后转待人工)。
    return { kind: "unreported", message: rel.message, cartCleared };
  }
  return { kind: "released", cartCleared };
}

/** 唯一的失败出口:先清车,再上报。两件事都做完才算这一单结束。 */
async function finish(
  task: Task,
  code: ErrorCode,
  detail: string,
  mayHaveOrdered: boolean,
  deps: RunDeps,
): Promise<Outcome> {
  const { client, driver, log } = deps;

  // null = 没试过(越过下单点,按规矩不动购物车)。与「试了没成」分开 ——
  // 合成一个 false 的话,Loop 那道清车熔断会把每一单「可能已下单」都算成
  // 一次清不动车,三单之后整台机器停止认领,而购物车其实好好的。
  let cartCleared: boolean | null = null;
  if (mayHaveOrdered) {
    // 单可能已经下成了,这时清车没有意义(车本来就空了),也不该再动页面。
    log.warn("已越过下单点,不再动购物车");
  } else {
    cartCleared = false;
    try {
      await driver.clearCart();
      cartCleared = true;
    } catch (e) {
      // 清车失败要说出来:残留商品会污染这个买家号的下一单。
      log.err("清车失败:" + (e instanceof Error ? e.message : String(e)));
    }
  }

  const manual = mayHaveOrdered || toManual(code);
  log.err(`${code} · ${detail}${manual ? " → 转待人工" : " → 拍单异常"}`);

  const res = await client.fail(task.task_id, {
    error_code: code,
    detail,
    to_manual: manual,
    cart_cleared: cartCleared === true,
    // **有没有试过**要与**试的结果**分开报。服务端原先只看 cart_cleared:
    // 越过下单点那一路(按规矩不清车)与真的清不动车,在事件流里写成同一条
    // `warning: cart_not_cleared` —— 而前者是规矩被遵守了,后者是这台机器
    // 清不动购物车、下一单会被残留污染。运营台上那一格数的是后者。
    cart_clear_attempted: cartCleared !== null,
  });
  if (!res.ok) {
    log.err("上报失败也没说上话:" + (res.kind === "business" ? res.message : res.message));
    return { kind: "unreported", message: detail, cartCleared };
  }
  return { kind: "failed", code, toManual: manual, cartCleared };
}
