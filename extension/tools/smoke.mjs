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

/** 「下单前确认」那三个场景。它们不换驱动 —— 页面动作照 happy 走,
 *  换的是**谁来按那一下**:这里注入一个自动应答的 askConfirm,
 *  模拟屏幕前那个人按了「下单」/ 按了「取消」/ 根本没来按。
 *
 *  **第三个不叫 `confirm_timeout`。** 那个名字已经归 `flow/simulated.ts` 里
 *  「点了下单但没等到确认页」用了(错误码 ORDER_CONFIRM_TIMEOUT,钱可能已经花了)。
 *  两件事共用一个场景名的话,`--scenario confirm_timeout` 跑出来的到底是哪一种
 *  就要靠猜 —— 而它们一个是「可能已下单,转待人工」,一个是「一分钱没花,回队列」。
 *
 *  `answer: null` = 这个人永远不按。askConfirm 返回一个永不 settle 的 promise,
 *  上界由 run.ts 那边的钟说了算 —— 验的正是「界面不应答时那道闸照样到点」。 */
const CONFIRM_SCENARIOS = {
  confirm_yes:          { answer: true,  waitMs: 60_000, wantOutcome: "purchased",
                          wantStatus: "purchased", wantStep: "人按了下单,继续" },
  confirm_no:           { answer: false, waitMs: 60_000, wantOutcome: "released",
                          wantStatus: "ready",     wantStep: "人按了取消,退回队列" },
  confirm_wait_timeout: { answer: null,  waitMs: 1_200,  wantOutcome: "released",
                          wantStatus: "ready",     wantStep: "等人确认超时" },
  // 第四个:**看门狗在确认窗口还开着的时候开火**,而屏幕前那个人晚一步按了「下单」。
  // 单笔硬顶配成 250ms、确认窗口 60 秒 —— 这个配法不是杜撰的,taskHardCapMs 是
  // 现场可调的,老服务端不下发 claim_timeout_min 时同理。
  // 要验的是那一下**一点都不作数**:不点下单按钮、不写「越过下单点」的留痕、
  // 也不写「人按了取消」(那是把看门狗掐单渲染成有人在把关)。
  // 这一单停在 claimed,由服务端的认领超时清扫去收 —— 它一分钱没花。
  confirm_watchdog:     { answer: true,  waitMs: 60_000, answerAfterMs: 600,
                          hardCapMs: 250, wantTick: "hard-cap",
                          wantStatus: "claimed",   wantStep: "插件放弃这一单" },
  // 第五个:**认领窗口已经不够停下来等人了**。把「下单那一步至少要留」的地板
  // 配成 15 分钟(比服务端的整个认领窗口还长)→ 扣完一点余地都不剩。
  // 要验的是这一格**根本不开窗口**:一个人都不问,清车退回队列,
  // 事件流里一条 awaiting_confirm 都没有(窗口没开过,没人见过那一屏)。
  // 硬着头皮开的话,人在窗口末尾按下的那一下会拿到一个 ~0 的下单硬顶 →
  // ORDER_CONFIRM_TIMEOUT → 待人工「可能已下单」,而它本来一分钱没花。
  confirm_no_room:      { answer: true,  waitMs: 60_000, minOrderRoomMs: 15 * 60_000,
                          wantOutcome: "released",
                          wantStatus: "ready",     wantStep: "认领窗口不够停下来等人了" },
};
const confirmCase = CONFIRM_SCENARIOS[scenario] ?? null;

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
const driver = new SimulatedDriver(confirmCase ? "happy" : scenario);

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
  // 开关从配置来,不是「传了 askConfirm 就等于开」—— 与插件里那条规矩同一份。
  config: () => ({
    mode: "simulate",
    confirmBeforeOrder: !!confirmCase,
    ...(confirmCase
      ? { timeouts: { confirmWait: confirmCase.waitMs,
                      ...(confirmCase.minOrderRoomMs
                        ? { minOrderRoom: confirmCase.minOrderRoomMs } : {}) } }
      : {}),
    ...(confirmCase?.hardCapMs ? { taskHardCapMs: confirmCase.hardCapMs } : {}),
  }),
  driver: () => driver,
  reportLogin: (state) => { reportedLogin = state; },
  askConfirm: confirmCase
    ? async () => {
        if (confirmCase.answer === null) {
          console.log("  (模拟:没人来按这一下,等 run.ts 那道闸自己到点)");
          return new Promise(() => {});    // 永不 settle:上界不该由界面提供
        }
        if (confirmCase.answerAfterMs) {
          // 慢一步的那一下:等看门狗先开火,再模拟人按下按钮。
          await new Promise((r) => setTimeout(r, confirmCase.answerAfterMs));
        }
        console.log(`  (模拟:人按了「${confirmCase.answer ? "下单" : "取消"}」)`);
        return confirmCase.answer;
      }
    : undefined,
  onConfirmWindow: (deadlineMs) => {
    if (deadlineMs !== null) {
      console.log(`  停在下单前等人确认,到点 ${new Date(deadlineMs).toISOString()}`);
    }
  },
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

