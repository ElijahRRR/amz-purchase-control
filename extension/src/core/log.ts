/** 面板上那块黑色控制台的数据源。
 *
 * 厂商插件 9 个方法的 catch 一律 return null 且不 rethrow,多数调用点连返回值
 * 都不判断(深度分析 §5.3)—— 失败在界面上完全不可见。这里反过来:
 * 每一条都进环形缓冲,面板实时显示。
 */

export type LogLevel = "info" | "ok" | "warn" | "err" | "dim";

export interface LogLine {
  at: string;
  level: LogLevel;
  text: string;
}

const CAP = 200;

export class Log {
  private lines: LogLine[] = [];
  private listeners = new Set<(lines: LogLine[]) => void>();

  push(level: LogLevel, text: string): void {
    const at = new Date().toTimeString().slice(0, 8);
    this.lines.push({ at, level, text });
    if (this.lines.length > CAP) this.lines.splice(0, this.lines.length - CAP);
    for (const fn of this.listeners) fn(this.lines);
  }

  info(t: string) { this.push("info", t); }
  ok(t: string) { this.push("ok", t); }
  warn(t: string) { this.push("warn", t); }
  err(t: string) { this.push("err", t); }
  dim(t: string) { this.push("dim", t); }

  all(): readonly LogLine[] { return this.lines; }

  onChange(fn: (lines: LogLine[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
