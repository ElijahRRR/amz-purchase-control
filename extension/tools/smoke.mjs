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
