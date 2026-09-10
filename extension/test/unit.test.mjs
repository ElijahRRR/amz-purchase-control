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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { waitFor, waitStable, WaitTimeout } from "../build/flow/dom/wait.js";
import { SingleFlight } from "../build/core/singleflight.js";
import { Serial } from "../build/core/serial.js";
import { decideLease, LEASE_DEFAULTS } from "../build/core/lease.js";
import { Loop } from "../build/background/loop.js";
import { runTask } from "../build/flow/run.js";
import { orderHardCapMs } from "../build/flow/amazon.js";
import { DriverError } from "../build/flow/driver.js";

const here = dirname(fileURLToPath(import.meta.url));

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
  eq("新租约的到期时刻", v.next.until, NOW + LEASE_DEFAULTS.ttlMs);
}
{
  const cur = { tabId: 1, until: NOW + 1000, busy: true };
  const v = decideLease(cur, ask({ tabId: 1, busy: true }));
  check("持有者续租", v.granted && v.reason === "renew");
  eq("续租把到期时刻往后推", v.next.until, NOW + LEASE_DEFAULTS.ttlMs);
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
  const cur = { tabId: 2, until: NOW - LEASE_DEFAULTS.busyGraceMs - 1, busy: true };
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
{
  // 两个预算是**入参**,不是写死在 lease.ts 里的常量 —— 传什么就按什么算。
  // 写死的话,真机上发现后台节流比预期更狠时要重新打包、全员升级插件。
  const rules = { ttlMs: 1000, busyGraceMs: 2000 };
  eq("TTL 由入参说了算", decideLease(null, ask({}), rules).next.until, NOW + 1000);
  const cur = { tabId: 2, until: NOW - 1, busy: true };
  check("宽限期之内不换手(按入参的宽限)",
        !decideLease(cur, ask({ tabId: 1 }), rules).granted);
  const old = { tabId: 2, until: NOW - 2001, busy: true };
  check("过了入参给的宽限期就换手",
        decideLease(old, ask({ tabId: 1 }), rules).granted);
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
  // **复刻服务端的持有语义**:`/release` 之后这条任务就不再归本实例持有,
  // 之后再写 `/events` 会被 TASK_NOT_HELD 拒掉(pytest 的
  // test_writing_the_step_after_release_is_too_late 证的就是这一条)。
  //
  // 不复刻的话,「先写事件流,再 /release」这条被文档、注释和 pytest docstring
  // 一起称作硬要求的顺序,在插件这一侧**没有任何测试盯着**:把两行调换,
  // typecheck / test:unit / test:dom / pytest 全绿,而运营台上那一单会变成
  // 「领走了又回来了,什么也没说」—— 正是这一轮反复要防的那件事。
  // (顺带钉住另一格:release 说不上话时结局是 unreported。)
  const releasedIds = new Set();
  return {
    fails,
    releasedIds,
    claim: async () => ({ ok: true, data: queue.shift() ?? null }),
    events: async (id) => (releasedIds.has(id)
      ? { ok: false, kind: "business", code: "TASK_NOT_HELD",
          message: "任务不由该实例持有" }
      : { ok: true, data: { recorded: 1 } }),
    guardCheck: async () => ({ ok: true, data: { allow: true, error_code: null,
                                                 detail: null, delivery_date: null,
                                                 delivery_raw_used: null } }),
    complete: async () => ({ ok: true, data: {} }),
    fail: async (_id, body) => { fails.push(body); return { ok: true, data: {} }; },
    release: async (id) => { releasedIds.add(id); return { ok: true, data: {} }; },
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
    // 这一单没配期望卡(guards.expected_card_last4 缺省)—— 一步都不做。
    ensurePaymentCard: async () => ({ last4: null, switched: false }),
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
  // 中间成功一单必须把连续计数清零。
  //
  // 修之前只在「failed 且 cartCleared === true」那一支清零,而成功的一单
  // (purchased)的终态里根本没有 cartCleared 这一位 —— 于是
  // 「失败、失败、成功、失败」也会熔断。熔断本身没坏,坏的是它报出来的原因:
  // 面板红条说「连着几单清不动购物车,多半是 Amazon 改了购物车页的结构」,
  // 而这台机器的购物车其实好好的(第 3 单刚刚清成功过),
  // 运营照着这句话去查一个并不存在的结构性故障。
  const client = fakeClient(10);
  let round = 0;
  const clearOk = [false, false, true, false, true];
  const driver = {
    name: "fake", ready: true,
    readLoginState: async () => "unknown",
    clearCart: async () => {
      if (!clearOk[round]) throw new DriverError("PLUGIN_INTERNAL", "找不到删除控件");
    },
    addProduct: async () => ({ shipperIsAmazon: null }),
    verifyCart: async () => true,
    proceedToCheckout: async () => {},
    fillAddress: async () => {},
    readCheckout: async () => ({ actualTotal: "1.00", deliveryTexts: [], isFba: true,
                                 unitPrices: [] }),
    // 这一单没配期望卡(guards.expected_card_last4 缺省)—— 一步都不做。
    ensurePaymentCard: async () => ({ last4: null, switched: false }),
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
  for (round = 0; round < 5; round += 1) kinds.push((await loop.tickOnce()).kind);
  eq("失败、失败、成功、失败 —— 不该熔断", kinds,
     ["ran", "ran", "ran", "ran", "ran"]);
  eq("成功的那一单确实是拍成了", client.fails.length, 3);
}

{
  // **开头那次清车成功、收尾那次失败** —— 这是熔断最该起作用的形状,
  // 而它曾经完全是死的:清零的时机在「这一单开头那次清车成功」上,
  // 每一单都从清车开始,于是连续计数在每一单开头就被清回 0,永远到不了 3。
  //
  // 真实成因不止一种:AmazonDriver.clearCart 对空车走 emptyMarkers 早退路径、
  // 根本不碰删除控件,于是 Amazon 改了删除控件的类名之后,「开头(车是空的)成功、
  // 收尾(车里有东西)失败」每一单都成立;更平常的是失败发生在加购之前
  // (OUT_OF_STOCK),开头清空车成功、收尾那次因购物车 iframe 抖动失败。
  const client = fakeClient(10);
  let inTask = 0;                 // 这一单里第几次调 clearCart
  const driver = {
    name: "fake", ready: true,
    readLoginState: async () => "unknown",
    clearCart: async () => {
      inTask += 1;
      if (inTask >= 2) throw new DriverError("PLUGIN_INTERNAL", "找不到删除控件");
    },
    addProduct: async () => { inTask = 1; throw new DriverError("OUT_OF_STOCK", "无货"); },
    verifyCart: async () => true,
    proceedToCheckout: async () => {},
    fillAddress: async () => {},
    readCheckout: async () => ({ actualTotal: "1.00", deliveryTexts: [], isFba: true,
                                 unitPrices: [] }),
    // 这一单没配期望卡(guards.expected_card_last4 缺省)—— 一步都不做。
    ensurePaymentCard: async () => ({ last4: null, switched: false }),
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
  for (let i = 0; i < 4; i += 1) { inTask = 0; kinds.push((await loop.tickOnce()).kind); }
  eq("开头清车成功、收尾清不动 —— 连着 3 单照样要熔断", kinds,
     ["ran", "ran", "ran", "cart-blocked"]);
  check("每一单都报了「试了没清动」",
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
    // 这一单没配期望卡(guards.expected_card_last4 缺省)—— 一步都不做。
    ensurePaymentCard: async () => ({ last4: null, switched: false }),
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
    // 这一单没配期望卡(guards.expected_card_last4 缺省)—— 一步都不做。
    ensurePaymentCard: async () => ({ last4: null, switched: false }),
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
  const held = await loop.tickOnce();
  eq("收尾之后不许再认领(两条 runTask 会动同一个购物车)", held.kind, "zombie");
  check("说得出是从什么时候开始等的", typeof held.since === "number" && held.since > 0);
  // 跨标签页那道闸(执行租约)靠的就是这一位。相位此刻是 stuck、单飞闸也已经
  // 放掉,只靠那两条的话这个标签页会报 busy=false,租约到期被另一个 amazon.com
  // 标签页接管走 —— 而这条僵尸 runTask 还活着,它的收尾清车会把新领那一单
  // 已经加好的商品删掉。
  check("僵尸没落地之前,这个 Loop 手里算「有活」", loop.holdsWork() === true);

  releaseHang();
  await new Promise((r) => setTimeout(r, 20));   // 让那条 runTask 走完
  check("僵尸落地之后手里就没活了", loop.holdsWork() === false);
  const after = await loop.tickOnce();
  check("被掐掉的那一单落地之后恢复认领", after.kind === "ran", after.kind);
}

{
  // 等那条僵尸也必须**有界**:dispose 解不开的挂起(等的不是 iframe,而是一个
  // 永不 settle 的 promise)会让它永远不落地。原先那一格从此每轮返回 busy、
  // 相位却是 idle —— 面板灰色「待命」、运营台「在线 · 可派」,这个买家号
  // 从此一单也不拍,而看门狗那句「已经落地,恢复认领」永远不会打出来。
  const client = fakeClient(10);
  const phases = [];
  const errs = [];
  let stuck = true;
  const driver = {
    name: "fake", ready: true,
    readLoginState: async () => "unknown",
    // 永不 settle,dispose 也解不开 —— 看门狗防的就是这种「我们没想到的事」。
    clearCart: () => (stuck ? new Promise(() => {}) : Promise.resolve()),
    addProduct: async () => ({ shipperIsAmazon: null }),
    verifyCart: async () => true,
    proceedToCheckout: async () => {},
    fillAddress: async () => {},
    readCheckout: async () => ({ actualTotal: "1.00", deliveryTexts: [], isFba: true,
                                 unitPrices: [] }),
    // 这一单没配期望卡(guards.expected_card_last4 缺省)—— 一步都不做。
    ensurePaymentCard: async () => ({ last4: null, switched: false }),
    placeOrder: async () => {},
    readOrderCard: async () => ({ amazonOrderNo: "1", observedAsins: [] }),
    dispose: async () => {},
  };
  const loop = new Loop({
    client,
    log: { ...silentLog, err: (m) => errs.push(m) },
    config: () => ({ mode: "simulate", taskHardCapMs: 40 }),
    driver: () => driver,
    onPhase: (p) => phases.push(p),
  });

  const kinds = [(await loop.tickOnce()).kind];
  kinds.push((await loop.tickOnce()).kind);
  check("等僵尸的那一格有自己的名字,不叫 busy", kinds[1] === "zombie", kinds.join(","));
  check("相位不落回「待命」", phases.includes("stuck") && !phases.includes("idle"),
        phases.join(","));

  await new Promise((r) => setTimeout(r, 60));    // 过了那一份 taskHardCapMs
  stuck = false;                                 // 页面自己好了
  const back = await loop.tickOnce();
  check("等超过一个硬顶就不再等它,恢复认领", back.kind === "ran", back.kind);
  check("而且说清楚了不等的后果",
        errs.some((m) => m.includes("不再等它") && m.includes("同一个购物车")),
        errs.join(" | "));
}

// ── 「读租约 → 裁决 → 写租约」必须整段串行(R2) ────────────────────────
//
// 纯函数 decideLease 验不到这一条,验的是它外面那层:SW 里那段读写夹着两次
// await(chrome.storage.session 是异步的),两条 amz.acquireRunner 前后脚进来
// 就会读到同一个旧值,**双双**被授予租约。
// 下面把 service-worker.ts 那一段按源码搬过来跑,只把 chrome.storage.session
// 换成一个同样异步的假存储。
{
  const mkStore = () => {
    let cell;
    return {
      get: async () => { await null; await null; return cell ?? null; },
      set: async (v) => { await null; cell = v; },
    };
  };
  const NOW2 = 2_000_000_000;
  const acquireOn = (store) => async (tabId, busy) => {
    const cur = await store.get();
    const v = decideLease(cur, { tabId, busy, now: NOW2, holderAlive: true });
    if (v.granted && v.next) { await store.set(v.next); return true; }
    return false;
  };

  // 不串行:两条并发的 acquire 双双 granted —— 这就是要堵的那个洞。
  {
    const raw = acquireOn(mkStore());
    const [a, b] = await Promise.all([raw(1, false), raw(2, false)]);
    check("(反面)不串行时两个标签页会同时拿到租约", a === true && b === true);
  }

  // 串行之后:先到的拿到,后到的读到的是**新写进去的**那一份,判 held。
  {
    const gate = new Serial();
    const raw = acquireOn(mkStore());
    const [a, b] = await Promise.all([gate.run(() => raw(1, false)),
                                      gate.run(() => raw(2, false))]);
    check("串行之后同一时刻只有一个标签页拿到租约", a !== b, `tab1=${a} tab2=${b}`);
  }

  // 队列里前一件抛错不许把后面的堵死(SW 里那段有 try/catch,但闸本身也得扛住)。
  {
    const gate = new Serial();
    let boom = null;
    const first = gate.run(async () => { throw new Error("boom"); }).catch((e) => { boom = e; });
    const second = await gate.run(async () => "ok");
    await first;
    check("前一件抛错原样抛回调用方", boom instanceof Error);
    eq("前一件抛错不堵住后面的", second, "ok");
  }

  // 顺序:排队不是并发,后到的必须等前一件真的跑完。
  {
    const gate = new Serial();
    const order = [];
    const p1 = gate.run(async () => { order.push("a1"); await new Promise((r) => setTimeout(r, 10)); order.push("a2"); });
    const p2 = gate.run(async () => { order.push("b1"); });
    await Promise.all([p1, p2]);
    eq("后到的排在前一件跑完之后", order, ["a1", "a2", "b1"]);
  }
}

// ── 长单期间租约必须一直续得上(R1) ────────────────────────────────────
//
// 这一段把 content/runner.ts 的 tick() / lease() 那十来行搬过来跑。Runner 本体
// 全是 chrome API,`npm run build:node` 不编译 src/content,在 Node 里驱动不了;
// 但**闸与裁决用的都是真的编译产物**(SingleFlight / decideLease),搬过来的只有
// 「先续租、再进闸」这个形状。下面「接线本身」那一节的源码正则钉住 runner.ts
// 里确实是这个形状 —— 两条合起来才算数,单独看哪一条都不够。
//
// 修之前:lease() 被关在 flight.run 的 job 里,而 job 在一单跑完之前不会再被
// 调用一次 → 整单期间租约一次都不续,TTL 一到另一个标签页接管,两条 runTask
// 动同一个购物车。而且它报的 busy 是**上一轮 tick 结束时**留下的相位,
// 长单期间恒为 false ——「持有者忙就不让位」那道闸在真实链路上是死的。
{
  const RULES = { ttlMs: 300_000, busyGraceMs: 600_000 };
  // **不在这里抄一份。** 抄一份的话两边迟早分叉,而分叉的方向恰好是
  // 「这里绿着、真链路上那个标签页报 busy=false」。runner.ts 不进 build/
  // (build:node 不编译 src/content),所以退一步从源码里把那一行读出来 ——
  // 比抄一份强:改了源码这里跟着变。
  const runnerSrcForPhases = readFileSync(join(here, "..", "src", "content", "runner.ts"), "utf8");
  const BUSY_PHASES = new Set(
    (/const BUSY_PHASES[^=]*=\s*new Set<Phase>\(\[([^\]]*)\]\)/.exec(runnerSrcForPhases)?.[1] ?? "")
      .split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean));
  check("从 runner.ts 里读到了 BUSY_PHASES", BUSY_PHASES.size >= 4, `读到 ${BUSY_PHASES.size} 个`);

  let now = 0;
  let stored = null;                    // SW 那边的 chrome.storage.session
  const acquire = (tabId, busy) => {
    const v = decideLease(stored, { tabId, busy, now, holderAlive: true }, RULES);
    if (v.granted && v.next) stored = v.next;
    return v.granted;
  };

  const mkTab = (tabId) => {
    const r = { tabId, phase: "off", flight: new SingleFlight(() => {}),
                renews: 0, busyReports: 0 };
    r.lease = async () => {
      const busy = r.flight.busy || BUSY_PHASES.has(r.phase);
      r.renews += 1;
      if (busy) r.busyReports += 1;
      return acquire(r.tabId, busy);
    };
    r.tick = async (job) => {                       // runner.tick() 的形状
      if (!(await r.lease())) return;
      await r.flight.run(job);
    };
    return r;
  };

  const A = mkTab(1), B = mkTab(2);
  let finish;
  const longTask = new Promise((res) => { finish = res; });
  let bRuns = 0;

  // A 领到一单,Amazon 转到发卡行验证页 —— 这一单要跑 6 分钟。
  const first = A.tick(async () => { A.phase = "running"; await longTask; A.phase = "done"; });
  await new Promise((r) => setTimeout(r, 0));
  A.phase = "verify";

  // 之后每 10 秒两个标签页各 tick 一次,一直到第 6 分钟。
  for (now = 10_000; now <= 6 * 60_000; now += 10_000) {
    await A.tick(async () => {});
    await B.tick(async () => { bRuns += 1; });
  }

  check("整单期间 A 一直在续租", A.renews > 30, `只续了 ${A.renews} 次`);
  check("续租时如实报了「手里有活」", A.busyReports > 30, `只报了 ${A.busyReports} 次`);
  eq("另一个标签页整段时间一次都没跑起来", bRuns, 0);
  eq("租约始终在 A 手里", stored.tabId, 1);
  check("租约里记着持有者在忙", stored.busy === true);

  finish();
  await first;
}

// ── 硬顶从**认领**那一刻起算(R3) ──────────────────────────────────────
//
// 服务端的 task_sweep 只看 claimed_at。原先 placeOrder 收到的是
// claim_timeout_min(一段时长),于是这本账从「点了下单那一刻」才开始记 ——
// 而清车(上界 350s)/ 加购 / checkoutNav(45s)/ 地址(60s)那几步同样在
// 服务端那本账上。默认配置下前面走掉五六分钟、placeOrder 再等满 10 分钟,
// 总计超过 15 分钟的认领超时:任务已经被扫成 manual/CLAIM_TIMEOUT,
// 这时才发 complete —— 钱花了、货发了,系统里是一条没有单号的待人工。
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let seen = null;
  let elapsedAtOrder = 0;
  const client = fakeClient(1);
  const t0 = Date.now();
  const driver = {
    name: "fake", ready: true,
    readLoginState: async () => "unknown",
    clearCart: async () => { await sleep(150); },       // 前面几步故意慢一点
    addProduct: async () => ({ shipperIsAmazon: null }),
    verifyCart: async () => true,
    proceedToCheckout: async () => {},
    fillAddress: async () => {},
    readCheckout: async () => ({ actualTotal: "1.00", deliveryTexts: [], isFba: true,
                                 unitPrices: [] }),
    // 这一单没配期望卡(guards.expected_card_last4 缺省)—— 一步都不做。
    ensurePaymentCard: async () => ({ last4: null, switched: false }),
    placeOrder: async (hooks) => { seen = hooks ?? {}; elapsedAtOrder = Date.now() - t0; },
    readOrderCard: async () => ({ amazonOrderNo: "1", observedAsins: [] }),
    dispose: async () => {},
  };
  const out = await runTask(fakeTask(1), { client, driver, log: silentLog });
  eq("这一单正常跑完", out.kind, "purchased");
  check("交给驱动的是一个绝对时刻,不是「还剩几分钟」",
        typeof seen.claimDeadlineMs === "number" && seen.claimTimeoutMin === undefined,
        JSON.stringify(Object.keys(seen)));
  // 阈值比 sleep 松一截:Node 的定时器允许提前一两毫秒回来,
  // 卡在等号上的话这一条会偶发地红,而偶发红的测试没人会认真看。
  check("前面几步确实花掉了时间", elapsedAtOrder >= 100, `只用了 ${elapsedAtOrder}ms`);
  const drift = seen.claimDeadlineMs - (t0 + 15 * 60_000);
  check("那个时刻是「认领时刻 + claim_timeout_min」,不跟着前面几步往后挪",
        drift >= -50 && drift < 60, `偏了 ${drift}ms(挪了就说明账是从点下单起算的)`);
}

{
  // 看门狗的硬顶也要钳进服务端的认领窗口:默认 20 分钟比默认 15 分钟的认领超时
  // 还长,那样它触发时任务**必然**已经被扫成待人工,它那条「插件放弃这一单」
  // 的留痕会被 TASK_NOT_HELD 拒掉 —— 事件流里再没有地方说过是插件先放弃的。
  const client = fakeClient(10);
  // 服务端说这一单的认领超时只有 1 分钟。
  const claimed1min = client.claim;
  client.claim = async () => {
    const r = await claimed1min();
    if (r.data) r.data.claim_timeout_min = 1;
    return r;
  };
  let releaseHang;
  const hang = new Promise((r) => { releaseHang = r; });
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
    // 这一单没配期望卡(guards.expected_card_last4 缺省)—— 一步都不做。
    ensurePaymentCard: async () => ({ last4: null, switched: false }),
    placeOrder: async () => {},
    readOrderCard: async () => ({ amazonOrderNo: "1", observedAsins: [] }),
    dispose: async () => {},
  };
  const loop = new Loop({
    client, log: silentLog,
    // 认领窗口 1 分钟、余量 59.95 秒 → 看门狗只剩 50ms,
    // 插件自己那个 20 分钟被钳掉。不钳的话这一格要等 20 分钟才返回。
    config: () => ({ mode: "simulate", taskHardCapMs: 20 * 60_000,
                     timeouts: { orderServerMargin: 59_950 } }),
    driver: () => driver,
  });
  const t0 = Date.now();
  // **上界套在 tickOnce 自己身上。** 断言排在 await 后面的话,闸被改坏时
  // 这一格不会转红 —— 它会挂在这条 await 上直到 20 分钟的默认硬顶到期,
  // CI 上表现为整个 job 超时被杀,看的人第一反应是「机器慢」而不是
  // 「有一道闸被改坏了」。「任何等待都必须有界」这条对测试自己也成立。
  let first;
  try {
    first = await Promise.race([
      loop.tickOnce(),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error("tickOnce 超过 5s 未返回")), 5_000).unref?.()),
    ]);
  } catch (e) {
    first = { kind: `没返回:${e.message}` };
  }
  const took = Date.now() - t0;
  eq("看门狗按钳过的硬顶触发", first.kind, "hard-cap");
  check("硬顶被钳进了服务端的认领窗口", took < 5_000, `等了 ${took}ms`);
  releaseHang();
  await new Promise((r) => setTimeout(r, 20));
}

