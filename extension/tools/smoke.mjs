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
import { SimulatedDriver } from "../build/flow/simulated.js";

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

let asins = [];
const loop = new Loop({
  client,
  log,
  config: () => ({ mode: "simulate" }),
  driver: () => new SimulatedDriver(scenario, asins),
  onPhase: (p, t) => { if (t) asins = t.products.map((x) => x.asin); },
});

// 认领发生在 tickOnce 里,而 SimulatedDriver 要知道本单的 ASIN 才能造出
// 「订单卡上的 ASIN」。driver 是每轮现取的,onPhase 先于执行触发,够用。
const r = await loop.tickOnce();

console.log("\n  结果:", JSON.stringify(r.kind === "ran" ? { kind: r.kind, task: r.task.task_id, outcome: r.outcome } : r));

if (r.kind === "ran" && r.outcome.kind === "unreported") process.exit(2);
if (r.kind === "transport-error") process.exit(2);
process.exit(0);
