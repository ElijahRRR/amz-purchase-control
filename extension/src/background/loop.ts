/** 认领循环。不碰任何 chrome API —— 这样它能在 Node 里被自检脚本直接驱动。 */

import type { Client } from "../core/client.js";
import type { Config } from "../core/config.js";
import type { Log } from "../core/log.js";
import type { Phase } from "../core/status.js";
import type { Task } from "../core/types.js";
import type { PageDriver } from "../flow/driver.js";
import { runTask, type Outcome, type RunDeps } from "../flow/run.js";

export type TickResult =
  | { kind: "busy" }
  | { kind: "off" }
  | { kind: "driver-not-ready"; driver: string }
  | { kind: "no-task" }
  | { kind: "transport-error"; message: string }
  | { kind: "ran"; task: Task; outcome: Outcome };

export interface LoopDeps {
  client: Client;
  log: Log;
  config: () => Config;
  driver: () => PageDriver;
  onPhase?: (phase: Phase, task: Task | null) => void;
  askConfirm?: RunDeps["askConfirm"];
}

export class Loop {
  private busy = false;
  private warnedDriver = false;

  constructor(private readonly deps: LoopDeps) {}

  private phase(p: Phase, task: Task | null = null) {
    this.deps.onPhase?.(p, task);
  }

  /** 跑一轮:认领 → 执行 → 落终态。同一时刻只允许一轮在跑。 */
  async tickOnce(): Promise<TickResult> {
    if (this.busy) return { kind: "busy" };
    const cfg = this.deps.config();

    if (cfg.mode === "off") {
      this.phase("off");
      return { kind: "off" };
    }

    const driver = this.deps.driver();
    if (!driver.ready) {
      // 与其领了单再报 PLUGIN_INTERNAL 把它打进异常桶,不如根本不领。
      if (!this.warnedDriver) {
        this.deps.log.warn(`驱动 ${driver.name} 尚未实现执行动作,不认领`);
        this.warnedDriver = true;
      }
      this.phase("off");
      return { kind: "driver-not-ready", driver: driver.name };
    }

    this.busy = true;
    try {
      const claimed = await this.deps.client.claim();

      if (!claimed.ok) {
        // 「没说上话」绝不能当成「没有单」。厂商插件正是在这里把网络失败
        // 记成「没有需要同步的订单」,运维看日志会以为系统正常(深度分析 §5.3)。
        const msg = claimed.kind === "transport" ? claimed.message : `${claimed.code} ${claimed.message}`;
        this.deps.log.err("认领失败:" + msg);
        this.phase("idle");
        return { kind: "transport-error", message: msg };
      }

      const task = claimed.data;
      if (task === null) {
        this.phase("idle");
        return { kind: "no-task" };
      }

      this.deps.log.ok(`认领 task_id=${task.task_id} · ${task.products.map((p) => p.asin).join(",")}`);
      this.phase("claimed", task);

      this.phase("running", task);
      const outcome = await runTask(task, {
        client: this.deps.client,
        driver,
        log: this.deps.log,
        askConfirm: this.deps.askConfirm,
        confirmBeforeOrder: !!this.deps.askConfirm,
      });

      this.phase(outcome.kind === "purchased" ? "done"
               : outcome.kind === "failed" && outcome.toManual ? "blocked"
               : "idle", task);
      return { kind: "ran", task, outcome };
    } finally {
      this.busy = false;
    }
  }
}
