/** 等待原语。
 *
 * 厂商插件在这里踩了四个会让整条流水线永久挂起的坑(深度分析 §10.2 B14/B16、
 * §4.2.5、§4.3),四个都是同一个形状:**某条路径没有让 Promise 落地**。
 *
 *  - 轮询里 resolve 之后不 clearInterval,弹层关掉后每 500ms 访问已销毁的
 *    contentWindow 抛异常,泄漏到标签页关闭
 *  - 超时分支写成裸 return,外层 await 永不兑现
 *  - `if (iframe && iframe.contentWindow)` 没有 else,iframe 已卸载时既不进 if
 *    也不抛异常
 *  - 操作员手动关掉弹层,end 回调只打日志不 resolve
 *
 * 所以这里只有一个出口形状:**要么返回值,要么抛 WaitTimeout**。
 * 定时器在 finally 里清,不看成功与否。
 *
 * 「厂商那四个坑我们没有」不是靠读代码读出来的,有测试盯着:
 * `extension/test/unit.test.mjs` 里那两条 —— 探针每轮抛 SecurityError 时
 * waitFor 必须**按时超时**(厂商 2.4.1 在同一场景下永远不 settle),
 * 以及 waitStable 在探针抛错的那一轮必须把连续计数**打断**(见下面 waitStable)。
 * 这句话得能被验证:一条声称有测试盯着、实际没有的注释,比不写更危险。
 */

export class WaitTimeout extends Error {
  constructor(readonly what: string, readonly ms: number) {
    super(`等待「${what}」超时(${ms}ms)`);
    this.name = "WaitTimeout";
  }
}

export interface WaitOptions {
  timeoutMs?: number;
  everyMs?: number;
}

/** 输入:一个探针函数 → 输出:探针第一次返回非 null/undefined/false 的那个值。
 *  超时抛 WaitTimeout。探针自己抛的异常当作"这一轮没探到",继续等。 */
export async function waitFor<T>(
  what: string,
  probe: () => T | null | undefined | false,
  opts: WaitOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const everyMs = opts.everyMs ?? 400;
  const deadline = Date.now() + timeoutMs;

  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      const tick = () => {
        let got: T | null | undefined | false;
        try {
          got = probe();
        } catch {
          got = null; // 页面还在变,这一轮探不到很正常
        }
        if (got !== null && got !== undefined && got !== false) {
          resolve(got as T);
          return;
        }
        if (Date.now() >= deadline) reject(new WaitTimeout(what, timeoutMs));
      };
      tick();                       // 先探一次:已经就绪时不必白等一个周期
      timer = setInterval(tick, everyMs);
    });
  } finally {
    // 成功、超时、外层取消 —— 三条路都到这里。厂商插件缺的就是这一句。
    if (timer !== undefined) clearInterval(timer);
  }
}

/** 等一个条件连续 n 次为真才算数。
 *  用在等页面跳转上:URL 会在重定向链里短暂命中中间态,单次命中会误判。
 *  (厂商的 waitForPageNavigation 要求连续 3 次稳定,这一点他们做对了。) */
export async function waitStable<T>(
  what: string,
  probe: () => T | null | undefined | false,
  times = 3,
  opts: WaitOptions = {},
): Promise<T> {
  let last: T | undefined;
  let hits = 0;
  return waitFor<T>(what, () => {
    let got: T | null | undefined | false;
    try {
      got = probe();
    } catch (e) {
      // **探针抛错必须打断连续性。**
      //
      // 外层 waitFor 会把探针异常吞成「这一轮没探到」(那是对的),但异常是在
      // 这个 lambda **之外**被接住的 —— 下面那句 hits = 0 根本执行不到,
      // hits 与 last 保持着抛错之前的值。于是序列「A、A、<抛错>、A」在
      // times=3 时返回 A:三次「连续」跨过了一段读不到的空档。
      //
      // 今天这条路是潜伏的(唯一的调用点探针是 f.url(),它自己 catch 了),
      // 但 frame.urlState() 是会抛的,谁把它接进来就立刻踩到。
      // 实测与断言见 extension/test/unit.test.mjs。
      hits = 0;
      last = undefined;
      throw e;
    }
    if (got === null || got === undefined || got === false) {
      hits = 0;
      return null;
    }
    if (last !== undefined && Object.is(last, got)) hits += 1;
    else hits = 1;
    last = got as T;
    return hits >= times ? (got as T) : null;
  }, opts);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
