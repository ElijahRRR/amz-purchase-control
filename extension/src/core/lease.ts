/** 执行租约的裁决规则。**纯函数** —— 谁持有、什么时候能换手,只由入参决定。
 *
 * 为什么要从 service worker 里拎出来:那边的东西(chrome.storage.session、
 * chrome.tabs)在 Node 里跑不了,而这条规则恰恰是最需要被验的一段 ——
 * 判错了的后果是**两个标签页同时在一个买家号上拍单**:B 领到第二单,
 * 它的第一步 clearCart 把 A 已加购的东西删干净,A 随后报 CART_MISMATCH;
 * 或者两单的商品混在一张结算页上过护栏。
 *
 * 原先那套错在三处,合起来才是一个洞:
 *   1. 租约存在 SW 的模块级变量里 —— MV3 的 SW 空闲约 30 秒就被回收,
 *      任何一次唤醒都重跑顶层脚本,leaseTabId 归 null;而 `leaseTabId === null`
 *      这一支对**任何**标签页都成立,于是谁先问谁拿走。
 *   2. TTL 45 秒短于后台标签页的定时器节流周期(约 60 秒):正在跑单的那个
 *      标签页只要被切到后台,续租就赶不上,租约自然过期。
 *   3. 过期就换手,不问持有者在不在跑单。
 */

export interface Lease {
  tabId: number;
  /** 到期时刻(epoch 毫秒)。 */
  until: number;
  /** 持有者上一次续租时说的:我正在跑一单。 */
  busy: boolean;
}

export interface LeaseAsk {
  tabId: number;
  /** 来要租约的这个标签页此刻在不在跑单。 */
  busy: boolean;
  now: number;
  /** 持有者那个标签页还在不在(chrome.tabs.get 查得到就是 true)。
   *  查不了的时候传 true —— 「不知道」不该变成「可以抢」。 */
  holderAlive: boolean;
}

export interface LeaseVerdict {
  granted: boolean;
  /** 该写回存储的那一份。granted 为 false 时是 null(不动存储)。 */
  next: Lease | null;
  /** 为什么。**只用来写日志**,但要写得出人话 ——
   *  「另一个标签页在跑」和「租约还没到期」不是一回事。 */
  reason: "fresh" | "renew" | "taken-over" | "holder-gone" | "held" | "held-busy";
}

/** 租约有效期。比认领轮询(10 秒)宽得多,也比后台标签页的定时器节流周期
 *  (约 60 秒)宽一个量级 —— 短于它的话,一个被切到后台的标签页会在自己
 *  正跑着单的时候把租约丢掉。放大它不会造成「持有者已死却占着」:
 *  标签页被关掉时 onRemoved 立刻释放。 */
export const LEASE_TTL_MS = 300_000;

/** 持有者说自己在跑单、但**再也没来续租**时,还给它多少宽限。
 *
 *  为什么不能无限宽限:标签页没被关掉(onRemoved 不触发)、内容脚本却死了
 *  (页面导航到别的站、脚本抛错),租约会永远停在 busy 上,这个买家号从此
 *  一单也拍不了 —— 而「所有等待都必须有界」这条规矩在这里同样成立。
 *  比一单的硬顶(20 分钟)短是故意的:真跑着单的标签页每 10 秒续一次,
 *  连着 10 分钟一次都没续上,它已经不在跑了。 */
export const LEASE_BUSY_GRACE_MS = 600_000;

/** 输入:当前租约(没有就是 null)+ 谁在要 → 输出:给不给,以及该存回什么。 */
export function decideLease(cur: Lease | null, ask: LeaseAsk): LeaseVerdict {
  const grant = (reason: LeaseVerdict["reason"]): LeaseVerdict => ({
    granted: true,
    next: { tabId: ask.tabId, until: ask.now + LEASE_TTL_MS, busy: ask.busy },
    reason,
  });

  if (cur === null) return grant("fresh");
  if (cur.tabId === ask.tabId) return grant("renew");
  if (ask.now <= cur.until) return { granted: false, next: null, reason: "held" };

  // 过期了。持有者说它在跑单的话,**不换手** —— 后台节流会让续租迟到,
  // 而把租约从一个正在拍单的标签页手里抢走,代价是两单并行动同一个购物车。
  if (cur.busy && ask.holderAlive && ask.now <= cur.until + LEASE_BUSY_GRACE_MS) {
    return { granted: false, next: null, reason: "held-busy" };
  }
  return grant(cur.busy && !ask.holderAlive ? "holder-gone" : "taken-over");
}
