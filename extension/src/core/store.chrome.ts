/** chrome.storage 实现。单独一个文件:core/store.ts 要能在 Node 里编译自检。 */

import type { Store } from "./store.js";

export function chromeStore(): Store {
  return {
    async get<T>(key: string) {
      const got = await chrome.storage.local.get(key);
      return got[key] as T | undefined;
    },
    async set(key: string, value: unknown) {
      await chrome.storage.local.set({ [key]: value });
    },
  };
}