// ── 「清车没清动」两个生产者、一个键名(F2) ─────────────────────────────
//
// 服务端 /fail 那一路写的是 `warning=cart_not_cleared`,运营台实例页那一格
// (services/instance.LIST_SQL 的 cart_fail_24h)数的也是它。插件 tryClear 原先
// 发的是 `state=cart_not_cleared` —— 同一件事两个键名,于是走「护栏没说上话 /
// 人按了取消」这两条路清不动车的机器,在运营台上和插件熔断上**同时是隐形的**:
// 实例页那一格是 0,机器满格绿色「在线 · 可派」。
{
  const client = fakeClient(3);
  const events = [];
  client.events = async (_id, evs) => { events.push(...evs); return { ok: true, data: {} }; };
  // 护栏裁决没说上话 → tryClear → unreported
  client.guardCheck = async () => ({ ok: false, kind: "transport", message: "请求超时" });
  let calls = 0;
  const driver = {
    name: "fake", ready: true,
    readLoginState: async () => "unknown",
    // 开头那次成功(车是空的),收尾那次失败 —— 与真实形状一致
    clearCart: async () => {
      calls += 1;
      if (calls >= 2) throw new DriverError("PLUGIN_INTERNAL", "找不到删除控件");
    },
    addProduct: async () => ({ shipperIsAmazon: null }),
    verifyCart: async () => true,
    proceedToCheckout: async () => {},
    fillAddress: async () => {},
    readCheckout: async () => ({ actualTotal: "1.00", deliveryTexts: [], isFba: true,
                                 unitPrices: [] }),
    // 这一单没配期望卡(guards.expected_card_last4 缺省)—— 一步都不做。
    ensurePaymentCard: async () => ({ last4: null, switched: false }),
    placeOrder: async () => {},
    readOrderCard: async () => ({ amazonOrderNo: "1", observedAsins: [] }),
    dispose: async () => {},
  };
  const out = await runTask(fakeTask(1), { client, driver, log: silentLog });
  eq("护栏没说上话 → 不下单,这一单交给服务端超时清扫", out.kind, "unreported");
  eq("而且说得出车没清动(这一位是关于这台机器的事实)", out.cartCleared, false);
  const warn = events.find((e) => e.payload?.step === "清车失败");
  check("「清车没清动」用的是服务端那一路同一个键名 warning",
        warn?.payload?.warning === "cart_not_cleared",
        JSON.stringify(warn?.payload ?? null));
  check("state 那个键留给「此刻在哪一段」那套语义,不混用",
        warn?.payload?.state === undefined);
}

