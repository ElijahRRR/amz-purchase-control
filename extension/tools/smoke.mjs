#!/usr/bin/env node
/** 用插件**自己的**代码跑一遍闭环,不碰 Amazon。
 *
 * 与 tools/mock_plugin.py 的区别:那个是手写的 HTTP 序列,用来验服务端;
 * 这个跑的是 src/ 里将来真装进浏览器的那份 Loop 与 runTask,验的是插件。
 *
 *   node tools/smoke.mjs --env env-172 --scenario happy
 */

import { Client } from "../build/core/client.js";
import { Log } from "../build/core/log.js";
import { Loop } from "../build/background/loop.js";
import { SimulatedDriver, SimulatedShipmentReader } from "../build/flow/simulated.js";
import { syncShipments } from "../build/flow/shipment.js";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf("--" + k);
  return i >= 0 ? argv[i + 1] : d;
};

const base = arg("base", "http://127.0.0.1:8781");
const envCode = arg("env", "env-172");
const scenario = arg("scenario", "happy");
const uid = arg("uid", "ext-smoke-001");

const log = new Log();
log.onChange((lines) => {
  const l = lines[lines.length - 1];
  process.stdout.write(`  ${l.at}  ${l.level.padEnd(4)} ${l.text}\n`);
});

const client = new Client({ baseUrl: base, timeoutMs: 10000 }, uid);

console.log(`\n=== 插件自检 · 场景 ${scenario} · ${envCode} ===`);

const reg = await client.register(envCode, "smoke");
if (!reg.ok) {
  console.error("  注册失败:", reg.kind === "business" ? reg.code + " " + reg.message : reg.message);
  process.exit(1);
}
console.log(`  注册 instance_id=${reg.data.instance_id} env_status=${reg.data.env_status}`);

const hb = await client.heartbeat();
console.log("  心跳", hb.ok ? "ok" : "失败");

// 驱动每轮现取一个:一单一个实例,加购过的东西留在实例里,
// 回读购物车和造订单卡都从那里来,不需要外部再喂 ASIN。
const driver = new SimulatedDriver(scenario);

// 模拟驱动自己也得守规矩:它**一次页面都没读过**,能说的只有 unknown。
// 报 ok 的话,运营在面板上切一下模拟档就能把一台确实被登出的机器洗成绿色
// ——ok 是唯一能解封 signed_out 的信号(services/instance._KEEPS_OLD_LOGIN_STATE)。
{
  const said = await new SimulatedDriver(scenario).readLoginState();
  if (said !== "unknown") {
    console.error(`  模拟驱动报了 login_state=${said} —— 它没读过任何页面,只能报 unknown`);
    process.exit(2);
  }
}
// 登录态:真插件里是内容脚本读到 → 交给 service worker → 挂在下一次心跳上。
// 这里没有 SW,先收在手边,跑完补发一次心跳 —— 验的是同一条链。
let reportedLogin = null;
const loop = new Loop({
  client, log,
  config: () => ({ mode: "simulate" }),
  driver: () => driver,
  reportLogin: (state) => { reportedLogin = state; },
});

const r = await loop.tickOnce();

console.log("\n  结果:", JSON.stringify(r.kind === "ran" ? { kind: r.kind, task: r.task.task_id, outcome: r.outcome } : r));

