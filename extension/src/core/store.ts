/** 持久化的抽象。
 *
 * 有这一层是为了让流程能在 Node 里跑起来自检 —— chrome.storage 只存在于浏览器,
 * 硬编码它就等于这套代码只能靠手点扩展来验证。
 */

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export function memoryStore(init: Record<string, unknown> = {}): Store {
  const m = new Map<string, unknown>(Object.entries(init));
  return {
    async get<T>(key: string) {
      return m.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      m.set(key, value);
    },
  };
}
