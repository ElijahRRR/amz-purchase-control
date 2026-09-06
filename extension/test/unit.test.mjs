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
  const held = await loop.tickOnce();
  eq("收尾之后不许再认领(两条 runTask 会动同一个购物车)", held.kind, "zombie");
  check("说得出是从什么时候开始等的", typeof held.since === "number" && held.since > 0);

  releaseHang();
  await new Promise((r) => setTimeout(r, 20));   // 让那条 runTask 走完
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
  const BUSY_PHASES = new Set(["claimed", "running", "confirm", "verify"]);

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
    clearCart: async () => { await sleep(80); },        // 前面几步故意慢一点
    addProduct: async () => ({ shipperIsAmazon: null }),
    verifyCart: async () => true,
    proceedToCheckout: async () => {},
    fillAddress: async () => {},
    readCheckout: async () => ({ actualTotal: "1.00", deliveryTexts: [], isFba: true,
                                 unitPrices: [] }),
    placeOrder: async (hooks) => { seen = hooks ?? {}; elapsedAtOrder = Date.now() - t0; },
    readOrderCard: async () => ({ amazonOrderNo: "1", observedAsins: [] }),
    dispose: async () => {},
  };
  const out = await runTask(fakeTask(1), { client, driver, log: silentLog });
  eq("这一单正常跑完", out.kind, "purchased");
  check("交给驱动的是一个绝对时刻,不是「还剩几分钟」",
        typeof seen.claimDeadlineMs === "number" && seen.claimTimeoutMin === undefined,
        JSON.stringify(Object.keys(seen)));
  check("前面几步确实花掉了时间", elapsedAtOrder >= 80, `只用了 ${elapsedAtOrder}ms`);
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
  const first = await loop.tickOnce();
  const took = Date.now() - t0;
  eq("看门狗按钳过的硬顶触发", first.kind, "hard-cap");
  check("硬顶被钳进了服务端的认领窗口", took < 5_000, `等了 ${took}ms`);
  releaseHang();
  await new Promise((r) => setTimeout(r, 20));
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
  check("续租时如实报「这个标签页手里有没有活」",
        /busy: this\.flight\.busy \|\| BUSY_PHASES\.has\(this\.phase\)/.test(runnerSrc));

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

console.log(`\n  通过 ${pass} 条`);
if (failures.length) {
  console.log(`  失败 ${failures.length} 条:`);
  for (const f of failures) console.log("    ✗ " + f);
  process.exit(1);
}
console.log("  全部通过\n");
