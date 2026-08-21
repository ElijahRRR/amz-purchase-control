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
import { DriverError, type PageDriver } from "./driver.js";

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
      throw new Abort("CART_MISMATCH", "购物车回读与本单不符");
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

    // 护栏:插件只报数,服务端裁决。
    const verdict = await client.guardCheck(task.task_id, {
      actual_total: reading.actualTotal,
      actual_shipping: reading.actualShipping,
      actual_tax: reading.actualTax,
      // 单价来自结算页实测,数量来自任务 —— 购物车那一步已经核对过车里就是这些。
      line_items: reading.unitPrices.map((u) => ({
        ...u,
        quantity: task.products.find((p) => p.asin === u.asin)?.quantity ?? 1,
      })),
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