// ── 「上界由服务端反推」那条算式(F3) ──────────────────────────────────
//
// docs/01 §8.3 那句「插件永远给服务端留出余量」的本体就是这个纯函数,而它一条
// 测试都没有过:改成恒取插件自己的 orderHardCap(完全忽略 claimDeadlineMs),
// typecheck / DOM / unit / pytest 全绿。后果是 placeOrder 从「点下单」那一刻起
// 再等满 10 分钟,总时长越过 task_sweep 的清扫线 —— 钱花了、货发了,
// 系统里是一条没有单号的待人工。
{
  const OWN = 10 * 60_000;          // T.orderHardCap 默认值
  const MARGIN = 3 * 60_000;        // T.orderServerMargin 默认值
  const now = 1_000_000;
  eq("服务端没给上界(老服务端)→ 用插件自己的",
     orderHardCapMs(null, now), OWN);
  eq("认领窗口还很远 → 还是插件自己的更紧",
     orderHardCapMs(now + 60 * 60_000, now), OWN);
  eq("认领窗口快到了 → 钳到「窗口 − 余量」",
     orderHardCapMs(now + 5 * 60_000, now), 5 * 60_000 - MARGIN);
  eq("窗口已经过了 → 0(只探一次立刻超时,不是负数、也不是插件自己的上限)",
     orderHardCapMs(now - 1000, now), 0);
  check("反推出来的上界永远给服务端留着余量",
        orderHardCapMs(now + 5 * 60_000, now) < 5 * 60_000);
}

