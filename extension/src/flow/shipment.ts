/** 物流同步:把已下单的任务在 Amazon 上的轨迹抓回来。
 *
 * 与拍单流的关系:这条流跑在任务已经 purchased 之后,不改任务状态,
 * 只往 logistics 域写。所以它失败了不会把一单已完成的采购掀翻 ——
 * 这是刻意的,见 server/routes/shipments.py 里 not_found 那段注释。
 *
 * 只存结构化事件,**不存整页 HTML**。厂商回传整页 HTML + 内联全站 CSS 的 base64,
 * 无长度上限,单请求可达 MB 级(报告 §5.2)。要凭证时按需重抓。
 */

import type { Client } from "../core/client.js";
import type { Log } from "../core/log.js";
import type { OrderState } from "./dom/parse.js";

export interface TrackingRead {
  trackingNo: string | null;
  carrier: string | null;
  status: "not_shipped" | "in_transit" | "delivered" | "cancelled" | null;
  promise: string | null;
  /** Amazon 明说「这会儿给不了轨迹」。与「我们没解析出来」分开 ——
   *  两者都是 0 条轨迹,但前者等下一轮就好,后者是选择器坏了要人去看。 */
  unavailable?: boolean;
  events: Array<{
    raw_day: string | null;
    raw_time: string | null;
    description: string | null;
    city: string | null;
    state_code: string | null;
  }>;
}

export interface ShipmentReader {
  readonly name: string;
  readonly ready: boolean;
  /** 打开订单详情页:先判订单本身的状态,再顺手拿跟踪链接。 */
  readOrder(amazonOrderNo: string): Promise<{ state: OrderState; trackingUrl: string | null }>;
  readTracking(url: string): Promise<TrackingRead>;
  dispose(): Promise<void>;
}

export interface SyncSummary {
  attempted: number;
  synced: number;
  cancelled: number;
  notFound: number;
  /** Amazon 明说这会儿给不了轨迹。**不算 failed** —— 那是它那边的事,
   *  混进 failed 会让「我们坏了」的数字长期不为零,然后没人再看它。 */
  unavailable: number;
  failed: number;
}

export async function syncShipments(
  client: Client,
  reader: ShipmentReader,
  log: Log,
  limit?: number,
): Promise<SyncSummary> {
  const summary: SyncSummary = { attempted: 0, synced: 0, cancelled: 0, notFound: 0,
                                 unavailable: 0, failed: 0 };

  const pending = await client.shipmentPending(limit);
  if (!pending.ok) {
    // 「没说上话」不能当成「没有要同步的」。
    log.err("拉待同步列表失败:" + (pending.kind === "business" ? pending.code : pending.message));
    return summary;
  }
  const items = pending.data.items;
  if (items.length === 0) return summary;

  log.info(`待同步物流 ${items.length} 单`);

  try {
    for (const item of items) {
      summary.attempted += 1;
      try {
        const order = await reader.readOrder(item.amazon_order_no);

        if (order.state === "not_found" || order.state === "cancelled") {
          if (order.state === "cancelled") summary.cancelled += 1;
          else summary.notFound += 1;
          await client.shipmentSync({
            task_id: item.task_id,
            order_state: order.state,
            tracking_url: order.trackingUrl ?? undefined,
            events: [],
          });
          log.warn(`${item.upstream_order_no} · 订单详情页显示 ${order.state}`);
          continue;
        }

        const url = order.trackingUrl ?? item.tracking_url ?? null;
        if (!url) {
          // 还没发货的单没有跟踪入口,这是正常状态,不是失败。
          await client.shipmentSync({
            task_id: item.task_id, order_state: "ok",
            status: "not_shipped", events: [],
          });
          log.dim(`${item.upstream_order_no} · 还没有跟踪信息`);
          summary.synced += 1;
          continue;
        }

        const t = await reader.readTracking(url);

        if (t.unavailable) {
          // 不当成一次有内容的同步。记成「还没有轨迹」并说明原因 ——
          // 下一轮重来就是了,而运营看日志能分清这不是我们坏了。
          await client.shipmentSync({
            task_id: item.task_id, order_state: "ok",
            status: "not_shipped", tracking_url: url,
            tracking_unavailable: true, events: [],
          });
          log.warn(`${item.upstream_order_no} · Amazon 暂时给不出轨迹,下一轮再试`);
          summary.unavailable += 1;
          continue;
        }

        const res = await client.shipmentSync({
          task_id: item.task_id,
          order_state: "ok",
          carrier: t.carrier ?? undefined,
          tracking_no: t.trackingNo ?? undefined,
          tracking_url: url,
          status: t.status ?? undefined,
          events: t.events,
        });
        if (!res.ok) {
          summary.failed += 1;
          log.err(`${item.upstream_order_no} · 回传失败:` +
                  (res.kind === "business" ? res.code : res.message));
          continue;
        }
        summary.synced += 1;
        log.ok(`${item.upstream_order_no} · ${t.carrier ?? "承运商未知"} ` +
               `${t.trackingNo ?? "-"} · ${t.status ?? "状态未知"} · ${t.events.length} 条轨迹`);
      } catch (e) {
        // 单条失败不该拖垮整批。厂商那边 postalCodeInfo 为 null 时抛的 TypeError
        // 会一路冒泡到 handleOrderSync 的 catch,**整批同步就此中止**,
        // 后面的订单全部不再处理(报告 §4.3)。
        summary.failed += 1;
        log.err(`${item.upstream_order_no} · ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    await reader.dispose();
  }

  return summary;
}