// ── 替买家号切支付卡(所有者定稿①)──────────────────────────────────
//
// 这两个场景验的是一条**跨服务端与插件**的链:期望卡从 buyer_envs 随认领下发 →
// 插件切 → 切完重读结算页 → 护栏拿重读的那一份裁决。
//
// 跑之前要先给这个买家号配上期望卡,否则服务端下发的是 null、插件一步都不做,
// 而这一轮照样会「成功」—— 那种成功什么也没验到。所以这里先查那一位,
// 没配就直接判失败并说清该怎么配:**「没配」和「配了且切成了」不许长成同一个结果**。
if (scenario === "card_switch" || scenario === "card_switch_fail") {
  const fail = (msg) => { console.error("  ✗ " + msg); process.exit(2); };
  if (r.kind !== "ran") fail(`这一轮没跑起来(${r.kind}),切卡场景什么也没验到`);

  const want = r.task.guards?.expected_card_last4 ?? null;
  if (want !== "4417") {
    fail(`服务端下发的 expected_card_last4 是 ${JSON.stringify(want)},不是 "4417" —— ` +
         `这一轮插件一步都不会做,场景是空跑。先配上再来:\n` +
         `      psql <库> -c "UPDATE procure.buyer_envs SET expected_card_last4='4417' ` +
         `WHERE code='${envCode}'"`);
  }
  // 驱动确实收到了那一位,而且**真的动了手**(模拟档当前卡是 9021)。
  if (!driver.calls.includes("ensurePaymentCard:4417")) {
    fail(`插件没按下发的期望卡去切:calls=${JSON.stringify(driver.calls)}`);
  }

  if (scenario === "card_switch") {
    if (!driver.calls.includes("cardSwitched:9021->4417")) {
      fail(`没切成:calls=${JSON.stringify(driver.calls)}`);
    }
    // 切完必须重读结算页 —— 切卡会让页面重渲染,报给护栏的必须是重读的那一份。
    const reads = driver.calls.filter((c) => c === "readCheckout").length;
    if (reads !== 2) fail(`结算页读了 ${reads} 遍,切卡之后应当再读一遍(共 2 遍)`);
    if (r.outcome.kind !== "purchased") {
      fail(`切卡成功之后这一单该照常拍下来,实际 ${JSON.stringify(r.outcome)}`);
    }
    console.log(`  ✓ 切卡:9021 → 4417,切完重读结算页(readCheckout ×${reads}),照常拍单`);
  } else {
    // 切不动 → PAYMENT_METHOD_UNEXPECTED、**不转人工**(归 BUSINESS_BLOCKED:
    // 重试多少次结果都一样,而且这一步在下单之前,钱一分没花)、且清了车。
    const o = r.outcome;
    if (o.kind !== "failed") fail(`切不动的单该落成 failed,实际 ${JSON.stringify(o)}`);
    if (o.code !== "PAYMENT_METHOD_UNEXPECTED") fail(`错误码是 ${o.code}`);
    if (o.toManual !== false) fail("切不动的单不该转人工:这一步在下单之前,钱一分没花");
    if (o.cartCleared !== true) fail(`没清车(cartCleared=${o.cartCleared}) —— 残留会污染下一单`);
    // 而且**绝不能**已经点过下单:切卡在护栏之前,越过下单点是不可能的。
    if (driver.calls.includes("placeOrder")) fail("切卡失败却已经点过下单按钮");
    console.log("  ✓ 切不动:PAYMENT_METHOD_UNEXPECTED / 不转人工 / 已清车 / 没点下单");
  }
}

// 登录态失效那条路走完之后,还要验后半截:这一位真的会到服务端,
// 而服务端据此**拒绝**下一次认领 —— 拒得说得出名字,不是回一个"没有单"。
if (reportedLogin) {
  const hb2 = await client.heartbeat(reportedLogin);
  console.log(`  上报登录态 ${reportedLogin} → 服务端记下`,
              hb2.ok ? hb2.data.login_state : "(心跳失败)");
  const again = await loop.tickOnce();
  console.log("  插件自己这一轮:", JSON.stringify(again));
  const denied = await client.claim();
  console.log("  绕过插件直接认领:",
              denied.ok ? "放行(不对!)" : `${denied.kind === "business" ? denied.code : denied.kind} ${denied.message}`);
}

// 物流同步是独立一条流,跑在 purchased 之后。--ship 指定场景就顺带跑一轮。
const shipScenario = arg("ship", null);
if (shipScenario) {
  console.log(`\n  --- 物流同步 · 场景 ${shipScenario} ---`);
  const summary = await syncShipments(client, new SimulatedShipmentReader(shipScenario), log);
  console.log("  物流:", JSON.stringify(summary));
}

if (r.kind === "ran" && r.outcome.kind === "unreported") process.exit(2);
if (r.kind === "transport-error") process.exit(2);
process.exit(0);