// ── 「越过下单点」那条留痕没落地就不许点下单(GR-01) ─────────────────────
//
// 那四道回队列的闸(人工重置 / 批量重置 / 自动重试选单 / 插件自己调的 /release)
// 没有一道自己看得出「越过下单点了」,全都在等服务端库里那一位;而那一位的
// 唯一来源就是这条 POST。原先它的返回值被直接丢掉:一次网络抖动,单在 Amazon 上
// 真下成了,库里那一位还是 false,四道闸一起退化成招牌。
{
  const client = fakeClient(1);
  let armAttempts = 0;
  let placed = 0;
  let released = 0;
  client.events = async (_id, evs) => {
    if (evs.some((e) => e.payload?.may_have_ordered === true)) {
      armAttempts += 1;
      return { ok: false, kind: "transport", message: "请求超时" };
    }
    return { ok: true, data: { recorded: evs.length } };
  };
  client.release = async () => { released += 1; return { ok: true, data: {} }; };
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
    // 这一单没配期望卡(guards.expected_card_last4 缺省)—— 一步都不做。
    ensurePaymentCard: async () => ({ last4: null, switched: false }),
    placeOrder: async () => { placed += 1; },
    readOrderCard: async () => ({ amazonOrderNo: "1", observedAsins: [] }),
    dispose: async () => {},
  };
  const out = await runTask(fakeTask(1), { client, driver, log: silentLog });
  eq("留痕没落地 → 一次都不许点下单按钮", placed, 0);
  check("没说上话时会重发一次(服务端那条 UPDATE 是幂等的)", armAttempts === 2,
        `试了 ${armAttempts} 次`);
  eq("这一刻还没花钱 —— 清车退回队列", out.kind, "released");
  eq("而且真的调了 /release", released, 1);
  eq("一条 /fail 都不该有(这一单没毛病)", client.fails.length, 0);
}

{
  // 反过来:留痕落地了就照常点。上面那一条不能靠「反正都不点」蒙对。
  const client = fakeClient(1);
  let placed = 0;
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
    // 这一单没配期望卡(guards.expected_card_last4 缺省)—— 一步都不做。
    ensurePaymentCard: async () => ({ last4: null, switched: false }),
    placeOrder: async () => { placed += 1; },
    readOrderCard: async () => ({ amazonOrderNo: "X1", observedAsins: [] }),
    dispose: async () => {},
  };
  const out = await runTask(fakeTask(1), { client, driver, log: silentLog });
  eq("留痕落地了就照常下单", placed, 1);
  eq("这一单拍成了", out.kind, "purchased");
}

// ── 下单前的人工确认(D2:所有者定稿 ③)─────────────────────────────────
//
// 三条要守住的事,一条都不能靠读代码相信:
//  1. **默认关的时候一步都不停** —— 连一条事件都不发。开关判错的方向必须是
//     「不停」,而不是「停下来等一个不存在的人」。
//  2. **取消与超时不许渲染成同一个结果**。两条路都是清车 + 退回队列(这一刻
//     还没花钱),分得开的地方只剩事件流里的文案与 payload.state ——
//     合成一条的话,一台没人守的机器会一直产出「有人按了取消」,
//     看的人以为有人在把关。
//  3. **上界不是插件自己拍的**,也不是界面提供的:它被钳进服务端的认领窗口
//     (窗口 − 余量),与 placeOrder 的硬顶同一把尺子。

/** 给一条 await 套上上界,超时就把它渲染成一个说得出话的结果。
 *
 *  **断言排在裸 await 后面的话,闸被改坏时这一格不会转红** —— 它会挂在那条 await 上
 *  直到那个坏掉的上界(可以是 10 分钟)到期,CI 上表现为整个 job 超时被杀,
 *  看的人第一反应是「机器慢」而不是「有一道闸被改坏了」。
 *  「任何等待都必须有界」这条对测试自己也成立(与上面看门狗那一格同一条)。 */
