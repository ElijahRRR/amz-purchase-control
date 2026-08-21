/** 同源 iframe:把目标 Amazon 页面嵌进当前页来操作。
 *
 * 为什么是 iframe 而不是导航标签页:content script 不能跨页保持状态,
 * 一导航整个执行时序就断了;而父页与 iframe 同源(都是 amazon.com),
 * 可以直接拿 contentDocument。厂商插件也是这么做的,几万单验证过可行。
 *
 * 与厂商的两点不同:
 *  1. iframe 由我们建、我们销毁,**不给操作员关闭按钮** —— 他们用 layer.js 的
 *     可关闭弹层,人手一点 × 外层 Promise 就永挂了(深度分析 B16)。
 *  2. close() 幂等且总会执行(调用方用 try/finally),不依赖弹层的 end 回调。
 */

import { waitFor } from "./wait.js";

const HOST_ID = "amz-purchase-frames";

function host(): HTMLElement {
  let el = document.getElementById(HOST_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = HOST_ID;
    // 不用 display:none —— 有些页面在不可见时不渲染/不初始化控件。
    // 放到视口外、不接受指针事件,既渲染又不打扰人。
    el.style.cssText =
      "position:fixed;left:-10000px;top:0;width:1280px;height:900px;" +
      "pointer-events:none;opacity:0.01;z-index:-1";
    document.documentElement.appendChild(el);
  }
  return el;
}

export interface Frame {
  readonly el: HTMLIFrameElement;
  /** 当前文档。每次取都重新读 —— 页面自己跳转后 contentDocument 会换。 */
  doc(): Document;
  url(): string;
  close(): void;
}

/** 输入:URL → 输出:一个已经 load 完成、拿得到 document 的 iframe 句柄。
 *  拿不到 document(跨域被挡、被 X-Frame-Options 拒)时抛错,不返回半个对象。 */
export async function openFrame(url: string, timeoutMs = 30_000): Promise<Frame> {
  const el = document.createElement("iframe");
  el.width = "1280";
  el.height = "900";
  el.src = url;
  host().appendChild(el);

  const frame: Frame = {
    el,
    doc() {
      const d = el.contentDocument;
      // 厂商那句 `if (iframe && iframe.contentWindow)` 没有 else,拿不到就静悄悄
      // 什么都不做。这里改成显式抛错:拿不到 DOM 是硬失败,不该被当成"还没好"。
      if (!d) throw new Error(`iframe 拿不到 document:${el.src}`);
      return d;
    },
    url() {
      try {
        return el.contentWindow?.location.href ?? "";
      } catch {
        return ""; // 跨域瞬间读不到,当作"还没到"
      }
    },
    close() {
      el.remove();
    },
  };

  try {
    await waitFor(
      `iframe 加载 ${url}`,
      () => {
        const d = el.contentDocument;
        if (!d || !d.body || d.readyState === "loading") return null;
        // 新建的 iframe 一开始就有一个 about:blank 文档:readyState 是 complete、
        // body 也在。只判这两样的话,函数会在目标页还没开始加载时就返回 ——
        // 上层随即在一张空白页上读购物车,读到 0 行,得出「车是空的」这个结论。
        if (!d.URL || d.URL === "about:blank") return null;
        return true;
      },
      { timeoutMs, everyMs: 200 },
    );
  } catch (e) {
    frame.close();
    throw e;
  }
  return frame;
}

/** 用完必关。所有调用点都走这个,免得某条分支忘了 close 把 iframe 留在页面上。 */
export async function withFrame<T>(
  url: string,
  fn: (f: Frame) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const f = await openFrame(url, timeoutMs);
  try {
    return await fn(f);
  } finally {
    f.close();
  }
}