// 三种结局在**服务端**长什么样。只看插件自己返回的 outcome 是不够的:
// 「插件以为退回队列了」和「服务端那边真的回到 ready 了」是两件事,
// 而这一整条链要验的就是后者。
if (confirmCase) {
  // 掐单那一格里 tickOnce 返回的是 hard-cap(没有 outcome 可言),任务 id 挂在
  // 结果本身上;另外要**等那条僵尸 runTask 把它想做的事做完**再去读服务端 ——
  // 早读一步的话,「它后来偷偷点了下单」这件事正好被漏掉,而这条场景验的就是它。
  const taskId = r.kind === "ran" || r.kind === "hard-cap" ? r.task.task_id : null;
  if (confirmCase.answerAfterMs) {
    await new Promise((res) => setTimeout(res, confirmCase.answerAfterMs + 600));
  }
  const problems = [];
  const wantTick = confirmCase.wantTick ?? "ran";
  if (r.kind !== wantTick) problems.push(`这一轮是 ${r.kind},该是 ${wantTick}:${JSON.stringify(r)}`);
  else if (wantTick === "ran" && r.outcome.kind !== confirmCase.wantOutcome) {
    problems.push(`插件侧结局是 ${r.outcome.kind},该是 ${confirmCase.wantOutcome}`);
  }
  if (taskId !== null) {
    const res = await fetch(`${base}/v1/admin/tasks/${taskId}`);
    const body = await res.json();
    const d = body?.data;
    if (!d) problems.push(`读不到任务详情:${JSON.stringify(body)}`);
    else {
      if (d.status !== confirmCase.wantStatus) {
        problems.push(`服务端状态是 ${d.status},该是 ${confirmCase.wantStatus}`);
      }
      // **只看这一轮说过的话。** 事件表是追加的,而这几个场景里有三个会把任务
      // 退回队列 —— 它随后会被再认领一次,上一轮的 awaiting_confirm /
      // confirm_timeout / confirm_cancelled 全都还留在同一条任务上。不切的话,
      // 「这一轮既写了取消又写了超时」与「上一轮写过超时」长成同一个样子,
      // 这份自检自己就犯了它要防的那个毛病(两种情况渲染成一个结果)——
      // 表现是同一份代码在空库上全绿、在跑过几轮的库上莫名转红。
      // 切法:一轮从服务端记下的那条 `claimed` 事件开始,取最后一条。
      const all = d.events ?? [];
      const lastClaim = all.map((e) => e.kind).lastIndexOf("claimed");
      const evs = lastClaim >= 0 ? all.slice(lastClaim) : all;
      const steps = evs.map((e) => String(e.payload?.step ?? ""));
      if (!steps.some((t) => t.includes(confirmCase.wantStep))) {
        problems.push(`事件流里没有「${confirmCase.wantStep}」,只有:${JSON.stringify(steps)}`);
      }
      // 取消与超时**不许长成一个样子**:两条路都是 released + 回 ready,
      // 分得开的地方只剩事件流里那条文案与 payload.state。合成一条的话,
      // 一台没人守的机器会一直产出「有人按了取消」,看的人以为有人在把关。
      const states = evs.map((e) => e.payload?.state).filter(Boolean);
      const wantState = scenario === "confirm_yes" ? "confirm_approved"
                      : scenario === "confirm_no" ? "confirm_cancelled"
                      : scenario === "confirm_watchdog" ? "plugin_hard_cap"
                      : scenario === "confirm_no_room" ? "confirm_no_room" : "confirm_timeout";
      if (!states.includes(wantState)) {
        problems.push(`事件流里没有 state=${wantState},只有:${JSON.stringify(states)}`);
      }
      const strayer = scenario === "confirm_no" ? "confirm_timeout"
                    : scenario === "confirm_wait_timeout" ? "confirm_cancelled" : null;
      if (strayer && states.includes(strayer)) {
        problems.push(`事件流里同时出现了 ${strayer} —— 取消与超时被渲染成了同一件事`);
      }
      if (scenario === "confirm_no_room") {
        // 窗口**没开过**。写了 awaiting_confirm 的话,运营台上会出现一屏
        // 从来没人见过的确认屏 —— 而这一格恰恰是「没轮到人」。
        if (states.includes("awaiting_confirm")) {
          problems.push("窗口根本没开却写了 awaiting_confirm —— 事件流里多出一屏没人见过的确认屏");
        }
        for (const stray of ["confirm_approved", "confirm_cancelled", "confirm_timeout"]) {
          if (states.includes(stray)) {
            problems.push(`事件流里出现了 ${stray} —— 没人被问过,这三句在这一格全是假话`);
          }
        }
      }
      // **退回队列的那几格,一位都不许点亮 may_have_ordered。** 它们的共同点是
      // 下单按钮一次都没点下去;点亮了的话,四道「回队列之前先看一眼」的闸会把
      // 一张一分钱没花的单挡在队列外面,而它本来还能安全地再跑一次。
      if (confirmCase.wantStatus !== "purchased" && d.may_have_ordered !== false) {
        problems.push(`may_have_ordered=${d.may_have_ordered},该是 false(这一单一分钱没花)`);
      }
      if (scenario === "confirm_watchdog") {
        // 被放弃之后按下的那一下**一点都不作数**。三条一起判,少一条这道闸就有缝:
        //  · 写了 confirm_approved / confirm_cancelled → 一个是「人点的头」,
        //    一个是「有人在把关」,两句在这一格都是假话
        //  · 点了下单按钮 / 留下越过下单点的痕 → 一张一分钱没花的单会以
        //    「可能已下单,去买家号里看一眼」收场
        for (const stray of ["confirm_approved", "confirm_cancelled", "confirm_timeout"]) {
          if (states.includes(stray)) {
            problems.push(`看门狗掐单之后还写了 state=${stray} —— 那一下不该作数`);
          }
        }
        if (steps.some((t) => t.includes("点击下单按钮"))) {
          problems.push("看门狗掐单之后还点了下单按钮 —— 一张没花钱的单被推过了下单点");
        }
      }
      console.log(`  服务端:status=${d.status} · 事件 state=${JSON.stringify(states)}`);
    }
  }
  if (problems.length) {
    console.error("  ✗ " + problems.join("\n  ✗ "));
    process.exit(3);
  }
  console.log("  ✓ 三段核对通过(插件侧结局 / 服务端状态 / 事件流文案与 state)");
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