async function within(ms, p, what) {
  let t;
  try {
    return await Promise.race([p, new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what} 超过 ${ms}ms 未返回`)), ms);
    })]);
  } catch (e) {
    return { kind: `没返回:${e.message}` };
  } finally {
    clearTimeout(t);
  }
}

function confirmDriver(extra = {}) {
  return {
    name: "fake", ready: true,
    readLoginState: async () => "unknown",
    clearCart: async () => {},
    addProduct: async () => ({ shipperIsAmazon: null }),
    verifyCart: async () => true,
    proceedToCheckout: async () => {},
    fillAddress: async () => {},
    readCheckout: async () => ({
      actualTotal: "10.79", actualShipping: "0.00", actualTax: "0.80",
      deliveryTexts: ["Thursday, August 27"], isFba: true, unitPrices: [],
      giftCard: { applied: true, amount: "5.00" },
    }),
    ensurePaymentCard: async () => ({ last4: null, switched: false }),
    placeOrder: async () => {},
    readOrderCard: async () => ({ amazonOrderNo: "111-0000000-0000000", observedAsins: [] }),
    dispose: async () => {},
    ...extra,
  };
}

/** 带事件记录的客户端。护栏回一个**服务端算出来的货款**与采信的交期原文 ——
 *  预览屏上那两行说的必须是服务端真正比过/采信的那一份。 */
function confirmClient() {
  const c = fakeClient(1);
  // 两本账分开:`sent` 记「发出去过」,`events2` 只记**服务端收下了的**。
  // 合成一本的话,「先 release 再写事件流」这个回归照样能凑出
  // [awaiting_confirm, confirm_cancelled] —— 而那两条 step 一条都没落库。
  c.sent = [];
  c.events2 = [];
  const inner = c.events;
  c.events = async (id, evs) => {
    c.sent.push(...evs);
    const r = await inner(id, evs);
    if (r.ok) c.events2.push(...evs);
    return r;
  };
  c.guardCheck = async () => ({ ok: true, data: {
    allow: true, error_code: null, detail: null, delivery_date: "2026-08-27",
    delivery_raw_used: "Thursday, August 27", goods_total: "15.79" } });
  c.releases = 0;
  const innerRelease = c.release;
  // 计数归计数,**持有语义要留着**(release 之后 events 被 TASK_NOT_HELD 拒)。
  c.release = async (id) => { c.releases += 1; return innerRelease(id); };
  return c;
}

const stepsOf = (c) => c.events2.map((e) => String(e.payload?.step ?? ""));
const statesOf = (c) => c.events2.map((e) => e.payload?.state).filter(Boolean);

{
  // 1. 关着:一步不停,一条确认事件都不发,askConfirm 一次都不调。
  //    传了 askConfirm 却没开开关也一样 —— 开关的唯一来源是配置,
  //    不是「构造 Loop 时传没传回调」(面板改开关不重建 Loop)。
  for (const flag of [undefined, false]) {
    const client = confirmClient();
    let asked = 0;
    const phases = [];
    const out = await within(5_000, runTask(fakeTask(1), {
      client, driver: confirmDriver(), log: silentLog,
      confirmBeforeOrder: flag,
      askConfirm: async () => { asked += 1; return true; },
      onPhase: (p) => phases.push(p),
    }), `runTask(confirmBeforeOrder=${flag})`);
    eq(`confirmBeforeOrder=${flag} 时这一单照常拍成`, out.kind, "purchased");
    eq(`confirmBeforeOrder=${flag} 时一次都不问人`, asked, 0);
    check(`confirmBeforeOrder=${flag} 时一条确认事件都没发`,
          statesOf(client).length === 0, JSON.stringify(statesOf(client)));
    check(`confirmBeforeOrder=${flag} 时相位没进过 confirm`,
          !phases.includes("confirm"), JSON.stringify(phases));
  }
}

{
  // 2. 开着 + 人按「下单」:照常走完,而且事件流里留得下「是人点的头」。
  //    没有这一条的话,事后追「这一单是谁点的头」时,机器直接下的与
  //    某个人按过的长成一个样子。
  const client = confirmClient();
  const phases = [];
  const windows = [];
  let seen = null;
  const out = await within(5_000, runTask({ ...fakeTask(1), upstream_order_no: "PO-9527" }, {
    client, driver: confirmDriver(), log: silentLog,
    confirmBeforeOrder: true,
    confirmWaitMs: 5_000,
    askConfirm: async (_t, preview) => { seen = preview; return true; },
    onPhase: (p) => phases.push(p),
    onConfirmWindow: (ms) => windows.push(ms === null ? null : "deadline"),
  }), "runTask(按了下单)");
  eq("人按了下单 → 这一单拍成", out.kind, "purchased");
  check("事件流里说得出是人点的头",
        stepsOf(client).includes("人按了下单,继续") &&
        statesOf(client).includes("confirm_approved"),
        JSON.stringify(stepsOf(client)));
  eq("相位真的进过 confirm 又落回 running", phases, ["confirm", "running"]);
  eq("倒计时窗口开了又收(收不掉的话屏幕上会留一条假的秒表)",
     windows, ["deadline", null]);

  // 预览屏上那几项:少一样它就退化成一个写着「确定?」的按钮。
  eq("预览带上游单号(去上游系统对得上的那个号)", seen.upstreamOrderNo, "PO-9527");
  eq("预览带商品与数量", seen.products, [{ asin: "B0FB3VS68J", quantity: 1 }]);
  eq("预览带的是服务端真正比过的货款,不是结算页实付", seen.goodsTotal, "15.79");
  eq("实付也带着(礼品卡全额抵扣时两者差得很远)", seen.actualTotal, "10.79");
  eq("预览带限价", seen.priceCap, "20.00");
  eq("预览带礼品卡抵扣", seen.giftCard, { applied: true, amount: "5.00" });
  eq("预览带的是服务端采信的那条交期原文", seen.deliveryRaw, "Thursday, August 27");
  check("预览带一个绝对到期时刻(面板不自己另算一个)",
        typeof seen.deadlineMs === "number" && seen.deadlineMs > Date.now() - 1000);
  eq("默认这个上界是配置里那个数钳的", seen.cappedBy, "confirm_wait");
}

{
  // 3. 开着 + 人按「取消」:清车 + 退回队列,**一条 /fail 都不该有**
  //    (这一单没毛病,人只是不想现在买它)。
  const client = confirmClient();
  const out = await within(5_000, runTask(fakeTask(1), {
    client, driver: confirmDriver({ placeOrder: async () => { throw new Error("不该点"); } }),
    log: silentLog, confirmBeforeOrder: true, confirmWaitMs: 5_000,
    askConfirm: async () => false,
  }), "runTask(按了取消)");
  eq("人按了取消 → 退回队列", out.kind, "released");
  eq("而且真的调了 /release", client.releases, 1);
  eq("一条 /fail 都不该有", client.fails.length, 0);
  check("事件流里那条文案说的是「人按了取消」",
        stepsOf(client).includes("人按了取消,退回队列"), JSON.stringify(stepsOf(client)));
  eq("state 与超时那一条分开", statesOf(client), ["awaiting_confirm", "confirm_cancelled"]);
  // **顺序断言。** fakeClient 复刻了服务端的持有语义:release 之后 events 回
  // TASK_NOT_HELD,被拒的那条不进 events2。所以「两行调换」这个回归在这里
  // 是红的 —— 发是发出去了(sent 里有),但一条都没落库。
  check("**先写事件流再 release**:那条 step 真的落库了,不是发出去被拒掉",
        statesOf(client).includes("confirm_cancelled"),
        `发出去的:${JSON.stringify(client.sent.map((e) => e.payload?.state))},` +
        `落库的:${JSON.stringify(statesOf(client))}`);
}

{
  // 4. 开着 + 没人来按:到点**视同超时**,不是取消。
  //    「他看了一眼觉得不对」和「他去吃饭了」处置完全不同 ——
  //    后者说明没人在看这台机器,而它长得像前者的话,运营会以为有人在把关。
  const client = confirmClient();
  const t0 = Date.now();
  // 上界套在 runTask 自己身上:那道闸被改坏时(比如上界取成了配置里那个数),
  // 这一格必须**转红**,不是挂在这里等 3 分钟。
  const out = await within(3_000, runTask(fakeTask(1), {
    client, driver: confirmDriver({ placeOrder: async () => { throw new Error("不该点"); } }),
    log: silentLog, confirmBeforeOrder: true, confirmWaitMs: 120,
    askConfirm: () => new Promise(() => {}),      // 界面永不应答
  }), "runTask(没人来按)");
  const took = Date.now() - t0;
  eq("没人按 → 到点退回队列", out.kind, "released");
  check("界面不应答时那道闸照样到点(上界不是界面提供的)", took < 3_000, `等了 ${took}ms`);
  const step = stepsOf(client).find((t) => t.startsWith("等人确认超时"));
  check("事件流里那条文案说的是「等人确认超时 N 秒」", !!step, JSON.stringify(stepsOf(client)));
  check("而且不是「人按了取消」那一条",
        !stepsOf(client).includes("人按了取消,退回队列"));
  eq("state 与取消那一条分开", statesOf(client), ["awaiting_confirm", "confirm_timeout"]);
  eq("一条 /fail 都不该有(这一刻还没花钱)", client.fails.length, 0);
  check("超时这一条同样是**先写事件流再 release**(落库了,不是被 TASK_NOT_HELD 拒掉)",
        statesOf(client).includes("confirm_timeout"),
        `发出去的:${JSON.stringify(client.sent.map((e) => e.payload?.state))},` +
        `落库的:${JSON.stringify(statesOf(client))}`);
}

{
  // 5. 上界钳进认领窗口。confirmWait 配成 10 分钟、而服务端的认领窗口只剩不到
  //    1 秒:实际等的是窗口那一边,而且事件流要说得出**是谁钳的** ——
  //    「配的就这么短」和「认领窗口快到了」处置完全不同(前者调插件,后者调服务端)。
  const client = confirmClient();
  const t0 = Date.now();
  // 同上:不钳的话这一格要等满 10 分钟才返回,而它该做的是转红。
  const out = await within(3_000, runTask({ ...fakeTask(1), claim_timeout_min: 1 }, {
    client, driver: confirmDriver({ placeOrder: async () => { throw new Error("不该点"); } }),
    log: silentLog, confirmBeforeOrder: true,
    confirmWaitMs: 10 * 60_000,
    orderServerMarginMs: 60_000 - 600,        // 认领窗口 1 分钟 → 只剩 ~600ms
    // 下单那块地板在这一格要给小的:给默认的 1 分钟的话,余地扣完就是 0,
    // 走的会是下面那条「窗口根本开不了」,而这一格要验的是**钳过之后照样开**。
    minOrderRoomMs: 100,
    askConfirm: () => new Promise(() => {}),
  }), "runTask(上界钳进认领窗口)");
  const took = Date.now() - t0;
  eq("窗口快到了 → 照样到点退回队列", out.kind, "released");
  check("等的是钳过的那个上界,不是配置里那 10 分钟", took < 5_000, `等了 ${took}ms`);
  const arm = client.events2.find((e) => e.payload?.state === "awaiting_confirm");
  eq("事件流说得出是认领窗口钳的", arm?.payload?.capped_by, "claim_window");
  check("钳过的等待远小于配置里那个数",
        !!arm && arm.payload.wait_ms < 10 * 60_000 && arm.payload.wait_ms <= 500,
        `wait_ms=${arm?.payload?.wait_ms}`);
}

{
  // 6. **确认窗口算进单笔硬顶,不豁免。** 这是一个被明确选中的立场,
  //    所以它要有断言:看门狗在确认窗口里照掐 —— 豁免它等于给
  //    「我们没想到的那件事」开一个不设防的口子,而看门狗存在的全部理由就是那件事。
  const client = fakeClient(1);
  client.guardCheck = async () => ({ ok: true, data: {
    allow: true, error_code: null, detail: null, delivery_date: null,
    delivery_raw_used: null, goods_total: "1.00" } });
  const loop = new Loop({
    client, log: silentLog,
    config: () => ({ mode: "simulate", taskHardCapMs: 150,
                     confirmBeforeOrder: true, timeouts: { confirmWait: 800 } }),
    driver: () => confirmDriver({ placeOrder: async () => { throw new Error("不该点"); } }),
    askConfirm: () => new Promise(() => {}),
  });
  let got;
  try {
    got = await Promise.race([
      loop.tickOnce(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("tickOnce 超过 5s 未返回")), 5_000)),
    ]);
  } catch (e) {
    got = { kind: `没返回:${e.message}` };
  }
  eq("确认窗口不豁免看门狗:硬顶到点照样掐单", got.kind, "hard-cap");
}

{
  // 7. 开关从**这一轮的配置**读,不是构造 Loop 时捕获的那一位。
  //    面板上改这个开关不重建 Loop(runner.setConfig 只在服务端地址/身份变了
  //    才重建)—— 读捕获值的话,人在面板上关掉它,机器照旧每一单都停下来等,
  //    而开关看起来已经关了。
  const client = fakeClient(2);
  client.guardCheck = async () => ({ ok: true, data: {
    allow: true, error_code: null, detail: null, delivery_date: null,
    delivery_raw_used: null, goods_total: "1.00" } });
  let on = true;
  let asked = 0;
  const loop = new Loop({
    client, log: silentLog,
    config: () => ({ mode: "simulate", confirmBeforeOrder: on,
                     timeouts: { confirmWait: 5_000 } }),
    driver: () => confirmDriver(),
    askConfirm: async () => { asked += 1; return true; },
  });
  await loop.tickOnce();
  eq("开着的那一轮问了人", asked, 1);
  on = false;                       // 面板上关掉它:不重建 Loop
  await loop.tickOnce();
  eq("关掉之后当轮就不再问人(不用重建 Loop)", asked, 1);
}

{
  // 8. **看门狗在确认窗口还开着的时候开火。** 上一格(6)只验到「掐得动」,
  //    这一格验的是掐完之后那条僵尸 runTask 还能干什么 —— 它此刻停在
  //    `await gate.race` 上,而 Loop 已经写下「插件放弃这一单」、相位落到 stuck、
  //    dispose 掉驱动、放开 busy 闸去领下一单了。
  //
  //    面板上那张「下单前确认 · 会花真钱」的卡片必须跟着一起收掉(onConfirmWindow
  //    收到 null),而且此刻人按下的那一下**一律不作数**:
  //      · 拿去下单的话 → 一张一分钱没花的单越过下单点,置位 may_have_ordered,
  //        然后在已 dispose 的驱动上抛错 → ORDER_CONFIRM_TIMEOUT → 待人工
  //        「可能已下单,去买家号里看一眼」。事件流里「插件放弃这一单」后面
  //        跟着一条「点击下单按钮」。
  //      · 写成「人按了取消」的话 → 把「看门狗掐单」渲染成「有人在把关」,
  //        正是这一轮反复要避免的那种合并。
  const client = fakeClient(1);
  client.guardCheck = async () => ({ ok: true, data: {
    allow: true, error_code: null, detail: null, delivery_date: null,
    delivery_raw_used: null, goods_total: "1.00" } });
  const sent = [];
  const inner = client.events;
  client.events = async (id, evs) => { sent.push(...evs); return inner(id, evs); };
  let placed = 0;
  let pending = null;
  const windows = [];
  const loop = new Loop({
    client, log: silentLog,
    // 硬顶 200ms、确认窗口 3 秒:看门狗必然先开火。这个配法不是杜撰的 ——
    // taskHardCapMs 是现场可调的,老服务端不下发 claim_timeout_min 时同理。
    config: () => ({ mode: "simulate", taskHardCapMs: 200,
                     confirmBeforeOrder: true, timeouts: { confirmWait: 3_000 } }),
    driver: () => confirmDriver({ placeOrder: async () => { placed += 1; } }),
    askConfirm: (_t, preview) => new Promise((resolve) => { pending = { preview, resolve }; }),
    onConfirmWindow: (ms) => windows.push(ms),
  });
  const got = await within(5_000, loop.tickOnce(), "tickOnce(确认窗口里被掐)");
  eq("确认窗口里照样掐得动", got.kind, "hard-cap");
  check("掐单时把面板上那张确认卡片一起收掉(收不掉的话两个按钮还能按)",
        windows[windows.length - 1] === null, JSON.stringify(windows));
  // 面板那头收到 null 会 resolve(false) —— 模拟操作员在这之后按下「下单」也一样,
  // 两条路都必须什么都不发生。
  check("确认弹窗那头确实被叫醒了(否则它会一直挂到确认窗口自己到点)",
        pending !== null);
  pending.resolve(true);
  await new Promise((r) => setTimeout(r, 300));
  eq("被放弃之后按下「下单」不作数:一次都不许点下单按钮", placed, 0);
  const states = sent.map((e) => e.payload?.state).filter(Boolean);
  check("也不许写「人按了取消」(那是把看门狗掐单渲染成有人在把关)",
        !states.includes("confirm_cancelled"), JSON.stringify(states));
  check("更不许写「人按了下单」", !states.includes("confirm_approved"),
        JSON.stringify(states));
  check("越过下单点的那条留痕一条都不该有(这一单一分钱没花)",
        !sent.some((e) => e.payload?.may_have_ordered === true),
        JSON.stringify(sent.map((e) => e.payload?.step)));
  eq("一条 /fail 都不该有(结局由认领超时清扫说了算)", client.fails.length, 0);
}

{
  // 9. **开关开着,但这个运行环境没有应答界面。** 闸的条件是「开关开着」且
  //    「传了 askConfirm」,缺后者时它静默失效:一步不停、一条事件都不发,
  //    而开关在面板上看起来是开的。开关这一位存在 chrome.storage 里、跨版本
  //    活着;Loop 的构造参数不是。所以这一格要的不是「别下单」(那会让一台
  //    没界面的机器彻底停摆),而是**这件事必须喊出来**。
  const client = confirmClient();
  const errs = [];
  const out = await within(5_000, runTask(fakeTask(1), {
    client, driver: confirmDriver(),
    log: { ...silentLog, err: (m) => errs.push(String(m)) },
    confirmBeforeOrder: true,
    // askConfirm 故意不传
  }), "runTask(开关开着但没有应答界面)");
  eq("没有应答界面时这一单照常拍成(不是停摆)", out.kind, "purchased");
  check("一条确认事件都不该发(它根本没停下来等过人)",
        statesOf(client).length === 0, JSON.stringify(statesOf(client)));
  check("但这件事必须在日志里喊出来 —— 静默失效的闸比没有闸更危险",
        errs.some((m) => m.includes("下单前确认") && m.includes("没有能应答的界面")),
        JSON.stringify(errs));
}

{
  // 10. **等人这一格不许把认领窗口吃光。** 扣掉「下单那一步至少要留」的地板之后
  //     一点余地都不剩时,窗口**根本不开**:一个人都不问,清车退回队列。
  //
  //     硬着头皮开窗口的后果是实打实的:placeOrder 先点按钮、再算硬顶,
  //     人在窗口末尾按下的那一下会拿到一个 ~0 的硬顶 → 第一轮轮询就到期 →
  //     ORDER_CONFIRM_TIMEOUT → 置位 may_have_ordered → 待人工「可能已下单」。
  //     一张原本还能安全退回队列的单,就这么换成了一张可能真花了钱的单。
  //
  //     **不写 awaiting_confirm**:窗口没开过,没有任何人被问过 ——
  //     写了的话事件流里会出现一个没人见过的确认屏。
  const client = confirmClient();
  let asked = 0;
  const phases = [];
  const windows = [];
  const out = await within(5_000, runTask({ ...fakeTask(1), claim_timeout_min: 1 }, {
    client, driver: confirmDriver({ placeOrder: async () => { throw new Error("不该点"); } }),
    log: silentLog, confirmBeforeOrder: true, confirmWaitMs: 5_000,
    orderServerMarginMs: 60_000 - 500,        // 认领窗口里只剩 ~500ms
    minOrderRoomMs: 2_000,                    // 而下单那一步至少要留 2 秒
    askConfirm: async () => { asked += 1; return true; },
    onPhase: (p) => phases.push(p),
    onConfirmWindow: (ms) => windows.push(ms),
  }), "runTask(认领窗口不够停下来等人)");
  eq("余地不够 → 退回队列(一分钱没花,单子还在)", out.kind, "released");
  eq("而且真的调了 /release", client.releases, 1);
  eq("一个人都没被问过", asked, 0);
  eq("窗口没开过,所以不写 awaiting_confirm", statesOf(client), ["confirm_no_room"]);
  check("相位没进过 confirm", !phases.includes("confirm"), JSON.stringify(phases));
  eq("面板上一条倒计时都不该出现", windows, []);
  eq("一条 /fail 都不该有(这一刻还没花钱)", client.fails.length, 0);
  check("下单按钮一次都没点",
        !stepsOf(client).includes("点击下单按钮"), JSON.stringify(stepsOf(client)));
  const noRoom = client.events2.find((e) => e.payload?.state === "confirm_no_room");
  check("事件流里说得出差多少(只剩多少 / 至少要留多少)",
        typeof noRoom?.payload?.order_room_ms === "number" &&
        noRoom.payload.min_order_room_ms === 2_000, JSON.stringify(noRoom?.payload));
  check("这一条不带 waited_ms —— 没有人等过", noRoom?.payload?.waited_ms === undefined);
}

{
  // 11. **人按下之后再看一眼表。** 地板保证的是「窗口到点那一刻还剩 minOrderRoom」,
  //     不是「人按下那一刻一定还剩」:上面那条 /events 的来回走在窗口里面。
  //     这里把那条来回做慢(3 秒,窗口只有 2 秒),人按下时余地已经掉到地板以下 ——
  //     那一下**批准了也不能点**:点下去是一张 may_have_ordered=true 的待人工单,
  //     而现在退回队列一分钱没花。那个人没白按:waited_ms 与那句 step 留着。
  const client = confirmClient();
  const inner = client.events;
  client.events = async (id, evs) => {
    if (evs.some((e) => e.payload?.state === "awaiting_confirm")) {
      await new Promise((r) => setTimeout(r, 3_000));
    }
    return inner(id, evs);
  };
  const out = await within(9_000, runTask({ ...fakeTask(1), claim_timeout_min: 1 }, {
    client, driver: confirmDriver({ placeOrder: async () => { throw new Error("不该点"); } }),
    log: silentLog, confirmBeforeOrder: true, confirmWaitMs: 5_000,
    orderServerMarginMs: 60_000 - 4_000,      // 认领窗口里还剩 ~4 秒
    minOrderRoomMs: 2_000,                    // 地板 2 秒 → 窗口 ~2 秒
    askConfirm: async () => true,             // 人立刻按了「下单」
  }), "runTask(按下时余地已经不够了)");
  eq("余地不够 → 退回队列,不是硬着头皮下单", out.kind, "released");
  eq("而且真的调了 /release", client.releases, 1);
  eq("窗口开过、人也被问过,但结局是余地不够",
     statesOf(client), ["awaiting_confirm", "confirm_no_room"]);
  check("不许写「人按了下单,继续」—— 那一下没能变成一次下单",
        !statesOf(client).includes("confirm_approved"), JSON.stringify(statesOf(client)));
  check("**下单按钮一次都没点**(点了就是一张「可能已下单」的待人工单)",
        !stepsOf(client).includes("点击下单按钮"), JSON.stringify(stepsOf(client)));
  eq("一条 /fail 都不该有", client.fails.length, 0);
  const noRoom = client.events2.find((e) => e.payload?.state === "confirm_no_room");
  check("这一条带 waited_ms —— 那个人确实等过、也确实按了",
        typeof noRoom?.payload?.waited_ms === "number", JSON.stringify(noRoom?.payload));
}

{
  // 12. **面板那条倒计时归零的那一刻,就是真正到期的那一刻。**
  //     deadlineMs 若在 awaiting_confirm 那条 /events **之前**算、而定时器在
  //     它之后才起跑,两把钟就差一整个 HTTP 来回(最坏 requestTimeoutMs):
  //     面板归零之后按钮还能按、按了照样下单,而屏幕上写着「到点退回队列」——
  //     「已经过期」和「还来得及」渲染成同一屏。
  //     这里把那条来回做慢 1 秒,量面板拿到的到期时刻与真正到期那一刻差多少。
  const client = confirmClient();
  const inner = client.events;
  client.events = async (id, evs) => {
    if (evs.some((e) => e.payload?.state === "awaiting_confirm")) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return inner(id, evs);
  };
  let panelDeadline = null;
  let closedAt = null;
  const out = await within(9_000, runTask(fakeTask(1), {
    client, driver: confirmDriver({ placeOrder: async () => { throw new Error("不该点"); } }),
    log: silentLog, confirmBeforeOrder: true, confirmWaitMs: 1_500,
    askConfirm: () => new Promise(() => {}),   // 界面永不应答
    // 收窗口那一下就在 race 落地的 finally 里,紧挨着真正到期那一刻。
    onConfirmWindow: (ms) => { if (ms === null) closedAt ??= Date.now(); else panelDeadline = ms; },
  }), "runTask(面板的钟与真正到期是同一把)");
  eq("没人按 → 到点退回队列", out.kind, "released");
  const skew = closedAt - panelDeadline;
  check("面板归零那一刻就是真正到期那一刻(偏差不该是一整个 /events 来回)",
        skew < 400,
        `面板到期 ${panelDeadline},真正到期 ${closedAt},差 ${skew}ms —— ` +
        `差出一个来回的话,归零之后那几秒里按钮还能按、按了照样下单`);
}

// ── 接线本身(只验得到源码这一层,说清楚) ──────────────────────────────
//
// content/runner.ts 与 background/service-worker.ts 里全是 chrome API,
// 在 Node 里驱动不了(`npm run build:node` 也不编译 src/content)。
// 上面那些断言验的是**闸本身**(SingleFlight / decideLease);这里退一步,
// 只钉住「闸有没有被接上」—— 这是源码层的检查,不是行为验证,别把它当成后者。
// (仓库里已有同型的先例:tests/test_task_event.py 用正则比对 codes.ts。)
{
  const runnerSrc = readFileSync(join(here, "..", "src", "content", "runner.ts"), "utf8");
  check("单飞闸接在 Runner 上:配置替换走 offer",
        /setConfig\([^)]*\)\s*:\s*void\s*\{[\s\S]{0,200}?this\.flight\.offer\(/.test(runnerSrc));
  check("认领与物流两条流都跑在同一道闸里",
        (runnerSrc.match(/this\.flight\.run\(/g) ?? []).length === 2);
  check("续租在闸**外面**(闸关着的整单期间也要续得上)",
        (runnerSrc.match(/if \(!\(await this\.lease\(\)\)\) return;/g) ?? []).length === 2 &&
        !/this\.flight\.run\(async \(\) => \{[\s\S]{0,160}?this\.lease\(/.test(runnerSrc));
  // 判据本体必须是 Loop 自己说的那一位,不是猜相位:看门狗掐单之后相位是 stuck、
  // 闸也已经放掉,只靠这两条的话这个标签页会报 busy=false,租约被抢走,
  // 而它手上那条僵尸 runTask 还活着(两条 runTask 动同一个购物车)。
  check("续租时如实报「这个标签页手里有没有活」(以 Loop.holdsWork() 为准)",
        /busy: this\.flight\.busy \|\| !!this\.loop\?\.holdsWork\(\) \|\| BUSY_PHASES\.has\(this\.phase\)/
          .test(runnerSrc));
  // 等人确认那几分钟里,这个标签页手里是有活的。相位不在这张表里的话,
  // 租约 TTL 一到就被另一个 amazon.com 标签页接管走,而这一边的人正对着
  // 预览屏 —— 他按下「下单」时,购物车已经归另一条 runTask 管了。
  // (闸本体是 Loop.holdsWork();这张表是兜底的那一层,它同样不该漏。)
  check("等人确认期间算「手里有活」(相位 confirm 在 BUSY_PHASES 里)",
        /const BUSY_PHASES[^=]*=[^;]*"confirm"/s.test(runnerSrc));
  check("面板那两个按钮只把人的那一下传过去,不自己做超时",
        /answerConfirm\(go: boolean\): void/.test(runnerSrc) &&
        !/setTimeout/.test(runnerSrc));

  const runSrc = readFileSync(join(here, "..", "src", "flow", "run.ts"), "utf8");
  // 行为那一格(12)量的是偏差;这一条钉的是**写法**:上界从 deadlineMs 倒推,
  // 不是再数一遍 waitMs。再数一遍的话,那条 /events 的来回会整个落在窗口外面。
  check("等人那道 race 的上界从 deadlineMs 倒推(与面板同一把钟)",
        /boundedWait\(deps\.askConfirm\(task, preview\),\s*\n?\s*Math\.max\(0, deadlineMs - Date\.now\(\)\)\)/
          .test(runSrc));

  const loopSrc = readFileSync(join(here, "..", "src", "background", "loop.ts"), "utf8");
  // 开关长在「构造 Loop 时传没传 askConfirm」上的话,面板改开关不重建 Loop,
  // 关掉之后机器照旧每一单都停下来等,而开关看起来已经关了。
  check("「下单前确认」这个开关从每一轮的配置读,不是构造时捕获的那一位",
        /confirmBeforeOrder: cfg\.confirmBeforeOrder === true/.test(loopSrc) &&
        !/confirmBeforeOrder: !!this\.deps\.askConfirm/.test(loopSrc));
  // 地板不接上去的话,run.ts 那边永远只看得到默认值 —— 现场把它调大调小都不生效,
  // 而它在同一张超时表里,长得跟别的可调项一模一样。
  check("下单那块地板也从同一张超时表接过去",
        /minOrderRoomMs: cfg\.timeouts\?\.minOrderRoom/.test(loopSrc));

  const panelSrc = readFileSync(join(here, "..", "src", "content", "panel.ts"), "utf8");
  // 面板上那个开关要与三档模式同一套存取方式:改配置 → SW 存 chrome.storage →
  // 广播回来。面板自己留一份副本的话,广播丢一次它就和真正生效的那一位对不上。
  check("面板上的开关走 amz.setConfig,不在面板里另存一份",
        /patch: \{ confirmBeforeOrder: !state\.config\?\.confirmBeforeOrder \}/.test(panelSrc));

  const swSrc = readFileSync(join(here, "..", "src", "background", "service-worker.ts"), "utf8");
  check("租约落 chrome.storage.session,不再活在模块级变量里",
        swSrc.includes("chrome.storage.session") &&
        !/^let leaseTabId/m.test(swSrc) && !/^let leaseUntil/m.test(swSrc));
  check("租约裁决走的是那个纯函数", swSrc.includes("decideLease("));
  check("「读租约 → 裁决 → 写租约」整段跑在串行闸里",
        /void leaseGate\.run\(async \(\) => \{\s*\n\s*const cur = await readLease\(\);/.test(swSrc));
  check("标签页关闭时释放租约也走同一道闸",
        (swSrc.match(/leaseGate\.run\(/g) ?? []).length === 2);
}

// ── 替买家号切支付卡:切完必须重读结算页(所有者定稿①)──────────────
//
// 这一节盯的是 run.ts 里最容易被"优化"掉的那一行:切卡之后**重新 readCheckout**。
// 切卡会让 Amazon 把结算页整个重渲染(这张卡要扣多少变了、礼品卡槽位跟着变、
// 有的卡带来不同的促销与税)。省掉重读的话,服务端拿到的是**切之前那张页面**
// 的数,而它放行之后我们照着**切之后那张页面**下单 —— 护栏比过的数和真正付出去
// 的钱不是同一笔,而事件流、库里、运营台上全都显示"已核过"。
{
  const guardBodies = [];
  const events = [];
  const client = fakeClient(1);
  client.guardCheck = async (_id, body) => {
    guardBodies.push(body);
    return { ok: true, data: { allow: true, error_code: null, detail: null,
                               delivery_date: null, delivery_raw_used: null } };
  };
  client.events = async (_id, evs) => {
    for (const e of evs) events.push(e.payload.step);
    return { ok: true, data: { recorded: evs.length } };
  };

  // 期望卡 4417,当前 9021 —— 与 SimulatedDriver 的 card_switch 场景同一组数。
  const task = fakeTask(1);
  task.guards.expected_card_last4 = "4417";

  let card = "9021";
  const seenExpected = [];
  const driver = {
    name: "fake", ready: true,
    readLoginState: async () => "unknown",
    clearCart: async () => {},
    addProduct: async () => ({ shipperIsAmazon: null }),
    verifyCart: async () => true,
    proceedToCheckout: async () => {},
    fillAddress: async () => {},
    // 切卡前后金额不同 —— 真实页面上就会这样(不同卡不同促销/税)。
    // 两个数不一样才验得出服务端拿到的是哪一份。
    readCheckout: async () => ({
      actualTotal: card === "4417" ? "12.34" : "1.00",
      deliveryTexts: [], isFba: true, unitPrices: [], paymentLast4: card,
    }),
    ensurePaymentCard: async (expected, hooks = {}) => {
      seenExpected.push(expected ?? null);
      const want = (expected ?? "").trim();
      if (!want || want === card) return { last4: card, switched: false };
      const from = card;
      await hooks.onSwitchStart?.({ from, to: want });
      card = want;
      await hooks.onSwitched?.({ from, to: want });
      return { last4: want, switched: true };
    },
    placeOrder: async () => {},
    readOrderCard: async () => ({ amazonOrderNo: "1", observedAsins: [] }),
    dispose: async () => {},
  };

  const out = await runTask(task, { client, driver, log: silentLog });
  eq("切卡这一单正常跑完", out.kind, "purchased");
  eq("期望卡尾号是从服务端下发的 guards 里取的,不是插件自己编的",
     seenExpected, ["4417"]);
  eq("报给护栏的是**切完之后**重读的那一份(不是切之前那张页面)",
     guardBodies.map((b) => [b.actual_total, b.payment_last4]), [["12.34", "4417"]]);
  check("切换过程在事件流里留了痕(切换支付卡 → 支付卡已切换 → 切卡后重读结算页)",
        events.includes("切换支付卡") && events.includes("支付卡已切换")
        && events.includes("切卡后重读结算页"),
        JSON.stringify(events));
}

// 期望为空(这个买家号不校验也不切,或者旧服务端没下发这一位):
// **一步都不做**,而且绝不多读一遍结算页 —— 多读一遍不只是浪费,
// 它会让「切了」和「没切」在事件流里长得一样,下次查起来分不开。
{
  const guardBodies = [];
  const events = [];
  const client = fakeClient(1);
  client.guardCheck = async (_id, body) => {
    guardBodies.push(body);
    return { ok: true, data: { allow: true, error_code: null, detail: null,
                               delivery_date: null, delivery_raw_used: null } };
  };
  client.events = async (_id, evs) => {
    for (const e of evs) events.push(e.payload.step);
    return { ok: true, data: { recorded: evs.length } };
  };

  let reads = 0;
  const driver = {
    name: "fake", ready: true,
    readLoginState: async () => "unknown",
    clearCart: async () => {},
    addProduct: async () => ({ shipperIsAmazon: null }),
    verifyCart: async () => true,
    proceedToCheckout: async () => {},
    fillAddress: async () => {},
    readCheckout: async () => {
      reads += 1;
      return { actualTotal: "1.00", deliveryTexts: [], isFba: true,
               unitPrices: [], paymentLast4: "9021" };
    },
    // 真驱动在这一档一步都不做,这里照抄那个语义:期望为空就原样回报。
    ensurePaymentCard: async (expected) => {
      check("期望为空时 run.ts 传下来的确实是空",
            expected === undefined || expected === null || expected === "",
            JSON.stringify(expected));
      return { last4: "9021", switched: false };
    },
    placeOrder: async () => {},
    readOrderCard: async () => ({ amazonOrderNo: "1", observedAsins: [] }),
    dispose: async () => {},
  };

  // fakeTask 的 guards 里没有 expected_card_last4 —— 就是"这个买家号不校验"。
  const out = await runTask(fakeTask(1), { client, driver, log: silentLog });
  eq("没配期望卡的单照常跑完", out.kind, "purchased");
  eq("没切卡就不重读结算页(只读了一遍)", reads, 1);
  eq("报给护栏的还是那一份原始读数",
     guardBodies.map((b) => b.payment_last4), ["9021"]);
  check("没切卡就不该有任何切卡事件", !events.some((e) => e.includes("支付卡")),
        JSON.stringify(events));
}


console.log(`\n  通过 ${pass} 条`);
if (failures.length) {
  console.log(`  失败 ${failures.length} 条:`);
  for (const f of failures) console.log("    ✗ " + f);
  process.exit(1);
}
console.log("  全部通过\n");
