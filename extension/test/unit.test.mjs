#!/usr/bin/env node
/** 不需要 DOM 的那几样:等待原语、单飞闸、执行租约的裁决规则。
 *
 * 跑的是**真实编译产物**(build/,由 npm run build:node 产出),不是复制一份逻辑
 * 过来重写 —— 复制一份的话,这里绿着而 dist/ 里那份坏了,谁也不会发现。
 *
 *   npm run test:unit   (npm run test:dom 也会把它带上)
 *
 * 为什么与 dom.test.mjs 分开:那一份要 Playwright 开浏览器,这一份纯 Node。
 * 把它们塞进一个文件的话,DOM 那边的夹具一坏,这边的断言也跟着不跑了。
 */

import { waitFor, waitStable, WaitTimeout } from "../build/flow/dom/wait.js";
import { SingleFlight } from "../build/core/singleflight.js";
import { decideLease, LEASE_TTL_MS, LEASE_BUSY_GRACE_MS } from "../build/core/lease.js";
import { Loop } from "../build/background/loop.js";
import { DriverError } from "../build/flow/driver.js";

let pass = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? "  → " + detail : ""}`);
}

function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(name, g === w, `期望 ${w},实际 ${g}`);
}

// ── 等待原语 ────────────────────────────────────────────────────────────

// 厂商 2.4.1 的 waitForPageNavigation 在这一场景下**永远不 settle**:
// 读 location 抛异常那一句排在超时判断之前,catch 里只重排下一轮。
// 我们的 tick() 把探针异常在内部吞成「这一轮没探到」,超时判断无条件执行。
{
  const t0 = Date.now();
  let calls = 0;
  let err = null;
  try {
    await waitFor("探针永远抛 SecurityError", () => {
      calls += 1;
      const e = new Error("Blocked a frame from accessing a cross-origin frame.");
      e.name = "SecurityError";
      throw e;
    }, { timeoutMs: 300, everyMs: 20 });
  } catch (e) {
    err = e;
  }
  const took = Date.now() - t0;
  check("探针每轮抛错时 waitFor 仍按时超时", err instanceof WaitTimeout,
        String(err && err.name));
  check("超时发生在预算附近而不是永远挂着", took >= 300 && took < 1500, `用了 ${took}ms`);
  check("探针确实被调用了多次", calls > 3, `调用 ${calls} 次`);
}

// G11:序列 A、A、<抛错>、A —— 中间那一轮读不到,连续性必须就此打断。
// 修之前:第 4 次探到 A 时 hits 从 2 直接加到 3,返回 "A" ——
// 三次「连续」跨过了一段读不到的空档。
{
  const script = ["A", "A", "THROW", "A"];
  let i = 0;
  let out = null;
  let err = null;
  try {
    out = await waitStable("跨过空档的 URL", () => {
      const v = script[i++];
      if (v === "THROW") {
        const e = new Error("cross-origin");
        e.name = "SecurityError";
        throw e;
      }
      return v ?? null;      // 脚本放完了就一直「探不到」
    }, 3, { timeoutMs: 200, everyMs: 10 });
  } catch (e) {
    err = e;
  }
  check("waitStable 不把跨过抛错空档的两段拼成「稳定」",
        out === null && err instanceof WaitTimeout, `返回 ${JSON.stringify(out)}`);
}

// 反面:真的连续三次相同,要正常返回。
{
  let i = 0;
  const out = await waitStable("连续三次相同", () => (i++ < 9 ? "X" : "X"),
                               3, { timeoutMs: 500, everyMs: 5 });
  eq("waitStable 连续命中时正常返回", out, "X");
}

// ── 单飞闸(OG-03) ─────────────────────────────────────────────────────

{
  const applied = [];
  const sf = new SingleFlight((cfg) => applied.push(cfg));
  let started = 0;
  let release;
  const gate = new Promise((r) => { release = r; });

  const first = sf.run(async () => { started += 1; await gate; });
  const second = await sf.run(async () => { started += 1; });
  check("有一轮在跑时第二轮直接被挡下", second === false);
  eq("被挡下的那一轮根本没开始跑", started, 1);

  // 在跑的时候来了新配置:先收着,不许当场换掉 client/Loop ——
  // 那正是「重建 Loop 把单飞闸清零」的入口。
  check("在跑时配置被推迟", sf.offer("cfg-1") === true);
  eq("推迟期间配置没有生效", applied, []);
  check("在跑时 busy 为真", sf.busy === true);

  release();
  eq("第一轮跑完了", await first, true);
  eq("跑完之后被推迟的配置立刻生效", applied, ["cfg-1"]);
  check("跑完之后闸放开", sf.busy === false);

  // 空闲时来的配置当场生效
  check("空闲时配置不被推迟", sf.offer("cfg-2") === false);
  eq("空闲时配置当场生效", applied, ["cfg-1", "cfg-2"]);
}

// 中途来了三次配置广播,该生效的是最后那一份
{
  const applied = [];
  const sf = new SingleFlight((cfg) => applied.push(cfg));
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = sf.run(async () => { await gate; });
  sf.offer("a"); sf.offer("b"); sf.offer("c");
  release();
  await run;
  eq("推迟期间只留最后一份配置", applied, ["c"]);
}

// 闸在 job 抛错之后也必须放开(否则一次异常就把这个标签页永远锁住)
{
  const sf = new SingleFlight(() => {});
  let thrown = null;
  try {
    await sf.run(async () => { throw new Error("boom"); });
  } catch (e) { thrown = e; }
  check("job 抛错会原样抛出来", thrown instanceof Error);
  check("job 抛错之后闸放开了", sf.busy === false);
}

// ── 执行租约(OG-04) ───────────────────────────────────────────────────

const NOW = 1_000_000_000;
const ask = (o) => ({ tabId: 1, busy: false, now: NOW, holderAlive: true, ...o });

{
  const v = decideLease(null, ask({}));
  check("没有租约时谁问谁拿到", v.granted && v.reason === "fresh");
  eq("新租约的到期时刻", v.next.until, NOW + LEASE_TTL_MS);
}
{
  const cur = { tabId: 1, until: NOW + 1000, busy: true };
  const v = decideLease(cur, ask({ tabId: 1, busy: true }));
  check("持有者续租", v.granted && v.reason === "renew");
  eq("续租把到期时刻往后推", v.next.until, NOW + LEASE_TTL_MS);
}
{
  const cur = { tabId: 2, until: NOW + 1000, busy: false };
  const v = decideLease(cur, ask({ tabId: 1 }));
  check("租约没过期时别的标签页拿不到", !v.granted && v.reason === "held");
  eq("拿不到就不动存储", v.next, null);
}
{
  // 这是 OG-04 的核心一格:持有者正跑着单,只是被后台节流拖过了 TTL。
  const cur = { tabId: 2, until: NOW - 1, busy: true };
  const v = decideLease(cur, ask({ tabId: 1, holderAlive: true }));
  check("过期但持有者在跑单:不换手", !v.granted && v.reason === "held-busy");
}
{
  // 持有者的标签页已经不在了(崩了、没触发 onRemoved):必须能换手,
  // 否则这个买家号从此一单也拍不了。
  const cur = { tabId: 2, until: NOW - 1, busy: true };
  const v = decideLease(cur, ask({ tabId: 1, holderAlive: false }));
  check("过期 + 持有者标签页已不在:换手", v.granted && v.reason === "holder-gone");
}
{
  // 标签页还在、却再也没来续租(内容脚本死了)。宽限期一过就换手 ——
  // 任何等待都必须有界,这一条也不例外。
  const cur = { tabId: 2, until: NOW - LEASE_BUSY_GRACE_MS - 1, busy: true };
  const v = decideLease(cur, ask({ tabId: 1, holderAlive: true }));
  check("busy 宽限期过完之后还是要换手", v.granted && v.reason === "taken-over");
}
{
  const cur = { tabId: 2, until: NOW - 1, busy: false };
  const v = decideLease(cur, ask({ tabId: 1 }));
  check("过期且持有者不忙:换手", v.granted && v.reason === "taken-over");
  eq("换手后记的是新持有者", v.next.tabId, 1);
}
{
  const v = decideLease(null, ask({ busy: true }));
  eq("要租约时报的 busy 会被记进租约", v.next.busy, true);
}

// ── 清车熔断与看门狗(OG-02 / G8) ──────────────────────────────────────
//
// Loop 与 runTask 刻意不碰任何 chrome API,所以这两条能在 Node 里**真的跑一遍**,
// 而不是靠读代码相信。

function fakeTask(id) {
  return {
    task_id: id, marketplace: "US",
    shipping: { name: "N", phone: "p", line1: "1 Main St", city: "Santa Ana",
                state: "CA", postcode: "92707", country: "US" },
    products: [{ asin: "B0FB3VS68J", quantity: 1 }],
    guards: { price_cap: "20.00", max_delivery_days: 30, require_fba: false },
    claim_timeout_min: 15,
  };
}

function fakeClient(n) {
  const queue = Array.from({ length: n }, (_, i) => fakeTask(i + 1));
  const fails = [];
  return {
    fails,
    claim: async () => ({ ok: true, data: queue.shift() ?? null }),
    events: async () => ({ ok: true, data: { recorded: 1 } }),
    guardCheck: async () => ({ ok: true, data: { allow: true, error_code: null,
                                                 detail: null, delivery_date: null,
                                                 delivery_raw_used: null } }),
    complete: async () => ({ ok: true, data: {} }),
    fail: async (_id, body) => { fails.push(body); return { ok: true, data: {} }; },
    release: async () => ({ ok: true, data: {} }),
  };
}

const silentLog = { info() {}, warn() {}, err() {}, ok() {}, dim() {} };

{
  // 清车一直失败:头 3 单照跑照报,第 4 轮就不该再认领了。
  // 不熔断的话,tickPollMs=10s 一个夜里能把队列里几百单全打进「拍单异常」桶。
  const client = fakeClient(10);
  const driver = {
    name: "fake", ready: true,
    readLoginState: async () => "unknown",
    clearCart: async () => { throw new DriverError("PLUGIN_INTERNAL", "找不到删除控件"); },
    addProduct: async () => ({ shipperIsAmazon: null }),
    verifyCart: async () => true,
    proceedToCheckout: async () => {},
    fillAddress: async () => {},
    readCheckout: async () => ({ actualTotal: "1.00", deliveryTexts: [], isFba: true,
                                 unitPrices: [] }),
    placeOrder: async () => {},
    readOrderCard: async () => ({ amazonOrderNo: "1", observedAsins: [] }),
    dispose: async () => {},
  };
  const loop = new Loop({
    client, log: silentLog,
    config: () => ({ mode: "simulate", taskHardCapMs: 60_000 }),
    driver: () => driver,
  });

  const kinds = [];
  for (let i = 0; i < 4; i += 1) kinds.push((await loop.tickOnce()).kind);
  eq("清车连着失败 3 单之后停止认领", kinds, ["ran", "ran", "ran", "cart-blocked"]);
  check("每一单都照样上报了失败", client.fails.length === 3);
  check("上报里说清了车没清干净",
        client.fails.every((f) => f.cart_cleared === false && f.cart_clear_attempted === true));
}

{
  // 越过下单点之后按规矩不清车 —— 那**不是**一次清车失败,不该把熔断计数推上去。
  // 混为一谈的话,三单「可能已下单」就能让一台购物车好好的机器停止认领。
  const client = fakeClient(10);
  const driver = {
    name: "fake", ready: true,
    readLoginState: async () => "unknown",
    clearCart: async () => {},
    addProduct: async () => ({ shipperIsAmazon: null }),
    verifyCart: async () => true,
    proceedToCheckout: async () => {},
    fillAddress: async () => {},
    readCheckout: async () => ({ actualTotal: "1.00", deliveryTexts: [], isFba: true,
                                 unitPrices: [] }),
    placeOrder: async () => {
      throw new DriverError("PAYMENT_VERIFICATION_TIMEOUT", "等了 360 秒仍未完成");
    },
    readOrderCard: async () => ({ amazonOrderNo: "1", observedAsins: [] }),
    dispose: async () => {},
  };
  const loop = new Loop({
    client, log: silentLog,
    config: () => ({ mode: "simulate", taskHardCapMs: 60_000 }),
    driver: () => driver,
  });
  const kinds = [];
  for (let i = 0; i < 4; i += 1) kinds.push((await loop.tickOnce()).kind);
  eq("「可能已下单」不算清车失败,不触发熔断", kinds, ["ran", "ran", "ran", "ran"]);
  check("这一路报的是「没试过清车」",
        client.fails.every((f) => f.cart_clear_attempted === false));
  check("而且一律转人工", client.fails.every((f) => f.to_manual === true));
}

{
  // 看门狗:一单卡住超过硬顶,tickOnce 必须**返回**(而不是跟着一起挂死),
  // 驱动被强制关掉,而且在那条 runTask 真的落地之前不许再认领。
  // busy 闸永不复位是我们这边与厂商同型的最后一个坑。
  const client = fakeClient(10);
  let releaseHang;
  const hang = new Promise((r) => { releaseHang = r; });
  let disposed = 0;
  const driver = {
    name: "fake", ready: true,
    readLoginState: async () => "unknown",
    clearCart: async () => { await hang; throw new DriverError("PLUGIN_INTERNAL", "收尾"); },
    addProduct: async () => ({ shipperIsAmazon: null }),
    verifyCart: async () => true,
    proceedToCheckout: async () => {},
    fillAddress: async () => {},
    readCheckout: async () => ({ actualTotal: "1.00", deliveryTexts: [], isFba: true,
                                 unitPrices: [] }),
    placeOrder: async () => {},
    readOrderCard: async () => ({ amazonOrderNo: "1", observedAsins: [] }),
    dispose: async () => { disposed += 1; },
  };
  const loop = new Loop({
    client, log: silentLog,
    config: () => ({ mode: "simulate", taskHardCapMs: 30 }),
    driver: () => driver,
  });

  const first = await loop.tickOnce();
  eq("跑过硬顶的那一单被强制收尾", first.kind, "hard-cap");
  check("驱动被 dispose 掉了", disposed >= 1, `dispose ${disposed} 次`);
  eq("收尾之后不许再认领(两条 runTask 会动同一个购物车)",
     (await loop.tickOnce()).kind, "busy");

  releaseHang();
  await new Promise((r) => setTimeout(r, 20));   // 让那条 runTask 走完
  const after = await loop.tickOnce();
  check("被掐掉的那一单落地之后恢复认领", after.kind === "ran", after.kind);
}

console.log(`\n  通过 ${pass} 条`);
if (failures.length) {
  console.log(`  失败 ${failures.length} 条:`);
  for (const f of failures) console.log("    ✗ " + f);
  process.exit(1);
}
console.log("  全部通过\n");
