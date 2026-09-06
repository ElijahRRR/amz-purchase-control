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

console.log(`\n  通过 ${pass} 条`);
if (failures.length) {
  console.log(`  失败 ${failures.length} 条:`);
  for (const f of failures) console.log("    ✗ " + f);
  process.exit(1);
}
console.log("  全部通过\n");
