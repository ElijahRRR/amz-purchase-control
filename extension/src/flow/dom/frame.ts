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
 *
 * 宿主 div 平时在视口外(left:-10000px、pointer-events:none)—— 但有一格例外:
 * Amazon 把结算 iframe 导到发卡行的 3DS 验证页时,那是一个**必须由人动手**的页面。
 * 藏在屏幕外的话,「等操作员完成验证」这句话是假的:他看不见,也点不到。
 * 所以 Frame 上有 reveal()/hide(),只在那一格用。**仍然不给关闭按钮** ——
 * 放弃的方式是让上界到期(placeOrder 的三段预算 + 硬顶),不是给一个能让
 * 外层 Promise 永挂的 ×。
 */

import { waitFor } from "./wait.js";

const HOST_ID = "amz-purchase-frames";
const BANNER_ID = "amz-purchase-frames-banner";

/** 藏起来的样子:视口外、不接受指针事件。既渲染又不打扰人。 */
const HOST_HIDDEN_CSS =
  "position:fixed;left:-10000px;top:0;width:1280px;height:900px;" +
  "pointer-events:none;opacity:0.01;z-index:-1";

/** 露出来的样子:居中、可点、盖在页面之上。只有一种情况会用到 ——
 *  Amazon 把结算 iframe 导到了发卡行的验证页,得让操作员真的够得着它。 */
const HOST_SHOWN_CSS =
  "position:fixed;left:50%;top:5vh;transform:translateX(-50%);" +
  "width:min(1280px,96vw);height:min(900px,88vh);" +
  "pointer-events:auto;opacity:1;z-index:2147483646;" +
  "background:#fff;box-shadow:0 24px 64px rgba(0,0,0,.35);border-radius:10px;overflow:hidden";

function host(): HTMLElement {
  let el = document.getElementById(HOST_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = HOST_ID;
    el.style.cssText = HOST_HIDDEN_CSS;
    document.documentElement.appendChild(el);
  }
  return el;
}

/** 宿主是单例(所有 iframe 都挂在同一个 div 上),所以「谁把它露出来的」
 *  必须记下来:hide() 只认自己那一帧,免得 A 帧把 B 帧正在用的验证页收回屏幕外。 */
let revealedBy: HTMLIFrameElement | null = null;

function showHost(el: HTMLIFrameElement, banner: string): void {
  const h = host();
  h.style.cssText = HOST_SHOWN_CSS;
  let b = document.getElementById(BANNER_ID);
  if (!b) {
    b = document.createElement("div");
    b.id = BANNER_ID;
    b.style.cssText =
      "font:600 13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;" +
      "padding:10px 14px;background:#fffbeb;color:#92400e;" +
      "border-bottom:1px solid #fde68a";
    h.insertBefore(b, h.firstChild);
  }
  b.textContent = banner;
  // iframe 原本是按属性写死的 1280×900。露出来之后宿主被限制在视口以内,
  // 不跟着改的话验证表单的下半截会被裁掉 —— 而那里往往就是「提交」按钮。
  el.style.cssText = "width:100%;height:calc(100% - 42px);border:0;display:block";
  revealedBy = el;
}

/** 收回屏幕外。**不给关闭按钮**(见文件头第 1 条)—— 放弃的方式是让上界到期,
 *  不是给操作员一个能让外层 Promise 永挂的 ×。 */
function hideHost(): void {
  const h = document.getElementById(HOST_ID);
  if (h) h.style.cssText = HOST_HIDDEN_CSS;
  document.getElementById(BANNER_ID)?.remove();
  revealedBy = null;
}

/** `url()` 读不到时到底是哪一种读不到。
 *
 *  原先 url() 把三件事渲染成同一个空字符串:跨域(**人正在验证页上**)、
 *  iframe 已经被销毁、URL 真的是空。它们的处置完全不同 ——
 *  第一种要把窗口露出来等人,第二种立刻判死,第三种继续等。
 *  「两种不同的情况渲染出同一个结果就是缺陷」,这是它的一个实例。 */
export type UrlState =
  | { kind: "ok"; url: string }
  /** 落进了不透明源:读 location 抛 SecurityError。3DS 验证页就长这样,
   *  而且它**不是一瞬间的事**,是分钟级的。 */
  | { kind: "cross_origin" }
  /** iframe 不在文档里了,或 contentWindow 没了。等下去没有意义。 */
  | { kind: "detached" }
  /** 读不到,但不是上面两种。带上异常名,别让它退化成又一个空字符串。 */
  | { kind: "unreadable"; name: string };

export interface Frame {
  readonly el: HTMLIFrameElement;
  /** 当前文档。每次取都重新读 —— 页面自己跳转后 contentDocument 会换。 */
  doc(): Document;
  url(): string;
  /** 读不到 URL 时它到底是哪一种读不到。 */
  urlState(): UrlState;
  /** 把这一帧连同一条中文横幅推到屏幕中间、可点。用在「要人来动手」的那一格。 */
  reveal(banner: string): void;
  /** 收回屏幕外。幂等;别人露出来的那一帧不动。 */
  hide(): void;
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
    urlState(): UrlState {
      // 先问「这一帧还在不在」。厂商 v2.5.3 :1182 这一处判据是对的
      // (iframe / contentWindow / isConnected 三样一起看),照抄。
      if (!el.isConnected || !el.contentWindow) return { kind: "detached" };
      try {
        return { kind: "ok", url: el.contentWindow.location.href ?? "" };
      } catch (e) {
        // 跨域判据也照厂商 v2.5.3 :1162-1166:name 是 SecurityError,或 code 18。
        // 两条都留着 —— 不同浏览器/不同年代的实现给的不一样。
        const err = e as { name?: string; code?: number };
        if (err?.name === "SecurityError" || err?.code === 18) return { kind: "cross_origin" };
        return { kind: "unreadable", name: err?.name || String(e) };
      }
    },
    url() {
      // 语义保持不变:读得到就给 URL,读不到一律空串。老调用点一个字都不用改;
      // 要区分「哪一种读不到」的地方改用 urlState()。
      const s = frame.urlState();
      return s.kind === "ok" ? s.url : "";
    },
    reveal(banner: string) {
      showHost(el, banner);
    },
    hide() {
      // 别人露出来的那一帧不归我收。
      if (revealedBy === el) hideHost();
    },
    close() {
      // **无条件** hide:宿主是单例,而 close() 是唯一一个所有调用方都放在
      // finally 里的出口。与其相信「谁 reveal 谁 hide」,不如在这里兜住 ——
      // 一个忘了收回去的宿主会把 1280×900 的白框留在页面正中央。
      hideHost();
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
