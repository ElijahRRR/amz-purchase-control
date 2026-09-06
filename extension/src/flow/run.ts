/** 一单的执行时序。
 *
 * 三条来自 CLAUDE.md 的硬约束,在这里是代码而不是注释:
 *
 *  1. **失败必上报、必清车。** 每一条终止路径都走 finish(),它保证先清车再上报,
 *     不存在"只写本地日志"的出口。(厂商插件有 30+ 条只写日志的失败路径。)
 *  2. **点下单那一刻起,禁止 release。** mayHaveOrdered 一旦置位,任何失败都
 *     to_manual —— 退回队列等于让下一个实例把同一单再买一遍。
 *  3. **护栏裁决在服务端。** 这里只负责把结算页读到的数报上去,不自己比。
 */

import type { Client } from "../core/client.js";
import type { ErrorCode } from "../core/codes.js";
import { toManual } from "../core/codes.js";
import type { Log } from "../core/log.js";
import type { Task } from "../core/types.js";
import { cartReadOf, DriverError, LoginLostError, type PageDriver } from "./driver.js";

export type Outcome =
  | { kind: "purchased"; amazonOrderNo: string }
  | { kind: "failed"; code: ErrorCode; toManual: boolean }
  | { kind: "released" }
  /** 没跟服务端说上话。任务此刻仍是 claimed,交给服务端的超时清扫去收
   *  —— 它 15 分钟后转待人工,而不是退回队列。 */
  | { kind: "unreported"; message: string };

export interface RunDeps {
  client: Client;
  driver: PageDriver;
  log: Log;
  /** 下单前是否停下来等人按。默认 true —— 花钱这一步永远有预览。 */
  confirmBeforeOrder?: boolean;
  /** 预览步的应答。返回 false 表示人按了取消。 */
  askConfirm?: (task: Task, reading: { total: string; deliveryRaw?: string }) => Promise<boolean>;
  /** 执行中发现这个浏览器已被登出。**这一单怎么落地是另一回事** ——
   *  这个回调只负责把「这台机器登录态没了」这个事实往上说:
   *  Loop 据此停止认领,服务端据此拦住下一次认领,运营台据此把那个买家号标红。 */
  onLoginLost?: () => void;
}

class Abort extends Error {
  constructor(readonly code: ErrorCode, readonly detail: string) {
    super(detail);
  }
}

export async function runTask(task: Task, deps: RunDeps): Promise<Outcome> {
  const { client, driver, log } = deps;

  // 点下单那一刻起就是 true。注意置位时机在 placeOrder **之前** ——
  // 如果在点击过程中崩了,我们同样不知道单下没下成。
  let mayHaveOrdered = false;

  const step = async (text: string, payload: Record<string, unknown> = {}) => {
    log.info(text);
    await client.events(task.task_id, [{ kind: "step", payload: { step: text, ...payload } }]);
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

    const reading = await driver.readCheckout();
    await step("读到结算页", {
      actual_total: reading.actualTotal,
      delivery_texts: reading.deliveryTexts,
    });

    // 结算页有商品、却一个单价都没读到 —— 那是选择器坏了,不是「这单没单价」。
    // 不拦下单(限价护栏比的是 actual_total,走另一个选择器,仍然有效),
    // 但必须在事件流里留下痕迹:静默的话,运营台上「实付单价」整列悄悄变空,
    // 没有任何地方报错,等有人觉得不对已经是几百单之后。
    if (reading.unitPriceSelectorBroken) {
      await step("结算页单价读不到", {
        note: "有商品面板但一个单价都没解析出来,多半是 Amazon 换了类名;" +
              "限价护栏不受影响(它比的是整单实付),但实付单价这一列会是空的",
      });
      log.warn("结算页一个单价都没读到 —— 选择器可能失效了,单子照下但实付单价缺失");
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
      line_items: lineItems,
      delivery_raws: reading.deliveryTexts,
      is_fba: reading.isFba,
    });
    if (!verdict.ok) {
      // 没拿到裁决就绝不下单 —— 宁可这一单不做,也不在没闸门的情况下花钱。
      if (verdict.kind === "transport") {
        log.err("护栏裁决没说上话:" + verdict.message + " —— 不下单,清车");
        await driver.clearCart();
        return { kind: "unreported", message: verdict.message };
      }
      throw new Abort("PLUGIN_INTERNAL", `护栏裁决被拒:${verdict.code} ${verdict.message}`);
    }
    if (!verdict.data.allow) {
      const code = (verdict.data.error_code ?? "PLUGIN_INTERNAL") as ErrorCode;
      throw new Abort(code, verdict.data.detail ?? "护栏拦截");
    }
    log.ok(`护栏放行 · 实付 ${reading.actualTotal} ≤ 限价 ${task.guards.price_cap}`);

    // 服务端最终采信哪条交期,回填时要原样带回,不能让插件另挑一条。
    const deliveryUsed = verdict.data.delivery_raw_used ?? undefined;

    if (deps.confirmBeforeOrder !== false && deps.askConfirm) {
      const go = await deps.askConfirm(task, {
        total: reading.actualTotal,
        deliveryRaw: deliveryUsed,
      });
      if (!go) {
        log.warn("人按了取消 —— 清车,退回队列");
        await driver.clearCart();
        const rel = await client.release(task.task_id);
        return rel.ok ? { kind: "released" } : { kind: "unreported", message: "release 失败" };
      }
    }

    mayHaveOrdered = true;               // ← 从这里开始,退回队列是被禁止的
    await driver.placeOrder();
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
      return { kind: "failed", code: done.code as ErrorCode, toManual: true };
    }
    log.err("回填没说上话:" + done.message + " —— 单可能已经下成,交给服务端超时清扫");
    return { kind: "unreported", message: done.message };

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
  // 清不掉不改变结局(页面多半已经在登录页上了,本来也清不动)。
  try {
    await driver.clearCart();
  } catch (e) {
    log.warn("退回队列前清车失败:" + (e instanceof Error ? e.message : String(e)));
  }

  const rel = await client.release(task.task_id);
  if (!rel.ok) {
    // 没说上话:任务仍是 claimed,交给服务端的超时清扫(15 分钟后转待人工)。
    return { kind: "unreported", message: rel.message };
  }
  return { kind: "released" };
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

  let cartCleared = false;
  if (mayHaveOrdered) {
    // 单可能已经下成了,这时清车没有意义(车本来就空了),也不该再动页面。
    log.warn("已越过下单点,不再动购物车");
  } else {
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
    cart_cleared: cartCleared,
  });
  if (!res.ok) {
    log.err("上报失败也没说上话:" + (res.kind === "business" ? res.message : res.message));
    return { kind: "unreported", message: detail };
  }
  return { kind: "failed", code, toManual: manual };
}
