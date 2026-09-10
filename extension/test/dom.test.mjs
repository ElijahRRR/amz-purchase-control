#!/usr/bin/env node
/** 解析层的离线验证。
 *
 * 真实 Amazon 页面拿不到,所以对着 test/fixtures/ 里按逆向报告造出来的 DOM 跑。
 * 夹具里塞满了干扰项(隐藏的同 id 副本、Saved for later、推荐位、模板节点),
 * 选择器写松了会当场被抓住。
 *
 *   npm run test:dom
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const KIT = join(here, "..", "dist", "domkit.js");

// dist/ 会被 background 那趟构建清空,直接 node 这个文件就会撞 ENOENT。
// 报一句人话,别让人对着 fs 的堆栈猜。
if (!existsSync(KIT)) {
  console.error(`\n  找不到 ${KIT}\n  先跑 npm run test:dom(它会先构建 domkit),别直接 node 这个文件。\n`);
  process.exit(1);
}

let pass = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? "  → " + detail : ""}`);
}

function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(name, g === w, `期望 ${w},实际 ${g}`);
}

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});

async function withFixture(file, fn) {
  const path = join(here, "fixtures", file);
  let html;
  try {
    html = readFileSync(path, "utf8");
  } catch {
    // 夹具缺失算失败,不算崩溃 —— 其余夹具还得跑完
    failures.push(`夹具缺失:${file}`);
    return;
  }
  const page = await browser.newPage();
  await page.setContent(html);
  await page.addScriptTag({ path: KIT });
  const run = (expr) => page.evaluate(expr);
  try {
    await fn(run);
  } finally {
    await page.close();
  }
}

/** 把夹具**当作某个 URL 上的页面**打开。
 *
 *  上面那个 withFixture 用的是 setContent,页面的 URL 永远是 about:blank ——
 *  于是 readLoginState 的第一条判据(URL 落在 /ap/signin)在夹具里根本走不到。
 *  这里用 route 拦截把请求就地回掉:不联网,但页面真的落在给定的 URL 上。 */
async function withUrl(url, file, fn) {
  const path = join(here, "fixtures", file);
  let html;
  try {
    html = readFileSync(path, "utf8");
  } catch {
    failures.push(`夹具缺失:${file}`);
    return;
  }
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  await page.goto(url);
  await page.addScriptTag({ path: KIT });
  try {
    await fn((expr) => page.evaluate(expr));
  } finally {
    await page.close();
  }
}

// ── 导航栏:登录态 ────────────────────────────────────────────────────
//
// 这一节盯的是「被登出」不再和「页面慢」长得一样。判错的两个方向代价不对等:
//   · 把登出判成登录  → 闸门看着在、其实不拦,单子照领照跑照超时(最坏)
//   · 把登录判成登出  → 这个买家号被停派,但运营台上写着「已登出」,有人看得见
// 所以判据全部按"结构优先、文案只能往已登出那边推"来写。
await withFixture("nav-signed-in.html", async (run) => {
  eq("nav 已登录", await run("amzdom.readLoginState(document)"), "ok");
  // 干扰项自己也得验一遍:隐藏模板确实排在真导航栏前面,
  // 不然上面那条断言即使实现写松了也照样绿 —— 夹具没干扰,断言就没用。
  eq("nav 隐藏的未登录模板排在前面(干扰项确实存在)",
     await run(`(() => {
        const all = [...document.querySelectorAll("#nav-link-accountList")];
        return [all.length, (all[0].getAttribute("href") || "").includes("/ap/signin")];
     })()`), [2, true]);
  // signout 在 display:none 的账户浮层里 —— 判据要是要求"可见",这条会变 false
  eq("nav signout 节点在隐藏浮层里(干扰项确实存在)",
     await run(`(() => {
        const el = document.querySelector("#nav-item-signout");
        return !!el && el.closest('[style*="display:none"]') !== null;
     })()`), true);
});

await withFixture("nav-signed-out.html", async (run) => {
  eq("nav 已登出", await run("amzdom.readLoginState(document)"), "signed_out");
  // 这张页面里藏着一个"已登录"的模板(连 signout 都有)。见到 signout 就判已登录的
  // 实现会在这里翻车 —— 而那正是最坏的那个方向。
  eq("nav 隐藏的已登录模板确实存在(干扰项)",
     await run(`!!document.querySelector('[style*="display:none"] #nav-item-signout')`), true);
  // 页脚那条 signin 链接、商品标题里的 "sign in" 都在,全局扫页面文本的实现会中招
  eq("nav 页脚的无关 signin 链接确实存在(干扰项)",
     await run(`!!document.querySelector('#navFooter a[href*="signin"]')`), true);
  eq("nav 商品标题里带 sign in(干扰项)",
     await run(`/sign in/i.test(document.querySelector(".sc-recommendations").textContent)`), true);
});

// **URL 判据**:落在 /ap/signin 上就是被登出了,页面里长什么样都不改变这个结论。
//
// 这一条被注释和文档称作"最硬",却曾经一条断言都没有:把它反过来写成
// `return "ok"`,97 条断言全绿(2026-09-06 复核实测)。原因是夹具全部走
// setContent,URL 永远是 about:blank,这条判据在测试里根本走不到。
// 现在它收成了一处定义(parse.isSignInUrl),下面两条盯着它 ——
// 一条盯"命中时不许被 DOM 翻案",一条盯"不命中时别乱判"(免得上面那条
// 是因为 route 或夹具本身坏了才变红,那样它证明不了任何事)。
await withUrl("https://www.amazon.com/ap/signin?openid.pape=x&ref_=nav_signin",
              "nav-signed-in.html", async (run) => {
  eq("URL 落在 /ap/signin → signed_out(哪怕 DOM 是一整套已登录导航栏)",
     await run("amzdom.readLoginState(document)"), "signed_out");
  // 这张夹具确实是"已登录"的那一张 —— 干扰项得真的在
  eq("这张页面的 DOM 确实是已登录的样子(干扰项确实存在)",
     await run(`!!document.querySelector("#nav-item-signout")`), true);
});
await withUrl("https://www.amazon.com/gp/cart/view.html",
              "nav-signed-in.html", async (run) => {
  eq("同一张夹具放在购物车 URL 上 → ok", await run("amzdom.readLoginState(document)"), "ok");
});

// **读不到导航栏 = unknown,不是 ok。** 判不出来时兜底成"应该登录着吧",
// 这道闸就等于不存在,而界面上还会写着"已登录"。
await withFixture("cart.html", async (run) => {
  eq("购物车夹具没有导航栏 → unknown", await run("amzdom.readLoginState(document)"), "unknown");
});
await withFixture("checkout.html", async (run) => {
  eq("结算页没有导航栏 → unknown", await run("amzdom.readLoginState(document)"), "unknown");
});

// 几个边界:用 DOMParser 现造,不值得为它们各建一张夹具
await withFixture("cart-empty.html", async (run) => {
  const parse = (html) =>
    run(`amzdom.readLoginState(new DOMParser().parseFromString(${JSON.stringify(html)}, "text/html"))`);

  // signout 藏在 display:none 的浮层里(Amazon 的常态)—— 照样算已登录
  eq("nav 只有隐藏浮层里的 signout → ok",
     await parse('<div style="display:none"><a id="nav-item-signout" href="#">Sign Out</a></div>'), "ok");
  // 文案是否决票:问候语明写着 sign in 时,残留的 signout 节点不算数
  eq("nav 问候语 sign in 压过残留的 signout → signed_out",
     await parse('<span id="nav-link-accountList-nav-line-1">Hello, sign in</span>' +
                 '<a id="nav-item-signout" href="#">Sign Out</a>'), "signed_out");
  // 有账户入口,但 href 认不出、也没有别的判据 → 不许猜
  eq("nav 只有一个认不出的账户入口 → unknown",
     await parse('<a id="nav-link-accountList" href="/gp/something-new"></a>'), "unknown");
  // 中文/别的语言的问候语:判不出就是判不出,**不能**当成已登录
  eq("nav 非英文问候语 → unknown",
     await parse('<a id="nav-link-accountList" href="/gp/x">' +
                 '<span id="nav-link-accountList-nav-line-1">你好,David</span></a>'), "unknown");
  eq("nav 账户入口指向账户首页 → ok",
     await parse('<a id="nav-link-accountList" href="/gp/css/homepage.html?ref_=nav_ya"></a>'), "ok");
  eq("nav 账户入口指向 /ap/signin → signed_out",
     await parse('<a id="nav-link-accountList" href="/ap/signin?openid.pape=0"></a>'), "signed_out");

  // 判据本身:URL 那一条收成了一处定义(parse.isSignInUrl),用它的有五处
  // (readLoginState 两处、AmazonDriver.readLoginState 两处、guardLogin)。
  // 那四处开 iframe、要真页面,离线验不了;能验的是它们共用的这一处。
  const is = (u) => run(`amzdom.isSignInUrl(${JSON.stringify(u)})`);
  eq("isSignInUrl 命中(带查询串)",
     await is("https://www.amazon.com/ap/signin?openid.pape=x"), true);
  eq("isSignInUrl 命中(登录页的子路径)",
     await is("https://www.amazon.com/ap/signin/attempt"), true);
  eq("isSignInUrl 不把购物车页当登录页",
     await is("https://www.amazon.com/gp/cart/view.html"), false);
  // 读不到 URL(跨域、文档没就绪)时 frame.url() 给的是空串。
  // **「读不到」不是「不在登录页」** —— 这条判据这一次用不上而已,
  // 判成 true 会把每一次读不到都说成"被登出了"。
  eq("isSignInUrl 空串不算命中", await is(""), false);
  eq("isSignInUrl null 不算命中", await run("amzdom.isSignInUrl(null)"), false);
});

// ── 执行中掉线:结算 iframe 被 302 到 /ap/signin ────────────────────────
//
// 这是「执行中掉线」的头号场景,也是整件事的起点。要命的地方在于:Amazon 登录页
// 普遍带 X-Frame-Options: DENY,浏览器**拒绝在 iframe 里渲染它** —— 于是
// guardLogin 的两条判据(URL 落在 /ap/signin、DOM 说已登出)一条都读不到,
// 照旧报 CHECKOUT_TIMEOUT,「被登出」和「页面慢」又长成同一个样子。
//
// 下面这一节先把这个前提本身验一遍(Chromium 到底怎么表现),再验兜底那条路:
// 两条判据都读不到时换一张购物车页(不会被 XFO 挡)再问一次。
async function withCheckoutFrame(cartFixture, fn) {
  const cart = readFileSync(join(here, "fixtures", cartFixture), "utf8");
  const page = await browser.newPage();
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.includes("/ap/signin")) {
      // Amazon 登录页的那顶帽子。这一行就是整段的前提。
      return route.fulfill({ status: 200, contentType: "text/html",
                             headers: { "X-Frame-Options": "DENY" },
                             body: "<h1>Sign in</h1>" });
    }
    if (url.includes("/gp/cart/view.html")) {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: cart });
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8",
                           body: "<h1>checkout</h1>" });
  });
  await page.goto("https://www.amazon.com/checkout/p/p-1");
  await page.addScriptTag({ path: KIT });
  try {
    await fn((expr) => page.evaluate(expr));
  } finally {
    await page.close();
  }
}

/** 在页面里造出「结算 iframe 被 302 到登录页」这个局面,再让 guardLogin 去判。
 *  返回 [两条判据还读不读得到, guardLogin 抛出来的东西]。 */
const SIGNED_OUT_DRILL = `(async () => {
  const f = await amzdom.openFrame("https://www.amazon.com/checkout/p/p-1", 8000);
  f.el.src = "https://www.amazon.com/ap/signin?openid.pape=1";
  await new Promise((r) => setTimeout(r, 800));
  const readable = {
    url: f.url(),
    doc: (() => { try { f.doc(); return true; } catch { return false; } })(),
  };
  const driver = new amzdom.AmazonDriver("https://www.amazon.com");
  let threw = "没抛";
  // guardLogin 在 TS 里是私有的,这里是**故意**从外面戳它:它是这条兜底的全部内容,
  // 而走公开方法(proceedToCheckout)要先把私有的 checkout frame 摆好,更绕。
  // 真被改名了这一句会当场 TypeError —— 那也是一次响亮的失败,不是静默通过。
  try { await driver.guardLogin(f, "跳转结算页"); }
  catch (e) { threw = e.constructor.name; }
  f.close();
  return [readable, threw];
})()`;

await withCheckoutFrame("nav-signed-out.html", async (run) => {
  const [readable, threw] = await run(SIGNED_OUT_DRILL);
  // 前提:XFO 之后这一帧整个读不到 —— url 空串、doc 抛错。
  // 这两条要是不成立,下面那条断言就证明不了任何事(它可能是走老判据过的)。
  eq("XFO 之后 iframe 的 URL 读不到(前提)", readable.url, "");
  eq("XFO 之后 iframe 的 document 读不到(前提)", readable.doc, false);
  eq("两条判据都读不到 → 换购物车页再问 → 判为已登出", threw, "LoginLostError");
});

// 反过来:换的那张页面说"还登着",就**不下结论** —— 由调用方原本的错误码去说。
// 少了这一条,上面那条断言就可能只是"读不到就说被登出了",那是另一种缺陷。
await withCheckoutFrame("nav-signed-in.html", async (run) => {
  const [, threw] = await run(SIGNED_OUT_DRILL);
  eq("同样读不到,但购物车页说还登着 → 不下结论", threw, "没抛");
});

// ── 商品页 ──────────────────────────────────────────────────────────
await withFixture("product.html", async (run) => {
  eq("product 有货", await run("amzdom.readInStock(document)"), true);
  eq("product 数量 1 可选", await run("amzdom.findQuantityOption(document, 1)"), { has: true, matched: true });
  // 夹具里 3 那个 option 的文本是 " 3 " —— 不 trim 就选不中
  eq("product 数量 3 可选(文本带空格)", await run("amzdom.findQuantityOption(document, 3)"), { has: true, matched: true });
  // 夹具里 4 那个 option 的文本带换行与缩进 —— 只 trim 不折叠空白就选不中
  eq("product 数量 4 可选(文本带换行缩进)", await run("amzdom.findQuantityOption(document, 4)"), { has: true, matched: true });
  eq("product 数量 7 不可选", await run("amzdom.findQuantityOption(document, 7)"), { has: true, matched: false });
  // 夹具里有个 <option value="0">0 (Delete)</option> —— 图省事读 option.value 的
  // 实现会把「删除」当成数量 0 选中。报告明写的是比对 innerText。
  eq("product 不会把 value=0 的删除项当成数量 0",
     await run("amzdom.findQuantityOption(document, 0)"), { has: true, matched: false });
  // 隐藏的同 id 副本只有 1 个 option,被选中就会让上面那几条挂掉
  eq("product 选中的是可见的那个 #quantity",
     await run("amzdom.pickQuantitySelect(document).options.length > 2"), true);

  // ── 加购按钮:选中的必须是**点得动**的那一个 ────────────────────────
  //
  // 夹具里有一个 disabled + aria-disabled 的同 id 副本**排在真身前面**。
  // click() 打在 disabled 元素上不抛错、返回 true,浏览器却不派发 click 事件
  // (SP/wf/payment_atc_probe.mjs 实测)—— 于是流程以为点成功了,然后等满
  // T.addToCart(30s) 才报 ADD_TO_CART_FAILED,而真正的原因看不出来。
  eq("product 加购按钮的干扰项确实存在(disabled 副本排在前面)",
     await run(`(() => {
        const all = [...document.querySelectorAll("#add-to-cart-button")];
        return [all.length, all[0].disabled, all[0].getAttribute("aria-disabled")];
     })()`), [2, true, "true"]);
  eq("product 加购按钮选到的是可用的那个",
     await run(`(() => {
        const b = amzdom.findAddToCartButton(document);
        return [!!b, b?.disabled, b?.getAttribute("aria-disabled")];
     })()`), [true, false, null]);
  // 第二形态(厂商 v2.5.3:2180 新增)也要认。夹具里没有,现造一张验判据本身
  eq("product 加购按钮认第二形态 input[name=submit.add-to-cart]",
     await run(`(() => {
        const d = document.createElement("div");
        d.innerHTML = '<input type="submit" name="submit.add-to-cart" value="Add to Cart">';
        document.body.appendChild(d);
        document.querySelectorAll("#add-to-cart-button").forEach((e) => e.remove());
        const b = amzdom.findAddToCartButton(document);
        return b ? b.getAttribute("name") : null;
     })()`), "submit.add-to-cart");
});

await withFixture("product-oos.html", async (run) => {
  // 文案是 "Currently unavailable." 带句点 —— 全等判定会漏
  eq("product-oos 判为无货", await run("amzdom.readInStock(document)"), false);
});

// ── 购物车 ──────────────────────────────────────────────────────────
await withFixture("cart.html", async (run) => {
  const lines = await run("amzdom.readCartLines(document)");
  eq("cart 只数 Active Items 里的行", lines.length, 2);
  const byAsin = Object.fromEntries(lines.map((l) => [l.asin, l.quantity]));
  eq("cart B0FB3VS68J 数量", byAsin["B0FB3VS68J"], 1);
  eq("cart B0CHXNPXVX 数量(非可编辑形态)", byAsin["B0CHXNPXVX"], 3);
  check("cart 没把 Saved for later 算进来",
        !lines.some((l) => l.asin === "B08N5WRWNW" || l.asin === "B09XS7JWHH"),
        JSON.stringify(lines.map((l) => l.asin)));
  eq("cart 与本单一致时匹配",
     await run(`amzdom.cartMatches(amzdom.readCartLines(document),
       [{asin:"B0FB3VS68J",quantity:1},{asin:"B0CHXNPXVX",quantity:3}])`), true);
  eq("cart 数量不符时不匹配",
     await run(`amzdom.cartMatches(amzdom.readCartLines(document),
       [{asin:"B0FB3VS68J",quantity:1},{asin:"B0CHXNPXVX",quantity:2}])`), false);
  eq("cart 多一件时不匹配",
     await run(`amzdom.cartMatches(amzdom.readCartLines(document),
       [{asin:"B0FB3VS68J",quantity:1}])`), false);

  // ── 空车标志的**取法**:裸 querySelector vs pickFirstRendered ────────
  //
  // 这一页车里有两件在售商品,同时挂着一个隐藏的空车提示模板(干扰项 A-2)。
  // 「车是空的」这个结论由 emptyMarkers 下:clearCart 的正面证据、
  // verifyCart 的空车早退都用它。选择器**内容**对不对之前先有一个问题 ——
  // 用什么方式取。裸 querySelector 会被这个没画出来的模板满足。
  eq("cart 上确实摆着一个空车标志节点(前提:干扰项存在)",
     await run(`amzdom.SEL.cart.emptyMarkers.some((m) => !!document.querySelector(m))`), true);
  eq("cart 那个空车标志只靠 CSS 类隐藏(前提:isHidden 这一档看不见它)",
     await run(`(() => { const el = document.querySelector("#sc-empty-cart");
        return [el.hasAttribute("hidden"), el.hasAttribute("aria-hidden"),
                el.style.display === "", el.closest('[hidden],[aria-hidden="true"]') === null];
     })()`), [false, false, true, true]);
  eq("车里有货时,走 pickFirstRendered 的空车标志一条都不成立",
     await run(`amzdom.pickFirstRendered(document, amzdom.SEL.cart.emptyMarkers) === null`), true);
});

await withFixture("cart-empty.html", async (run) => {
  eq("cart-empty 行数为 0", await run("amzdom.readCartLines(document).length"), 0);
  // 「车是空的」要有正面证据:容器在、**而且容器里一个画出来的商品行都没有**。
  eq("cart-empty 的 0 行是「容器在、一行都看不见」", await run("amzdom.readCartState(document)"),
     { lines: [], scopeFound: true, rowsSeen: 0 });
  // 前提:容器里其实躺着一份 .sc-list-item 模板 —— rowsSeen 不数它,是因为它没画出来。
  // 少了这一条,上面那个 0 可能只是"容器里什么都没有"而不是"只数渲染出来的"。
  eq("cart-empty 的容器里确实有一份隐藏的行模板(前提)",
     await run(`document.querySelector('[data-name="Active Items"]')
                  .querySelectorAll(".sc-list-item").length`), 1);
});

// ── 清车那道闸:让 AmazonDriver 真的走一遍 ───────────────────────────
//
// 上面那些断言验的是纯函数。纯函数对不对,与 amazon.ts **用哪种方式取判据**
// 是两件事 —— 而这一档缺陷恰恰全在取法上:选择器数组的内容有断言盯着,
// 「裸 querySelector 还是 pickFirstRendered」一条都没有。
//
// 这里把购物车夹具挂在真实的购物车 URL 上,让驱动开自己的 iframe、走自己的
// 渲染门、下自己的结论。transform 就地造出「Amazon 改版了」的那几种页面。
async function withDriverOnCart(fixture, transform, fn) {
  const body = transform(readFileSync(join(here, "fixtures", fixture), "utf8"));
  const page = await browser.newPage();
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.includes("/gp/cart/view.html")) {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body });
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<h1>amazon</h1>" });
  });
  await page.goto("https://www.amazon.com/checkout/p/p-1");
  await page.addScriptTag({ path: KIT });
  try {
    await fn((expr) => page.evaluate(expr));
  } finally {
    await page.close();
  }
}

/** 返回 [错误码或"没抛", 错误文案]。 */
const CLEAR_CART_DRILL = `(async () => {
  const driver = new amzdom.AmazonDriver("https://www.amazon.com");
  try { await driver.clearCart(); return ["没抛", ""]; }
  catch (e) { return [e.code ?? e.constructor.name, String(e.message ?? "").slice(0, 160)]; }
})()`;

// 场景:Amazon 把 [data-name="Active Items"] 改名,车里还留着上一单的两件商品,
// 而页面上挂着那个隐藏的空车提示模板(干扰项 A-2)。
// 裸 querySelector 的「正面证据」被模板满足 → clearCart 直接 return「已清空」,
// 残留被带进下一单;走 pickFirstRendered 才会认下「我们读不懂这一页」。
await withDriverOnCart("cart.html",
  (html) => html.replaceAll('data-name="Active Items"', 'data-name="Active Cart Items"'),
  async (run) => {
    const [code, msg] = await run(CLEAR_CART_DRILL);
    eq("容器改名 + 隐藏的空车模板 → clearCart 不许判「已清空」", code, "PLUGIN_INTERNAL");
    check("这条错误说的是「没有正面证据」", msg.includes("正面证据"), msg);
  });

// 场景:容器没改名,改的是**行**。车里两件商品还在页面上画着,
// 而我们一行都解析不出 ASIN —— 这不是「空车」,是我们读不懂这一页了。
await withDriverOnCart("cart.html",
  (html) => html.replaceAll('<div class="sc-list-item" data-asin=',
                            '<div class="sc-item-row" data-asin='),
  async (run) => {
    const [code, msg] = await run(CLEAR_CART_DRILL);
    eq("行 class 改名 → clearCart 不许判「已清空」", code, "PLUGIN_INTERNAL");
    check("这条错误说的是「行选择器坏了」", msg.includes("解析不出 ASIN"), msg);
  });

await withDriverOnCart("cart.html",
  (html) => html.replaceAll('<div class="sc-list-item" data-asin=',
                            '<div class="sc-list-item" data-item-asin='),
  async (run) => {
    const [code, msg] = await run(CLEAR_CART_DRILL);
    eq("行上的 data-asin 换属性名 → clearCart 不许判「已清空」", code, "PLUGIN_INTERNAL");
    check("这条错误同样说的是「行选择器坏了」", msg.includes("解析不出 ASIN"), msg);
  });

// 自相矛盾的一页:空车横幅**画出来了**,而在售区里同时看得见解析不出的商品行。
// 这时候「车是空的」是危险的那个结论(判错了就拿脏车去结算),所以
// 「看得见行却解析不出」这条判据必须排在空车标志前面。
await withDriverOnCart("cart.html",
  (html) => html
    .replaceAll('<div class="sc-list-item" data-asin=', '<div class="sc-list-item" data-item-asin=')
    .replace('<div id="sc-empty-cart" class="aok-hidden">', '<div id="sc-empty-cart">'),
  async (run) => {
    const [code, msg] = await run(CLEAR_CART_DRILL);
    eq("空车横幅与看得见的商品行同时成立 → 以「读不懂」为准,不判已清空",
       code, "PLUGIN_INTERNAL");
    check("这条错误说的仍是「行选择器坏了」", msg.includes("解析不出 ASIN"), msg);
  });

// 反面:真空车页必须能顺利返回。少了这一条,上面那几条断言可能只是
// 「clearCart 现在总是抛」——那是另一种坏法。
// 这一页的在售区里还躺着一份**隐藏的**行模板:rowsSeen 要是把它数进去,
// 这条就会转红 —— 一辆真空车被说成「行选择器坏了」,每一单都进研发的队列。
await withDriverOnCart("cart-empty.html", (html) => html, async (run) => {
  const [code, msg] = await run(CLEAR_CART_DRILL);
  check("真空车页(在售区里有隐藏行模板)→ clearCart 正常返回", code === "没抛", `${code} ${msg}`);
});

// ── 「车是空的」与「行容器的选择器坏了」 ─────────────────────────────
//
// 两者都是 0 行,而处置正相反:前者可以继续,后者意味着我们对购物车一无所知,
// 再往下走就是拿上一单的残留去结算。原先 readCartLines 把两者压成同一个 []。
//
// 这几张 DOM 是现造的:它们要表达的只有「容器在不在」「空车标志在不在」,
// 不值得各建一张夹具(与上面 nav 那几条同一个做法)。
await withFixture("cart-empty.html", async (run) => {
  const parse = (html, expr) =>
    run(`(() => { const d = new DOMParser().parseFromString(${JSON.stringify(html)}, "text/html");
                 return ${expr}; })()`);

  // Amazon 把 data-name="Active Items" 改名(或改版把它拆了)。
  // 车里其实还有一件,而我们读出 0 行 —— 这一位就是唯一的区别。
  const renamed = `<div id="sc-active-cart"><div data-name="Active Cart Items">
      <div class="sc-list-item" data-asin="B0FB3VS68J"><span data-a-selector="value">1</span></div>
    </div></div>`;
  eq("cart 容器改名 → 0 行,但 scopeFound=false",
     await parse(renamed, "amzdom.readCartState(d)"),
     { lines: [], scopeFound: false, rowsSeen: 0 });
  eq("cart 容器改名时页面上确实还有一行(干扰项确实存在)",
     await parse(renamed, `d.querySelectorAll(".sc-list-item").length`), 1);

  // 容器改名不是唯一一种「读不懂」,而 scopeFound 只覆盖了这一种。
  // 行 class 改掉、或者行上的 data-asin 换个属性名(与容器改名同一量级、
  // 同一概率的改版),容器**照样在** → scopeFound 说不出任何问题、lines 照样是 0
  // → 「容器在而 0 行 = 真的空了」这句话不成立,而车里还留着上一单的东西。
  const rowClassRenamed = `<div id="sc-active-cart"><div data-name="Active Items">
      <div class="sc-item-row" data-asin="B0FB3VS68J"><span data-a-selector="value">1</span></div>
      <div class="sc-item-row" data-asin="B0CHXNPXVX"><span data-a-selector="value">3</span></div>
    </div></div>`;
  eq("行 class 改名 → 0 行、容器还在,但看得见 2 个商品行",
     await parse(rowClassRenamed, "amzdom.readCartState(d)"),
     { lines: [], scopeFound: true, rowsSeen: 2 });

  const asinRenamed = `<div id="sc-active-cart"><div data-name="Active Items">
      <div class="sc-list-item" data-item-asin="B0FB3VS68J"><span data-a-selector="value">1</span></div>
      <div class="sc-list-item" data-item-asin="B0CHXNPXVX"><span data-a-selector="value">3</span></div>
    </div></div>`;
  eq("行上的 data-asin 换属性名 → 同样是 0 行、容器还在、看得见 2 个商品行",
     await parse(asinRenamed, "amzdom.readCartState(d)"),
     { lines: [], scopeFound: true, rowsSeen: 2 });

  // 两条判据取并集的意义:一种改版瞎掉一条,另一条还在数。
  // 少了这一条断言,rowsSeen 只按 .sc-list-item 数也能让上面两条里的一条过。
  eq("行 class 改名那一页上,按 .sc-list-item 数是 0(所以 rowsSeen 不能只按它数)",
     await parse(rowClassRenamed, `d.querySelectorAll(".sc-list-item").length`), 0);
  eq("data-asin 换名那一页上,按 [data-asin] 数是 0(所以 rowsSeen 不能只按它数)",
     await parse(asinRenamed, `d.querySelectorAll("[data-asin]").length`), 0);

  // #sc-active-cart 曾经被算作「空车标志」。它是购物车页的**外层容器** ——
  // 空车、满车、还在加载都有它。一个在车满时也成立的「空车标志」等于没有,
  // 而它看起来在。现在它只属于 cartRendered。
  eq("#sc-active-cart 不再算空车标志",
     await run(`amzdom.SEL.cart.emptyMarkers.includes("#sc-active-cart")`), false);
  eq("#sc-active-cart 属于「页面渲染出来了」这一组",
     await run(`amzdom.SEL.cart.cartRendered.includes("#sc-active-cart")`), true);
  eq("容器改名的那一页上,空车标志一条都不成立",
     await parse(renamed, `amzdom.SEL.cart.emptyMarkers.some((m) => d.querySelector(m))`), false);
  eq("容器改名的那一页上,渲染门照样成立(所以渲染门证明不了车是空的)",
     await parse(renamed, `amzdom.SEL.cart.cartRendered.some((m) => d.querySelector(m))`), true);

  // 反过来:真空车页有确凿的空车标志,那才是「车是空的」的正面证据
  const trulyEmpty = `<div id="sc-active-cart">
      <h1 class="sc-your-amazon-cart-is-empty">Your Amazon Cart is empty</h1></div>`;
  eq("真空车页有确凿的空车标志",
     await parse(trulyEmpty, `amzdom.SEL.cart.emptyMarkers.some((m) => d.querySelector(m))`), true);
});

// ── 购物车删除控件:厂商在产线上用的是**图标**形态 ────────────────────
//
// 我们原来那四条全是文字按钮形态(`input[value="Delete"]` 等,注释自己写着
// 「按常见形态推测」),而 cart.html 也只造了那一种 —— 断言永远绿、线上一条不中。
// 实测(SP/wf/cart_delete_probe.mjs):按厂商形态造的图标购物车上我们全落空,
// clearCart 第一轮就抛 PLUGIN_INTERNAL,车里的东西原样留着;
// 而按「失败必上报、必清车」,清车失败会连带废掉后面每一单。
await withFixture("cart-icon-delete.html", async (run) => {
  eq("cart-icon-delete 读到三行", await run("amzdom.readCartLines(document).length"), 3);

  // 逐行断言:三种形态各自都要能选出控件,而且选出来的是**这一行自己的**那个
  eq("cart 删除控件:垃圾桶图标(厂商 v253:687)",
     await run(`(() => {
        const row = document.querySelector('[data-asin="B0FB3VS68J"]');
        const el = amzdom.pickFirstRendered(row, amzdom.SEL.cart.deleteButtons);
        return el ? el.className : null;
     })()`), "a-icon a-icon-small a-icon-small-trash");
  eq("cart 删除控件:移除图标(厂商 v253:690)",
     await run(`(() => {
        const row = document.querySelector('[data-asin="B0CHXNPXVX"]');
        const el = amzdom.pickFirstRendered(row, amzdom.SEL.cart.deleteButtons);
        return el ? el.className : null;
     })()`), "a-icon a-icon-small a-icon-small-remove");
  eq("cart 删除控件:.sc-action-delete-active input(注意 -active,厂商 v253:701)",
     await run(`(() => {
        const row = document.querySelector('[data-asin="B0C7KN2M4P"]');
        const el = amzdom.pickFirstRendered(row, amzdom.SEL.cart.deleteButtons);
        return el ? [el.tagName, el.parentElement.className] : null;
     })()`), ["INPUT", "sc-action-delete-active"]);

  // 我们原先那条 `.sc-action-delete input`(不带 -active)在这张页上选不中
  eq("旧写法 .sc-action-delete input 在这张页上确实落空(干扰项确实存在)",
     await run(`document.querySelectorAll(".sc-action-delete input").length`), 0);

  // 隐藏模板里有一个 input[value="Delete"](我们旧判据里排最前的那条),
  // 排在整份文档最前面。不过 isRendered 的话会先点到它 —— 点了不生效,
  // 然后「购物车行数减少」等满 10 秒。
  eq("cart 隐藏模板里的 Delete 按钮确实存在且排在最前(干扰项确实存在)",
     await run(`(() => {
        const all = [...document.querySelectorAll('input[value="Delete"]')];
        return [all.length, all[0].closest("[style]")?.getAttribute("style")];
     })()`), [1, "display:none"]);
  eq("cart 在整页上选删除控件时不会选到隐藏模板里那个",
     await run(`(() => {
        const el = amzdom.pickFirstRendered(document, amzdom.SEL.cart.deleteButtons);
        return el ? el.className : null;
     })()`), "a-icon a-icon-small a-icon-small-trash");

  // 顺序也是判据的一部分:结构判据在前、文案判据垫底
  eq("cart 删除控件是有序数组,厂商三条在前",
     await run("amzdom.SEL.cart.deleteButtons.slice(0, 3)"),
     [".a-declarative > .a-icon.a-icon-small-trash",
      ".a-declarative > .a-icon.a-icon-small-remove",
      ".sc-action-delete-active input"]);
  eq("cart 英文文案判据 input[value=\"Delete\"] 垫在最后",
     await run(`amzdom.SEL.cart.deleteButtons[amzdom.SEL.cart.deleteButtons.length - 1]`),
     'input[value="Delete"]');
});

// ── 结算页 ──────────────────────────────────────────────────────────
await withFixture("checkout.html", async (run) => {
  const panels = await run("amzdom.readCheckoutPanels(document)");
  check("checkout 面板数 > 0", panels.length > 0, String(panels.length));
  check("checkout 过滤掉了没有 lineitem-container 的空壳面板",
        panels.every((p) => p.asin || p.unitPrice), JSON.stringify(panels));
  check("checkout 每个面板都读到了 ASIN",
        panels.every((p) => /^(B0\w{8}|\d{10}|\d{9}X)$/.test(p.asin ?? "")),
        JSON.stringify(panels.map((p) => p.asin)));
  check("checkout 读到了带千分位的单价",
        panels.some((p) => p.unitPrice && Number(p.unitPrice) > 1000),
        JSON.stringify(panels.map((p) => p.unitPrice)));
  check("checkout 认出了 Amazon 发货的面板",
        panels.some((p) => p.isFba === true), JSON.stringify(panels.map((p) => p.shipper)));
  check("checkout 认出了第三方发货的面板",
        panels.some((p) => p.isFba === false), JSON.stringify(panels.map((p) => p.shipper)));
  check("checkout 每个面板都有交期文案",
        panels.every((p) => p.deliveryText), JSON.stringify(panels.map((p) => p.deliveryText)));

  // **断到值,不是断「非空」。** 原先这几条是 `!!x` / `!== undefined` ——
  // 干扰项 F 那个隐藏粘性底栏里的过期值($1,299.99)一样能过,而它正是这几个
  // 选择器最可能读错的东西。「看起来有测试盯着」是本项目反复记着的那种缺陷。
  eq("checkout 订单总额读的是 #checkout-pyo-button-block 里那个",
     await run("amzdom.readGrandTotal(document)"), "2241.86");

  const summary = await run("amzdom.readOrderSummary(document)");
  eq("checkout 按 label 扫到运费", summary.shipping, "12.99");
  eq("checkout 按 label 扫到税费", summary.tax, "180.38");
  eq("checkout 按 label 扫到税前合计", summary.beforeTax, "2061.48");
  // 这一条在收窄扫描范围之前是红的:全文档扫先命中 #checkout-sticky-summary
  // (display:none,排在真表**之前**)里的过期值 1299.99。
  eq("checkout 小结的 Order total 不是隐藏粘性底栏里的过期值",
     summary.orderTotal, "2241.86");
  // 干扰项确实存在:那个过期值真的在文档里、真的排在前面、真的是隐藏的
  eq("checkout 隐藏粘性底栏确实排在真表前面且是隐藏的(干扰项确实存在)",
     await run(`(() => {
        const cells = [...document.querySelectorAll(".grand-total-cell")];
        const first = cells[0];
        return [cells.length, first.textContent.trim(),
                first.closest("[style*='display:none']") !== null];
     })()`), [2, "$1,299.99", true]);

  // **「限容器」这半此前没有任何断言单独盯着。** 把 summaryTables 那个循环整个
  // 删掉,全部断言照样绿(逐行 isHidden 一个人就把干扰项 F 兜住了)。于是往清单里
  // 混进一条**根本不装小结行**的容器也没人会发现:#checkout-pyo-button-block
  // 是下单按钮那个盒子,厂商拿它只取 .grand-total-cell(v2.5.3 :2473),
  // 从不用来扫小结行。它一旦命中,root 就从「文档」收窄成「按钮盒」,
  // 运费/税费对每一单都读成 undefined,落库 NULL,导出两列全空,还不报错 ——
  // 一条本该防改版的措施,自己成了改版当天的单点。
  //
  // 这一条钉的就是它:两张 subtotals 表的 id 都被改掉时(正是收窄想防的那件事),
  // 必须退回文档级、照样读得出来。
  eq("checkout 小结表 id 被改掉时退回文档级,运费税费照样读得出",
     await run(`(() => {
        const t = document.querySelector("#subtotals-marketplace-table");
        t.id = "subtotals-v2";
        const got = amzdom.readOrderSummary(document);
        t.id = "subtotals-marketplace-table";       // 原样放回,不影响后面的断言
        return [got.shipping, got.tax, got.orderTotal];
     })()`), ["12.99", "180.38", "2241.86"]);

  // 夹具的支付文案里故意先出现别的 4 位数,取"第一个 4 位数字"的写法会当场露馅;
  // 另有一个隐藏的同 id 副本(尾号 0000)排在真身前面,裸 querySelector 会读成 0000
  eq("checkout 卡后四位取的是 ending in 后面那个",
     await run("amzdom.readPaymentLast4(document)"), "4417");
  eq("checkout 隐藏的同 id 支付副本确实排在前面(干扰项确实存在)",
     await run(`(() => {
        const all = [...document.querySelectorAll("#payment-option-text-default")];
        return [all.length, /0000/.test(all[0].textContent),
                all[0].closest("[style*='display:none']") !== null];
     })()`), [2, true, true]);

  // 这一单没用礼品卡,但页面自带一个**隐藏的小结模板**,里面有一条抵扣行
  // (干扰项 F-2)。可见性判在 marker 上、或者干脆不判,这里就会判出
  // 「用了礼品卡但读不出金额」—— 而那一档服务端是拒的,于是每张普通单都被拦下。
  eq("checkout 隐藏模板里的礼品卡行不算数 → applied=false",
     await run("amzdom.readGiftCardDeduction(document)"), { applied: false });
  eq("checkout 隐藏模板里确实有一条抵扣标记(干扰项确实存在)",
     await run(`(() => {
        const m = document.querySelector(
          'input[name="subtotalLineType"][value="SPECIAL_PAYMENTS_GIFT_CARD_BALANCE"]');
        return [!!m, m.closest("[style*='display:none']") !== null];
     })()`), [true, true]);

  // #submitOrderButtonId 里排在前面的是隐藏的 anti-csrftoken-a2z。
  // 后代选择器会选中它 —— click() 打在隐藏 input 上不报错也不跳转,
  // 于是等满 60 秒抛 ORDER_CONFIRM_TIMEOUT,任务落进「可能已下单」桶,
  // 运营被迫逐单登录买家号确认一个根本不存在的订单。
  eq("checkout 下单按钮不是隐藏的 csrf input",
     await run("amzdom.findSubmitOrderButton(document)?.type"), "submit");
  eq("checkout 下单按钮不带 name=anti-csrftoken-a2z",
     await run("amzdom.findSubmitOrderButton(document)?.getAttribute('name')"), null);

  // ── 「更改支付方式」入口(所有者定稿①:替买家号切卡)────────────────
  //
  // 三条判据按序试,逐条摘掉看后备接不接得住。一条失效时静默落空的表现是
  // 「入口没找到」等满一个预算,而真实原因是"还有两条备胎没被试到"。
  eq("checkout 更改支付入口三形态按序命中、全摘掉才落空",
     await run(`(() => {
        const ids = ["pay-entry-a", "pay-entry-b", "pay-entry-c"];
        const saved = ids.map((id) => {
          const el = document.getElementById(id);
          return { el, parent: el.parentElement, next: el.nextSibling };
        });
        const got = [];
        got.push(amzdom.findPaymentChangeEntry(document)?.id ?? null);
        for (const s of saved) {
          s.el.remove();
          got.push(amzdom.findPaymentChangeEntry(document)?.id ?? null);
        }
        // 原样放回,不影响后面的断言
        for (const s of saved) s.parent.insertBefore(s.el, s.next);
        return got;
     })()`), ["pay-entry-a", "pay-entry-b", "pay-entry-c", null]);

  // 最后那个 null 说的就是这件事:面板**外面**那个一模一样的 href 不算数。
  // 它把 iframe 导到钱包页,从那里回不到结算页 —— 而失败原因会显示成
  // 「切完读到的仍不是期望」,和"点错了链接"完全不是一回事。
  eq("checkout 面板外的同 href 入口确实存在(干扰项确实存在)",
     await run(`(() => {
        const out = document.querySelector("#pay-entry-outside");
        const panel = document.querySelector("#checkout-payment-option-panel");
        return [!!out, panel.contains(out),
                out.matches('a[href*="/pay?"][href*="redirectReason=ChangePaymentMethod"]')];
     })()`), [true, false, true]);

  // 隐藏的模板入口排在三个真身**前面**,而且它命中的是第二条判据。
  // 裸 querySelector 会取到它,click() 打在隐藏 a 上不报错也不跳转。
  eq("checkout 隐藏的模板入口没被选中(干扰项确实存在)",
     await run(`(() => {
        const ghost = document.querySelector("#pay-entry-ghost");
        const all = [...document.querySelectorAll('a[href*="toPage=payselect"]')];
        return [all[0].id, ghost.closest("[style*='display:none']") !== null,
                amzdom.findPaymentChangeEntry(document).id];
     })()`), ["pay-entry-ghost", true, "pay-entry-a"]);
});

// 礼品卡抵扣的几个边界:用 DOMParser 现造,不值得为它们各建一张夹具。
// 借 checkout.html 只是为了有个页面环境,断言与那张夹具的内容无关。
await withFixture("checkout.html", async (run) => {
  const MARK = '<input type="hidden" name="subtotalLineType" '
             + 'value="SPECIAL_PAYMENTS_GIFT_CARD_BALANCE">';
  const row = (amount) =>
    `<table><tr class="order-summary-grid"><td class="order-summary-line-definition">`
    + MARK + (amount === null ? "" : `<span class="aok-nowrap">${amount}</span>`)
    + `</td></tr></table>`;
  const gift = (html) =>
    run(`amzdom.readGiftCardDeduction(
           new DOMParser().parseFromString(${JSON.stringify(html)}, "text/html"))`);

  // 抵扣额是个**量**,正负号是排版。两种写法都出现过,而 parseMoney 的正则
  // 只认紧贴数字的负号:"-$5.09" 丢符号读成 5.09,"$-5.09" 读成 -5.09。
  // 不显式取绝对值的话,后一种会把货款算**小**(0 + (-5.09) = -5.09)。
  eq("礼品卡 负号在 $ 前", await gift(row("-$5.09")), { applied: true, amount: "5.09" });
  eq("礼品卡 负号在 $ 后", await gift(row("$-5.09")), { applied: true, amount: "5.09" });

  // **认出抵扣行却读不出金额时是 undefined,不是 "0"。**
  // 返回 0 的话货款基数会等于实付,护栏又一次比错了数,而且这次连痕迹都没有。
  eq("礼品卡 有标记读不到金额 → amount 是 undefined 而不是 0",
     await gift(row(null)), { applied: true });

  // 一张页面上可能有多条(礼品卡 + 账户余额),要累加而不是取第一条
  eq("礼品卡 多条抵扣行累加",
     await gift(row("-$5.09") + row("-$10.00")), { applied: true, amount: "15.09" });

  eq("礼品卡 没有标记 → applied=false",
     await gift("<table><tr><td>Order total: $10.00</td></tr></table>"), { applied: false });
});

// ── 支付选择页 payselect · 替买家号切卡(所有者定稿①)────────────────
//
// ⚠️⚠️ **这一节的通过不构成证据。** 夹具 payselect.html 是照厂商 v2.5.3
// :2081-2144 那 17 条判据造的,而厂商自己承认那一页他们**只有截图、没有 DOM
// 样本**。跑通只说明我们按自己写的语义在读,不说明真实页面长这样。
//
// 这一节验的是另一件事:**fail-closed 兜不兜得住**。下面每一条对应一种
// 「按厂商的写法会选错卡」的现场,而选错卡的后果不是这一单失败,
// 是拿别人的卡付了钱 —— 所以判据不满足时必须返回 null(调用方据此不点确认)。
await withFixture("payselect.html", async (run) => {
  const hit = (last4, prop = "radio.id") =>
    run(`amzdom.findCardRadioByLast4(document, ${JSON.stringify(last4)})?.${prop} ?? null`);

  // ① 唯一命中。这张卡自己没有 .pmts-instrument-box,走的是「向上爬找最小块」
  //    那条路 —— 它的 closest(容器候选) 命中的是整个列表(四个 radio)。
  eq("payselect 唯一命中尾号 4417", await hit("4417"), "radio-4417");
  eq("payselect 命中的块是最小块、不是整个列表(向上爬那一段真的走了)",
     await run(`(() => {
        // 可选链是必要的:这一条转红时该报「期望 X 实际 null」,
        // 而不是抛一个 TypeError 把后面几十条断言一起带走 ——
        // 崩掉的测试和红掉的测试,看的人得到的信息不是一回事。
        const h = amzdom.findCardRadioByLast4(document, "4417");
        return [h?.block?.tagName ?? null,
                h?.block?.contains(document.querySelector("#radio-9021-mc")) ?? null];
     })()`), ["LABEL", false]);
  eq("payselect 命中的是细节元素里那一段文字(不是整块)",
     await hit("4417", "matchedText"), "Visa ending in 4417");
  eq("payselect 卡 4417 的 closest(容器候选) 确实是四个 radio 的大壳(干扰项确实存在)",
     await run(`(() => {
        const r = document.querySelector("#radio-4417");
        const box = r.closest('.pmts-instrument-box, [data-pmts-instrument-id],'
                            + ' [data-pmts-component-id*="instrument"], [class*="instrument-row"]');
        return [box.id, box.querySelectorAll('input[type="radio"]').length];
     })()`), ["instrument-list", 4]);

  // ② 容器候选那条路:这张卡有 .pmts-instrument-box,不必往上爬。
  eq("payselect 唯一命中尾号 3005(块里没有细节元素,退回整块比)",
     await hit("3005"), "radio-3005");

  // ③ 年份诱饵。卡 4417 那一块里写着 "Expires 08/2029",卡 3005 那一块里
  //    写着 "Expires 09/2030"。不抹有效期的话这两个年份都会被当成尾号 ——
  //    服务端那道闸事后拦得住,但事件流里会留下「支付卡已切换 → 2029」这句假话。
  //    两条路径(细节元素 / 退回整块)都要抹,所以两个年份都要验。
  eq("payselect 年份诱饵:2029 不能当尾号(细节元素那条路)", await hit("2029"), null);
  eq("payselect 年份诱饵:2030 不能当尾号(退回整块那条路)", await hit("2030"), null);
  eq("payselect 两个年份确实在页面上(干扰项确实存在)",
     await run(`(() => {
        const t = document.querySelector("#instrument-list").textContent;
        return [/Expires 08\\/2029/.test(t), /Expires 09\\/2030/.test(t)];
     })()`), [true, true]);
  // 抹掉的只是"月/年"那一段,不是所有四位数 —— 4417 自己还在。
  eq("payselect 抹有效期没有把真尾号一起抹掉", await hit("4417"), "radio-4417");

  // ④ 同尾号两张卡 → **一张都不点**。厂商在第一个命中处就 return,
  //    而两张卡是两个账、两笔额度、甚至两个持卡人。
  eq("payselect 两张卡都是 9021 时返回 null(不敢挑)", await hit("9021"), null);
  eq("payselect 确实有两张 9021(干扰项确实存在)",
     await run(`[...document.querySelectorAll('[data-testid="method-details-number"]')]
                  .filter((e) => /9021/.test(e.textContent)).length`), 2);

  // ⑤ 隐藏模板里那张 4417 不算数。算的话 4417 就成了"两张命中"→ null,
  //    这个买家号从此一单也切不了卡;点中它的话,click() 打在隐藏 radio 上
  //    不报错也不生效,然后等满预算报一句"切完读到的仍不是期望"。
  eq("payselect 隐藏模板里的 4417 不算数(干扰项确实存在)",
     await run(`(() => {
        const t = document.querySelector("#radio-template");
        return [!!t, t.closest("[style*='display:none']") !== null,
                [...document.querySelectorAll('input[name="ppw-instrumentRowSelection"]')].length];
     })()`), [true, true, 5]);

  // ⑥ 期望尾号本身不是四位数字 → 一律 null,不猜。这一列是人在运营台上手填的。
  eq("payselect 期望值不是四位数字时不猜:'**** 4417'", await hit("**** 4417"), null);
  eq("payselect 期望值不是四位数字时不猜:'441'", await hit("441"), null);
  eq("payselect 期望值为空时不猜", await hit(""), null);

  // ⑦ 确认按钮:先 disabled(不可点)后可用。两种状态必须给出两种结果 ——
  //    click() 打在 disabled 按钮上返回 true 而浏览器不派发事件,
  //    「点过了」和「没点动」长成同一个结果正是这条断言要防的。
  eq("payselect 确认按钮 disabled 时是 null",
     await run("amzdom.findPaymentConfirmButton(document)?.id ?? null"), null);
  eq("payselect 摘掉 disabled 之后拿得到、而且不是隐藏那个",
     await run(`(() => {
        const real = document.querySelector("#ppw-confirm");
        real.removeAttribute("disabled");
        const got = amzdom.findPaymentConfirmButton(document)?.id ?? null;
        real.setAttribute("disabled", "");          // 原样放回
        return got;
     })()`), "ppw-confirm");
  eq("payselect 隐藏的确认按钮副本没 disabled、且排在真身前面(干扰项确实存在)",
     await run(`(() => {
        const all = [...document.querySelectorAll(
          '[name="ppw-widgetEvent:SetPaymentPlanSelectContinueEvent"]')];
        return [all.length, all[0].id, all[0].disabled,
                all[0].closest("[style*='display:none']") !== null];
     })()`), [2, "ppw-confirm-ghost", false, true]);

  // ⑧ 支付选择页上没有结算页的支付面板 —— findPaymentChangeEntry 在这里必须是
  //    null,不许退到文档级去乱找一个 a。
  //    干扰项 F 就是为这一条摆的:页脚有一个**文档级命中得了**的同 href 入口。
  //    没有它的话,这条断言只说明"这一页上没有能命中三条判据的元素",
  //    「拿不到面板就 null」那一句退化成文档级也照样绿 —— 而那一支的后果是
  //    把 iframe 导去钱包页,再也回不到结算页。
  eq("payselect 这一页没有结算页支付面板 → 更改入口是 null",
     await run("amzdom.findPaymentChangeEntry(document)"), null);
  eq("payselect 页脚那个文档级能命中的入口确实存在(干扰项确实存在)",
     await run(`(() => {
        const out = document.querySelector("#footer-pay-entry");
        return [!!out, !!document.querySelector(amzdom.SEL.checkout.payment.panel),
                amzdom.pickFirstRendered(document, amzdom.SEL.checkout.payment.changeEntry)?.id ?? null];
     })()`), [true, false, "footer-pay-entry"]);
});

// ── 切卡这五步:分支与取法,不只是判据 ────────────────────────────────
//
// 上面那一节验的是纯函数。这一节验的是 amazon.ts **怎么用**它们 ——
// 与清车那一节同一个理由:判据的内容有断言盯着,取法与分支一条都没有。
// 这一整段(五步、五种停法、guardLogin、radiosBefore 对照、期望非四位数字抛错)
// 之前**一条断言都没有**:单测用的是假驱动,smoke 用的是模拟驱动,
// DOM 断言只覆盖三个纯函数 —— 「五步有界、五种停法分得开」是提交说明里的一句话,
// 不是被验过的事。
//
// 为什么这几条值得单写:切卡的失败落的是 PAYMENT_METHOD_UNEXPECTED,归
// BUSINESS_BLOCKED、不在 RETRYABLE 里、也不上报 signed_out。切卡途中会话过期
// 的表现在这五步里全是「等不到」,少了那句 guardLogin,一台已经被登出的机器
// 会照样认领下一单、照样死在同一步,把整队单子刷成「支付卡不符」,
// 而运营看到这个码只会去查买家号钱包里的卡 —— 查不出任何问题。

const CHECKOUT_URL = "https://www.amazon.com/gp/buy/spc/handlers/display.html";
const PAYSELECT_URL = "https://www.amazon.com/gp/buy/payselect/handlers/display.html?toPage=payselect";

/** 让真驱动在结算页夹具上走一遍切卡。
 *
 *  `cards`      点入口**之前**页面上就摆着的卡(尾号数组)。
 *  `onClickAdd` 第一次点击(那一次点的就是「更改支付方式」入口)时**再**添一张卡 ——
 *               专门给「radiosBefore 记在 click 之前还是之后」当判据。
 *  `confirm`    摆不摆一个可点的确认按钮。
 *  `startUrl` / `afterUrl`  入口点下去之前/之后的 URL(afterUrl 为空 = 点完不变)。
 *  `signOut`    途中把 URL 换成 /ap/signin —— 那就是「切到一半会话过期」的现场。
 *  `hideEntries` 把支付面板里那三个真入口一并隐掉(跑完原样放回)——
 *               第 ① 步「入口没找到」的现场。夹具是共享的,所以只隐不删。
 *
 *  返回 [LoginLost / 错误码 / "裸Error" / "没抛", 文案]。 */
const cardSwitchDrill = ({ cards = [], onClickAdd = null, confirm = false,
                           startUrl = PAYSELECT_URL, afterUrl = "", signOut = false,
                           hideEntries = false }) => `(async () => {
  // **这张夹具是共享的**:同一个页面跑完这一节所有断言。上一轮 append 进去的
  // 卡片和按钮不清掉的话,下一轮的「唯一命中」会被上一轮那张同尾号的卡打掉 ——
  // 断言仍然是绿的(码还是 PAYMENT_METHOD_UNEXPECTED),但停的地方悄悄换了一处,
  // 验的东西就变成了另一件事。带记号 append,开头一律先删干净。
  for (const el of [...document.querySelectorAll("[data-drill]")]) el.remove();

  const mkCard = (last4) => {
    const box = document.createElement("div");
    box.className = "pmts-instrument-box";
    box.setAttribute("data-drill", "1");
    box.innerHTML = '<label><input type="radio" name="ppw-instrumentRowSelection">'
                  + '<span class="pmts-instrument-number-tail">ending in ' + last4 + '</span></label>';
    document.body.appendChild(box);
  };
  ${JSON.stringify(cards)}.forEach(mkCard);
  if (${confirm}) {
    const btn = document.createElement("input");
    btn.type = "submit";
    btn.setAttribute("data-drill", "1");
    btn.name = "ppw-widgetEvent:SetPaymentPlanSelectContinueEvent";
    document.body.appendChild(btn);
  }

  let url = ${JSON.stringify(startUrl)};
  let clicks = 0;
  // 夹具里那三个入口都是真 <a href>。这一段验的是驱动的分支,不是浏览器的导航,
  // 所以一律拦下默认动作 —— 让这一页真跳走的话什么都验不成。
  // 上一轮的监听器要摘掉:留着的话页面上会堆一串闭包,谁在改 url 就看不清了。
  if (window.__drillClick) document.removeEventListener("click", window.__drillClick, true);
  window.__drillClick = (e) => {
    e.preventDefault();
    clicks += 1;
    if (clicks !== 1) return;          // 第一次点的必然是「更改支付方式」入口
    if (${JSON.stringify(afterUrl)}) url = ${JSON.stringify(afterUrl)};
    if (${JSON.stringify(onClickAdd)}) mkCard(${JSON.stringify(onClickAdd)});
  };
  document.addEventListener("click", window.__drillClick, true);

  // 期望切到 9021。checkout.html 当前选中的是 4417(下面第一条断言),
  // 两个数不一样,这一段才会真的往下走而不是在「本来就是那张」处早退。
  // 300ms:这五步共用的预算调到测试量级,否则一条断言要等 30 秒。
  const driver = new amzdom.AmazonDriver("https://www.amazon.com", { paymentSelect: 300 });
  // checkout 在 TS 里是私有的,这里**故意**从外面摆好(与 fillAddress 那一段
  // 同一个做法):要验的是这五步的分支,而走公开路径得先有一个真的结算 iframe。
  driver.checkout = { el: null, doc: () => document, url: () => url,
                      urlState: () => ({ kind: "ok", url }), close() {} };
  ${signOut ? `setTimeout(() => { url = "https://www.amazon.com/ap/signin"; }, 20);` : ""}

  // 第 ① 步的现场:面板还在,里面三个真入口一个都不渲染。**只隐不删**,
  // 跑完原样放回 —— 这张夹具后面还有别的断言在用。
  const hidden = ${hideEntries}
    ? [...document.querySelectorAll("#pay-entry-a, #pay-entry-b, #pay-entry-c")] : [];
  hidden.forEach((e) => { e.style.display = "none"; });

  try { await driver.ensurePaymentCard("9021"); return ["没抛", ""]; }
  catch (e) {
    return [e instanceof amzdom.LoginLostError ? "LoginLost" : (e.code ?? "裸Error"),
            String(e.message ?? "")];
  }
  finally { hidden.forEach((e) => { e.style.display = ""; }); }
})()`;

/** 三步各自的现场:③ 一张卡都没有 ④ 有唯一那张、没有确认按钮 ⑤ 两样都有、但切不过去。 */
const STAGE = {
  3: { cards: [] },
  4: { cards: ["9021"] },
  5: { cards: ["9021"], confirm: true },
};
const STOPS = { 3: "没有唯一命中的那张卡", 4: "确认按钮不可用", 5: "切完读到的仍不是期望" };

await withFixture("checkout.html", async (run) => {
  // 前提:这张夹具当前选中的不是 9021 —— 否则下面几条走的是「本来就是那张」的早退,
  // 一步都不会执行,而断言照样绿。
  eq("切卡演练的前提:结算页当前选中的是 4417,不是 9021",
     await run("amzdom.readPaymentLast4(document)"), "4417");

  // ③④⑤ 三步:会话在切卡途中过期 → 必须是 LoginLostError(这一单退回队列、
  // 这台机器停止派单),不是 PAYMENT_METHOD_UNEXPECTED(不可重试的拍单异常)。
  for (const stage of [3, 4, 5]) {
    const [code] = await run(cardSwitchDrill({ ...STAGE[stage], signOut: true }));
    eq(`切卡第${stage}步等不到时先问一句登录态(被登出 → LoginLost,不是支付卡不符)`,
       code, "LoginLost");
  }

  // 对照:同样三步,没被登出时必须仍然是那三种停法 —— guardLogin 只是加一道问,
  // 不许把正常的失败也吞成「被登出」。两种不同的情况要渲染出两个结果。
  for (const stage of [3, 4, 5]) {
    const [code, msg] = await run(cardSwitchDrill({ ...STAGE[stage] }));
    eq(`切卡第${stage}步没被登出时照旧落 PAYMENT_METHOD_UNEXPECTED`,
       code, "PAYMENT_METHOD_UNEXPECTED");
    check(`切卡第${stage}步停在「${STOPS[stage]}」`, msg.includes(STOPS[stage]), msg);
  }

  // ── 第 ① 步:面板在、面板里一个渲染出来的入口都没有 ────────────────────
  //
  // 这一支同样是「等满一个预算」,所以同样先问登录态。而它与第 ② 步必须分得开:
  // 「入口没找到」是结算页那一侧改版(要改 payment.changeEntry),
  // 「选卡页没到」是点了但没跳走 —— 两件事的处置完全不同,
  // 而它们今天共用一个错误码,detail 里那句话是运营台上唯一能把它们分开的东西。
  {
    const [code, msg] = await run(cardSwitchDrill({ hideEntries: true }));
    eq("切卡第1步:面板里三个入口都不渲染 → 停在「入口没找到」",
       [code, msg.includes("入口没找到")], ["PAYMENT_METHOD_UNEXPECTED", true]);
    const [lost] = await run(cardSwitchDrill({ hideEntries: true, signOut: true }));
    eq("切卡第1步等不到时先问一句登录态(被登出 → LoginLost)", lost, "LoginLost");
    // 隐掉的那三个必须原样放回 —— 不放回的话,后面每一条断言验的都是另一张页面。
    eq("切卡第1步演练之后,三个入口原样放回",
       await run(`amzdom.findPaymentChangeEntry(document)?.id ?? null`), "pay-entry-a");
  }

  // ── 第 ② 步那条对照判据:「从无到有」,不是「有」 ────────────────────
  //
  // 这是这五步里最微妙的一条,也是**故意选了会误伤的那一侧**的一条:
  // 结算页上本来就渲染着一份支付列表(折叠的、或者 Amazon 把选卡直接嵌在结算页上)
  // 时,只问「有没有 radio」在点之前就已经为真 —— 判据被我们还没离开的那张页面
  // 立刻满足,于是在一张不确定是什么的页面上点单选钮和确认按钮。填地址那一步
  // 踩过同一个坑(在还没跳走的结算页上点折叠容器里的按钮)。
  //
  // 代价是「本来就有 radio 且点完 URL 不变」会走失败分支。那一侧是选出来的,
  // 得有断言把它钉住 —— 改成只看 radioCount() > 0 的话,下面这一条会从
  // 「选卡页没到」变成「切完读到的仍不是期望」。
  {
    const [code, msg] = await run(cardSwitchDrill({
      cards: ["9021"], onClickAdd: "3333", confirm: true,
      startUrl: CHECKOUT_URL, afterUrl: "",      // 点完 URL 不变
    }));
    eq("切卡第2步:点之前就有 radio、点完 URL 不变 → 停在「选卡页没到」",
       [code, msg.includes("选卡页没到")], ["PAYMENT_METHOD_UNEXPECTED", true]);
    // radiosBefore 记在 click **之前**。记在之后的话这一句会变成「就有 2 个」——
    // 判据本身照样落空(失败分支不变),但看的人再也分不出「本来就有」还是
    // 「点完才有」,而这两件事一个是误伤、一个是真没跳走。
    check("切卡第2步 detail 里的对照数是点击**之前**那一笔(1 → 2)",
          msg.includes("点之前页面上就有 1 个,现在有 2 个"), msg);
  }
  {
    // 对照:一模一样的现场,只多一样 —— 点完 URL 跳到 payselect。
    // 这一条证明上面那次失败是「没跳走」判的,不是「页面上有两张卡」之类的别的原因。
    const [code, msg] = await run(cardSwitchDrill({
      cards: ["9021"], onClickAdd: "3333", confirm: true,
      startUrl: CHECKOUT_URL, afterUrl: PAYSELECT_URL,
    }));
    eq("切卡第2步:同一现场、点完 URL 跳到 payselect → 越过第2步,走到第5步",
       [code, msg.includes("切完读到的仍不是期望")], ["PAYMENT_METHOD_UNEXPECTED", true]);
  }
  {
    // ② 那道超时同样要先问登录态(与 ③④⑤ 同一条规矩)。
    const [code] = await run(cardSwitchDrill({
      cards: ["9021"], startUrl: CHECKOUT_URL, afterUrl: "", signOut: true,
    }));
    eq("切卡第2步等不到时先问一句登录态(被登出 → LoginLost)", code, "LoginLost");
  }

  // ── 期望值配成了别的形状 → **抛错**,不是静默不切 ───────────────────
  //
  // 「配了但无效」与「故意留空」渲染成同一个结果,是这套系统最不许有的那件事:
  // 一格填错的配置会让这个买家号从此每一单都不再过支付闸,而运营台上那一格
  // 看起来是配好了的。所以这一档必须抛,而且要在**碰页面之前**就抛。
  eq("期望值不是四位数字时抛错(不是静默退化成「不校验」),且一次 doc() 都没读",
     await run(`(async () => {
        const out = [];
        for (const v of ["441", "**** 4417", "44170", "4a17", "0"]) {
          const driver = new amzdom.AmazonDriver("https://www.amazon.com");
          let reads = 0;
          driver.checkout = { el: null,
                              doc: () => { reads += 1; throw new Error("iframe 拿不到 document"); },
                              url: () => "", urlState: () => ({ kind: "detached" }), close() {} };
          try { await driver.ensurePaymentCard(v); out.push(["没抛", reads]); }
          catch (e) { out.push([e.code ?? "裸Error",
                                reads, String(e.message ?? "").includes("不是四位数字")]); }
        }
        return out;
     })()`),
     [["PAYMENT_METHOD_UNEXPECTED", 0, true], ["PAYMENT_METHOD_UNEXPECTED", 0, true],
      ["PAYMENT_METHOD_UNEXPECTED", 0, true], ["PAYMENT_METHOD_UNEXPECTED", 0, true],
      ["PAYMENT_METHOD_UNEXPECTED", 0, true]]);

  // 期望为空 = 一步都不做,**连 doc() 都不碰**。
  // 结算 iframe 已跨域/已销毁时 doc() 是抛错的(frame.ts),而一个根本没配
  // 期望卡的买家号不该因为一个按定义什么都不做的步骤失败 —— 那会被 run.ts
  // 兜成 PLUGIN_INTERNAL,一个与支付毫无关系的买家号栽在支付这一步上。
  eq("期望为空:四种写法都是 {last4:null,switched:false},且一次 doc() 都没读",
     await run(`(async () => {
        const out = [];
        for (const v of [null, undefined, "", "   "]) {
          const driver = new amzdom.AmazonDriver("https://www.amazon.com");
          let reads = 0;
          driver.checkout = { el: null,
                              doc: () => { reads += 1; throw new Error("iframe 拿不到 document"); },
                              url: () => "", urlState: () => ({ kind: "detached" }), close() {} };
          try { out.push([JSON.stringify(await driver.ensurePaymentCard(v)), reads]); }
          catch (e) { out.push(["抛了:" + String(e.message).slice(0, 30), reads]); }
        }
        return out;
     })()`),
     [['{"last4":null,"switched":false}', 0], ['{"last4":null,"switched":false}', 0],
      ['{"last4":null,"switched":false}', 0], ['{"last4":null,"switched":false}', 0]]);
});

// ── 结算页 · 礼品卡抵扣 ──────────────────────────────────────────────
//
// 这一节盯的是本项目最贵的那个缺陷:护栏比的那个数是不是**这一单的货款**。
// 同一张页面上,「一张真值 2241.86、礼品卡全垫了的单」与「一张真值 0 的单」
// 在 readGrandTotal 眼里长得一模一样 —— 两种不同的情况渲染出同一个结果。
await withFixture("checkout-giftcard.html", async (run) => {
  // 这张卡要扣的钱:0.00。这个数本身没错,错的是拿它当护栏基数。
  eq("giftcard 实付读成 0.00(这正是缺陷的触发值)",
     await run("amzdom.readGrandTotal(document)"), "0.00");

  // 抵扣额:金额写成 "-$2,241.86"。parseMoney 的正则只认紧贴数字的负号,
  // 这一格必须显式取绝对值 —— 指望 parseMoney 保号会拿到一个正数或负数,
  // 取决于 Amazon 那天把 $ 放在负号前面还是后面。
  eq("giftcard 认出抵扣并读出金额(负号在 $ 前面也要读对)",
     await run("amzdom.readGiftCardDeduction(document)"),
     { applied: true, amount: "2241.86" });

  // 干扰项 F-2 / H:粘性底栏与隐藏模板里各有一条一模一样的抵扣行。
  // 不判可见性就会把 500.00 / 0.00 一起算进去。
  eq("giftcard 文档里一共有三条抵扣标记(干扰项确实存在)",
     await run(`document.querySelectorAll(
        'input[name="subtotalLineType"][value="SPECIAL_PAYMENTS_GIFT_CARD_BALANCE"]').length`), 3);
  eq("giftcard 隐藏的那两条抵扣行没被算进金额",
     await run(`(() => {
        const rows = [...document.querySelectorAll('input[name="subtotalLineType"]')]
          .map((m) => m.closest(".order-summary-grid"));
        return rows.map((r) => r.closest("[style*='display:none']") !== null);
     })()`), [true, true, false]);   // 文档顺序:粘性底栏 → 隐藏模板 → 真表

  // 货款在小结的 "Order total" 行上,而 "Grand Total" 行是抵扣之后的 0.00。
  // 合成一个 total 键就等于让「先命中谁」决定语义。
  const summary = await run("amzdom.readOrderSummary(document)");
  eq("giftcard 小结 Order total = 货款", summary.orderTotal, "2241.86");
  eq("giftcard 小结 Grand Total = 抵扣后实付", summary.grandTotal, "0.00");
  eq("giftcard 运费税费照常读", [summary.shipping, summary.tax], ["12.99", "180.38"]);

  // 支付面板换成了 v2.5.3 的新结构,而且前面压着一个隐藏的同 id 副本
  eq("giftcard 卡后四位仍然是 4417(不是隐藏副本的 0000)",
     await run("amzdom.readPaymentLast4(document)"), "4417");

  // **槽位数与卡尾号是两个事实。** 这张夹具的支付面板里有两个已选支付方式:
  // 尾号 4417 的卡 + 礼品卡余额。readPaymentLast4 只答得出第一个,
  // 拆分支付(公司卡 + 另一张卡)时第一张对得上就放行,第二张刷了多少
  // 这道闸完全不知道 —— 所以要把个数数出来交服务端裁决。
  // 该不该扣掉礼品卡那一个由服务端判(它才知道 gift_card.applied)。
  eq("giftcard 数出两个已选支付槽位(卡 + 礼品卡余额)",
     await run("amzdom.readPaymentSlots(document)"), 2);
  // 隐藏的支付模板副本不能算进槽位数:算进去的话每一张普通单都会被判成拆分支付,
  // 那种闸门等于没有。这里就地造一个隐藏槽位,个数必须不变。
  eq("giftcard 隐藏的支付槽位不算数",
     await run(`(() => {
        const panel = [...document.querySelectorAll("#checkout-payment-option-panel")]
          .find((p) => !p.closest("[style*='display:none']"));
        const ghost = document.createElement("div");
        ghost.id = "selected-payment-method-ghost";
        ghost.style.display = "none";
        panel.appendChild(ghost);
        const n = amzdom.readPaymentSlots(document);
        ghost.remove();
        return n;
     })()`), 2);

  // 面板与下单按钮不受影响 —— 这张夹具只改了金额那几处
  eq("giftcard 面板数 2", (await run("amzdom.readCheckoutPanels(document)")).length, 2);
  eq("giftcard 下单按钮不是隐藏的 csrf input",
     await run("amzdom.findSubmitOrderButton(document)?.type"), "submit");
});

await withFixture("checkout-thirdparty.html", async (run) => {
  eq("checkout-thirdparty 下单按钮同样不是 csrf input",
     await run("amzdom.findSubmitOrderButton(document)?.type"), "submit");
  const panels = await run("amzdom.readCheckoutPanels(document)");
  check("checkout-thirdparty 全部面板都不是 Amazon 发货",
        panels.length > 0 && panels.every((p) => p.isFba === false),
        JSON.stringify(panels.map((p) => ({ s: p.shipper, f: p.isFba }))));

  // FBA 看的是**谁发货**,不是谁卖。第二个面板 "Sold by Amazon.com" 排在
  // "Ships from ThirdParty Seller" 前面 —— 只读第一行、或把 sold by 也收进判据的
  // 写法会在这里把第三方单判成 FBA 放行下单。
  const trap = panels.find((p) => p.asin === "B0C7KN2M4P");
  check("checkout-thirdparty Sold by Amazon 不算 FBA", trap && trap.isFba === false,
        JSON.stringify(trap));
  eq("checkout-thirdparty 配送方取的是 ships from 那一行", trap?.shipper, "ThirdParty Seller");
});

// ── 结算中间页 ──────────────────────────────────────────────────────
// Amazon 在部分结算页把单价那一格换成了 apex-price-to-pay-value。
// 依据是厂商 v2.5.1 在原选择器上补了同一个兜底 —— 他们跑在真实 Amazon 上。
// 我们的 checkout.html 只有旧类名,所以这几条**要是没有,68 条断言会一路绿灯,
// 而线上一个单价都读不到**。
await withFixture("checkout-apex-price.html", async (run) => {
  const panels = await run("amzdom.readCheckoutPanels(document)");
  eq("apex 面板数 2", panels.length, 2);
  eq("apex 单价 1(新类名)", panels[0].unitPrice, "12.50");
  // 划线原价也挂 apex-price-to-pay-value,而且排在实付价**前面** ——
  // 不排除 .a-price[data-a-strike] 就会读到 299.99,比实付还高
  eq("apex 单价 2 不是划线原价", panels[1].unitPrice, "249.50");
  eq("apex FBA 判定仍然分得开", [panels[0].isFba, panels[1].isFba], [true, false]);
  // 面板外的推荐位价格(9.99)不能混进来
  check("apex 推荐位价格没混进单价",
     !panels.some((p) => p.unitPrice === "9.99"),
     JSON.stringify(panels.map((p) => p.unitPrice)));
  eq("apex 总价照常", await run("amzdom.readGrandTotal(document)"), "761.00");
});

await withFixture("checkout-interstitial.html", async (run) => {
  // 隐藏的同选择器副本排在真按钮前面:取第一个就会点在 display:none 的元素上,
  // 不报错也不跳转,然后 45 秒超时,一单白跑
  eq("interstitial 选到的是可见的那个继续按钮",
     await run("amzdom.findInterstitialButton(document)?.getAttribute('href')"),
     "/checkout/p/p-A1B2C3D4E5F6");
  // 中间页上也有 #submitOrderButtonId。靠「页面上有没有下单按钮」判断到没到终局页的
  // 写法,会在这里就去点下单 —— 地址还没填、护栏还没跑
  check("interstitial 页面上确实有个会骗人的 #submitOrderButtonId",
        await run("!!document.querySelector('#submitOrderButtonId')"));
});

// ── 地址流程:结算页 → 地址选择页 → 异步注入的表单 ──────────────────
//
// **这一整节以前是 0 条断言**(`grep -i address` 零命中)。地址是整条链路上
// 唯一「填错了会把货寄给别人」的环节,而它一行离线验证都没有 ——
// 「护栏在、但没人证明它还活着」正是本项目反复点名的那一类。
//
// 三张页面各自要证明的事:
//   checkout.html            结算页上的入口能选对,而**折叠着的地址簿不算数**
//   address-select.html      /address 页上能选对新增入口,而这一页**没有姓名框**
//   address-form-async.html  异步注入的表单要选真身,不选预填着别人地址的模板

await withFixture("checkout.html", async (run) => {
  // ① 更改地址入口:四条有序判据,结构判据(厂商 v2.5.3:3159)在前、
  //    英文 aria-label(厂商 2.5.3 已删)垫底。
  eq("address 更改入口选到 #change-delivery-link(结构判据优先)",
     await run(`(() => {
        const el = amzdom.findAddressChangeEntry(document);
        return el ? [el.id, el.getClientRects().length > 0] : null;
     })()`), ["change-delivery-link", true]);
  // 干扰项自己也得验:隐藏的同 id 副本确实排在真身前面。
  // 不然上面那条即使实现写成裸 querySelector 也照样绿 —— 夹具没干扰,断言就没用。
  eq("address 隐藏的 #change-delivery-link 副本确实排在前面(干扰项确实存在)",
     await run(`(() => {
        const all = [...document.querySelectorAll("#change-delivery-link")];
        return [all.length, all[0].getClientRects().length === 0];
     })()`), [2, true]);
  eq("address 旧的英文 aria-label 入口也还在页面上(两种形态并存)",
     await run(`!!document.querySelector('[aria-label="Change delivery address"]')`), true);
  eq("address 判据顺序:aria-label 那条垫在最后",
     await run(`amzdom.SEL.address.changeAddress[3].includes('aria-label')`), true);

  // ② **ADDR-1 的要害**:结算页上那个折叠着的地址簿不许满足「地址区加载」。
  //    原先 amazon.ts 点完「更改地址」就等 SEL.address.section,而 waitFor 的
  //    第一次探测是**同步**的 —— 页面还没跳走,折叠地址簿当场满足,
  //    于是我们在结算页上点了折叠容器里那个不可见的「新建地址」,
  //    此后 30 秒等一个永远不会出现的表单。
  //    净效果:只要买家号地址簿里有历史地址(常态),每一单都 ADDRESS_FORM_TIMEOUT。
  eq("address 结算页上折叠的地址簿不算「地址区加载」",
     await run("amzdom.findAddressSection(document)"), null);
  eq("address 结算页上确实有那个折叠的地址区节点(干扰项确实存在)",
     await run(`(() => {
        const el = document.querySelector('[aria-labelledby="delivery-addresses-section-header-id"]');
        return [!!el, el.getClientRects().length === 0];
     })()`), [true, true]);
  eq("address 结算页上折叠地址簿里的「新增地址」也不算数",
     await run("amzdom.findAddNewAddressEntry(document)"), null);
  eq("address 结算页上确实有那个隐藏的新增地址入口(干扰项确实存在)",
     await run(`!!document.querySelector("#add-new-address-desktop-sasp-tango-link")`), true);
  eq("address 结算页上没有渲染出来的姓名输入框",
     await run("amzdom.findAddressFormNameField(document)"), null);

  // ②' 结算页**原样**(一次保存都没点过)时不许判 saved。
  //    「更改地址」的另一种落地形态是就地弹窗:文档一直是这张结算页,
  //    而这张页上本来就有生效中的旧地址栏 #deliver-to-address-text ——
  //    只判「这一栏在不在」的话,点完保存的第一拍就 saved,
  //    校验提示与建议弹窗整段处理被跳过,弹窗还挡着而我们已经往下走了。
  eq("address 结算页原样(没点过保存)不许判 saved",
     await run(`(() => {
        const before = amzdom.readAppliedAddressText(document);
        return [before !== null, amzdom.readAddressSaveOutcome(document, before)];
     })()`), [true, null]);
  eq("address 结算页上确实有一条生效中的旧地址(干扰项确实存在)",
     await run(`(() => {
        const el = document.querySelector("#deliver-to-address-text");
        return [!!el, el.getClientRects().length > 0];
     })()`), [true, true]);

  // ③ 落空时要能一眼分出「选择器坏了」和「页面慢」。
  //    两种情况今天都渲染成 ADDRESS_FORM_TIMEOUT,而前者要改代码、后者重试就好。
  eq("address 落空诊断:命中了但没渲染 = 页面慢",
     await run(`amzdom.diagnoseMiss(document, [amzdom.SEL.address.addNew]).kind`), "not_rendered");
  eq("address 落空诊断:一个节点都没匹配到 = 选择器坏了",
     await run(`amzdom.diagnoseMiss(document, ["#no-such-entry", ".neither-this"])`),
     { kind: "no_match", tried: 2 });
  // 两种诊断必须说出两句**不同**的话 —— 说同一句话就等于没有诊断
  check("address 两种落空的说法确实不同",
        (await run(`amzdom.describeMiss(document, [amzdom.SEL.address.addNew])`)) !==
        (await run(`amzdom.describeMiss(document, ["#no-such-entry"])`)));
  check("address「选择器坏了」那句话点明了要改选择器",
        (await run(`amzdom.describeMiss(document, ["#no-such-entry"])`)).includes("改选择器"));
  // detail 会显示在运营台上,而 ADDRESS_FORM_TIMEOUT 属于 RETRYABLE 组 ——
  // services/task_retry.py 按这一组挑单,开关(auto_retry_max)一开就会把这类单
  // 自动再拍 N 次。文案里写「重试无用」而系统照样重拍,就是在界面上写一句
  // 系统不会兑现的话;这条判据是给人看的,机器读不到它。
  check("address 落空诊断不预告系统行为(不出现「重试无用」)",
        !(await run(`amzdom.describeMiss(document, ["#no-such-entry"])`)).includes("重试无用"));
});

await withFixture("address-select.html", async (run) => {
  // ④ 这一页**本身不含姓名输入框**(厂商 findings.md:45 的实测结论):
  //    表单要点完「新增地址」才异步注入。拿姓名框当「到了地址选择页」的判据
  //    永远等不到 —— 那正是 ADDR-1 里那 30 秒空等的去处。
  eq("address-select 这一页没有姓名输入框",
     await run("amzdom.findAddressFormNameField(document)"), null);
  eq("address-select 地址列表区渲染出来了",
     await run(`!!amzdom.findAddressSection(document)`), true);

  // ⑤ 新增地址入口:页面上有**三份**,真身排在最后。三份各考一种隐藏机制,
  //    缺一种判据就会被对应的那一份骗到 —— 而被骗到的表现都一样:
  //    click() 不报错也不跳转,然后等一个永远不会出现的表单,30 秒后超时。
  eq("address-select 新增入口选到真身(第 3 份)",
     await run(`(() => {
        const all = [...document.querySelectorAll("#add-new-address-desktop-sasp-tango-link")];
        const el = amzdom.findAddNewAddressEntry(document);
        return [all.length, el === all[2]];
     })()`), [3, true]);
  // 干扰项 A-1:靠 **CSS 类**隐藏,没有 inline style。
  // 「往上找 [style*=display:none]」的写法完全看不见它;而且父级 display:none 时
  // 子 <a> 自己的 computed display 仍是 inline —— 只看自己那一格也不行。
  eq("address-select 干扰项 A-1 是靠 class 隐藏的(没有 inline style,且子节点自己的 display 仍是 inline)",
     await run(`(() => {
        const a = document.querySelectorAll("#add-new-address-desktop-sasp-tango-link")[0];
        return [a.getAttribute("style"), a.closest("[style]") === null,
                getComputedStyle(a).display, a.getClientRects().length];
     })()`), [null, true, "inline", 0]);
  // 干扰项 A-2:visibility:hidden —— 它**占位**,getClientRects 照样有矩形,
  // 只有单独判 visibility 才拦得住
  eq("address-select 干扰项 A-2 占着位置(getClientRects 拦不住它)",
     await run(`(() => {
        const a = document.querySelectorAll("#add-new-address-desktop-sasp-tango-link")[1];
        return [getComputedStyle(a).visibility, a.getClientRects().length > 0];
     })()`), ["hidden", true]);

  // ⑥ 55 个编辑入口、编号从 0 起(厂商 v253:3210 的循环从 i=1 起,第 0 条永远选不中)。
  //    我们**一律新建地址**,不复用 —— 这几条是把那个坑摆在台面上,
  //    以及记录「每单新建」在真实买家号上会攒成什么样。
  eq("address-select 55 个编辑入口",
     await run(`document.querySelectorAll('[data-action="checkout-view-modal"]').length`), 55);
  eq("address-select 编辑入口编号从 0 起",
     await run(`!!document.querySelector("#edit-address-desktop-tango-sasp-0")`), true);
  // editNth 是死代码,已删。留这条断言是为了防止有人「顺手补回来」却依旧没有调用点。
  eq("selectors 里不再有无人调用的 editNth",
     await run(`amzdom.SEL.address.editNth === undefined`), true);
});

await withFixture("address-form-async.html", async (run) => {
  // ⑦ **异步注入的表单要选真身。** 隐藏模板排在前面,而且预填着**另一个人**的地址。
  //    取到模板那份的后果:setInput 往一个没人看的 DOM 里写字,点保存什么都没发生,
  //    30 秒后 ADDRESS_FORM_TIMEOUT —— 而地址其实一个字都没填进去。
  eq("address-form 姓名框选到的是空的真身,不是预填着别人地址的模板",
     await run(`(() => {
        const el = amzdom.findAddressFormNameField(document);
        return el ? el.value : null;
     })()`), "");
  eq("address-form 裸 querySelector 取到的确实是模板那一份(干扰项确实存在)",
     await run(`document.querySelector("#address-ui-widgets-enterAddressFullName").value`),
     "Priya Raman");
  // 姓名框只是入口 —— **每一格**都得挑对。填进模板里那一份的后果:
  // setInput 不报错、保存点下去什么都没发生,30 秒后 ADDRESS_FORM_TIMEOUT,
  // 而地址其实一个字都没填进去。更坏的分支是模板里预填的地址被采用 = 寄给别人。
  eq("address-form 每一格都挑到真表单那一份(模板里预填着别人的地址)",
     await run(`(() => {
        const S = amzdom.SEL.address;
        const pick = (sel) => amzdom.pickFirstRendered(document, [sel]);
        const raw = (sel) => document.querySelector(sel);
        return {
          picked: [S.phone, S.line1, S.city, S.postal].map((x) => pick(x).value),
          naive:  [S.phone, S.line1, S.city, S.postal].map((x) => raw(x).value),
          state:  [pick(S.state).options.length, raw(S.state).options.length],
        };
     })()`), {
       picked: ["", "", "", ""],
       naive: ["2065550147", "410 Terry Ave N", "Seattle", "98109"],
       state: [4, 1],
     });

  // ⑧ 保存按钮的选择器带 #pagelet-layout-section 前缀 —— 模板里也有一个同 id 的
  eq("address-form 保存按钮选到真表单里那个",
     await run(`(() => {
        const el = amzdom.pickFirstRendered(document, [amzdom.SEL.address.save]);
        return el ? [el.value, el.closest("#pagelet-layout-section") !== null] : null;
     })()`), ["Use this address", true]);

  // ⑨ **保存之后三种结果谁先出现就处理谁。**
  //    原先是 sleep(1200) 各看一眼的定时快照:弹窗晚出现 200ms 就整单失败,
  //    而失败时地址其实已经填好了,重试还要从头再来一遍。
  //    这一页是「刚点完保存、什么都还没出来」的状态 —— 三种都不成立。
  eq("address-form 刚点完保存、还没出结果 → null",
     await run("amzdom.readAddressSaveOutcome(document, null)"), null);
  // 关键的干扰项:校验提示节点与建议弹窗的壳子**一直在 DOM 里**。
  // 只判「节点在不在」的话,每一单在第一次探测就会认定「弹窗出现了」,
  // 于是去点一个折叠着的 radio、再点一次保存,来回三轮然后失败。
  eq("address-form 建议弹窗的壳子确实在 DOM 里但折叠着(干扰项确实存在)",
     await run(`(() => {
        const el = document.querySelector(amzdom.SEL.address.suggestionPopup);
        return [!!el, el.getClientRects().length === 0];
     })()`), [true, true]);
  eq("address-form 校验提示节点确实在 DOM 里但没有文字(干扰项确实存在)",
     await run(`(() => {
        const s = amzdom.SEL.address.validationAlerts;
        return [s.every((x) => !!document.querySelector(x)),
                s.every((x) => !document.querySelector(x).textContent.trim())];
     })()`), [true, true]);

  // 三种结果各自出现时都要认得出来
  eq("address-form 校验提示有文字 → alerts",
     await run(`(() => {
        document.querySelector("#address-ui-widgets-enterAddressLine1-full-validation-alerts")
                .textContent = "Please enter a street address";
        return amzdom.readAddressSaveOutcome(document, null);
     })()`), "alerts");
  eq("address-form 建议弹窗展开 → suggestion",
     await run(`(() => {
        document.querySelector("#address-ui-widgets-enterAddressLine1-full-validation-alerts")
                .textContent = "";
        document.querySelector(amzdom.SEL.address.suggestionPopup).style.display = "block";
        return amzdom.readAddressSaveOutcome(document, null);
     })()`), "suggestion");
  eq("address-form 收货地址栏出现 → saved(压过还开着的建议弹窗)",
     await run(`(() => {
        const d = document.createElement("div");
        d.id = "deliver-to-address-text";
        d.textContent = "Marcus Delgado, 1425 S Bristol St Apt 12B, Santa Ana, CA 92707";
        document.body.appendChild(d);
        return amzdom.readAddressSaveOutcome(document, null);
     })()`), "saved");

  // ⑩ **「页面上有收货地址栏」不等于「这次保存生效了」。**
  //    更改地址有一种形态是就地弹窗(不跳 /address),那条路上文档一直是结算页,
  //    而结算页上本来就有生效中的旧地址栏 —— 不比对文本的话,点完保存的第一拍
  //    就判 saved:校验提示与建议弹窗整段处理被跳过,弹窗还挡着而我们已经往下走。
  eq("address-form 地址栏文本与保存前一样 → 不算 saved(这次保存还没生效)",
     await run(`(() => {
        const before = amzdom.readAppliedAddressText(document);
        document.querySelector(amzdom.SEL.address.suggestionPopup).style.display = "block";
        return [before !== null,
                amzdom.readAddressSaveOutcome(document, before)];
     })()`), [true, "suggestion"]);
  eq("address-form 地址栏换了内容 → 才算 saved",
     await run(`(() => {
        const before = amzdom.readAppliedAddressText(document);
        document.querySelector("#deliver-to-address-text").textContent =
          "Marcus Delgado, 900 Newport Center Dr, Newport Beach, CA 92660";
        return amzdom.readAddressSaveOutcome(document, before);
     })()`), "saved");
  // 收货地址栏也可能有隐藏的第二份(与表单、购物车行同一个模板做法)。
  // 注释说三条都要求「渲染出来」,而 saved 这一条原先是裸 querySelector。
  eq("address-form 隐藏的收货地址栏不算数",
     await run(`(() => {
        document.querySelector("#deliver-to-address-text").remove();
        const d = document.createElement("div");
        d.id = "deliver-to-address-text";
        d.style.display = "none";
        d.textContent = "Priya Raman, 410 Terry Ave N, Seattle, WA 98109";
        document.body.appendChild(d);
        return [!!document.querySelector("#deliver-to-address-text"),
                amzdom.readAppliedAddressText(document),
                amzdom.readAddressSaveOutcome(document, null)];
     })()`), [true, null, "suggestion"]);
  // 少传 before 要当场报错。少了这一条,从 JS 里漏传一个参数就会静默退回
  // 缺陷前的行为(页面上有地址栏 = saved),而且照样返回一个看着正常的值。
  eq("address-form readAddressSaveOutcome 少传 before 直接报错",
     await run(`(() => {
        try { amzdom.readAddressSaveOutcome(document); return "没抛"; }
        catch (e) { return e.message.includes("before") ? "报错" : "抛了别的:" + e.message; }
     })()`), "报错");
});

// ── 地址保存的「三轮对抗」:每一轮动作之后要等的是「状态真的变了」 ──────
//
// 这一节验的不是纯函数,是 fillAddress 那段循环的**时序**:让驱动对着夹具
// 真跑一遍,自己填字、自己点保存、自己等结果。上面那些断言一条都够不着这里 ——
// 循环写坏时(动完手立刻重读同一个状态)全部纯函数断言照样绿,而线上每一单都失败。
//
// waitFor 的第一次探测是同步的,所以「点完保存立刻重读」读到的必然还是刚才
// 那个弹窗 —— 三轮在同一毫秒里烧光、保存按钮被连点 4 次、30 秒预算用掉 9%,
// 而最后一次保存的结果从来没有被等过,抛出来那句「反复出现」一次都没等过。
//
// 页面上同时摆着一条**旧地址**:就地弹窗那条路上文档一直是结算页,
// saved 若只看「地址栏在不在」,第一拍就判成功,弹窗整段处理直接跳过。
//
// reactions[k] = 第 k+1 次点保存之后,过 delay 毫秒页面变成什么样。
async function fillAddressDrill(run, reactions) {
  return run(`(async () => {
    const REACT = ${JSON.stringify(reactions)};
    const bar = document.createElement("div");
    bar.id = "deliver-to-address-text";
    bar.textContent = "Priya Raman, 410 Terry Ave N, Seattle, WA 98109";   // 别人的旧地址
    document.body.appendChild(bar);
    // 提交会让页面导航走,这里只关心点击本身。
    document.querySelector("#pagelet-layout-section form")
            .addEventListener("submit", (e) => e.preventDefault());

    const popup = document.querySelector(amzdom.SEL.address.suggestionPopup);
    const radio = popup.querySelector('input[type=radio]');
    const alertNode = document.querySelector(amzdom.SEL.address.validationAlerts[0]);
    let saves = 0, radios = 0;
    radio.addEventListener("click", () => { radios += 1; });
    const t0 = Date.now();
    document.querySelector(amzdom.SEL.address.save).addEventListener("click", () => {
      const r = REACT[saves];
      saves += 1;
      if (!r) return;
      setTimeout(() => {
        if (r.popup !== undefined) popup.style.display = r.popup ? "block" : "none";
        if (r.alert !== undefined) alertNode.textContent = r.alert;
        if (r.address !== undefined) bar.textContent = r.address;
      }, r.delay);
    });

    const driver = new amzdom.AmazonDriver("https://www.amazon.com");
    // checkout 在 TS 里是私有的,这里是**故意**从外面摆好它:这一段要验的是
    // 保存之后那个循环,而走公开路径得先有一个真的结算 iframe。
    driver.checkout = { el: null, doc: () => document, url: () => "", close() {} };
    let threw = "没抛";
    try {
      await driver.fillAddress({
        name: "Marcus Delgado", phone: "7145550188",
        line1: "1425 S Bristol St Apt 12B", city: "Santa Ana",
        state: "CA", postcode: "92707", country: "US",
      });
    } catch (e) { threw = (e.code ?? e.constructor.name) + ":" + String(e.message).slice(0, 120); }
    return { threw, saves, radios, ms: Date.now() - t0 };
  })()`);
}

const APPLIED = "Marcus Delgado, 1425 S Bristol St Apt 12B, Santa Ana, CA 92707";

// ① 最常见的那条路:买家地址被 Amazon 判为需要规范化,保存之后弹出地址建议弹窗。
await withFixture("address-form-async.html", async (run) => {
  const res = await fillAddressDrill(run, [
    { delay: 600, popup: true },                      // 第 1 次保存 → 600ms 后弹窗
    { delay: 300, popup: false, address: APPLIED },   // 选完原始地址再保存 → 地址生效
  ]);
  eq("地址保存:建议弹窗晚 600ms 出现,这一单照样走通", res.threw, "没抛");
  // 改坏时这里是 4:第 1 轮读到弹窗 → 选原始地址 + 保存,第 2、3 轮在同一毫秒
  // 又各读到同一个弹窗、又各点一次保存。连点保存本身还有重复提交的风险。
  eq("地址保存:保存按钮只按需点了 2 次", res.saves, 2);
  eq("地址保存:原始地址那一项选过一次", res.radios, 1);
  check("地址保存:真的等到了弹窗出现(不是在同一拍里烧完三轮)", res.ms >= 600, `${res.ms}ms`);
});

// ② 用满三轮的那条路:弹窗 → 校验提示 → 弹窗 → 生效。
//    要害在**最后一次保存之后还有没有一次「等结果」的机会** —— 少了它,
//    那一次点击的结果永远看不到,而它恰恰是成功的那一次:地址其实已经生效,
//    我们却报 ADDRESS_FORM_TIMEOUT,重试还要从头再填一遍。
await withFixture("address-form-async.html", async (run) => {
  const res = await fillAddressDrill(run, [
    { delay: 300, popup: true },                                     // 保存 1 → 弹窗
    { delay: 300, popup: false, alert: "Please check the street address" }, // 保存 2 → 校验提示
    { delay: 300, alert: "", popup: true },                          // 保存 3 → 又是弹窗
    { delay: 300, popup: false, address: APPLIED },                  // 保存 4 → 地址生效
  ]);
  eq("地址保存:三轮都用满之后,最后那一次保存的结果也要等", res.threw, "没抛");
  eq("地址保存:三轮各点一次保存(加最开始那一次共 4 次)", res.saves, 4);
  eq("地址保存:两次弹窗各选了一次原始地址", res.radios, 2);
});

// ── 订单历史 ────────────────────────────────────────────────────────
await withFixture("order-history.html", async (run) => {
  const cards = await run("amzdom.readOrderCards(document)");
  check("orders 读到多张卡", cards.length >= 3, String(cards.length));
  check("orders 第一张卡的订单号形态正确",
        /^\d{3}-\d{7}-\d{7}$/.test(cards[0].orderNo ?? ""), String(cards[0].orderNo));
  check("orders 订单号没把 'ORDER #' 标签当成号",
        !/order/i.test(cards[0].orderNo ?? ""), String(cards[0].orderNo));
  check("orders 第一张卡的 ASIN 与本单不同(夹具刻意如此,断言才有意义)",
        !cards[0].asins.includes("B0FB3VS68J"), JSON.stringify(cards[0].asins));
  check("orders 没把 Buy it again 推荐位的 ASIN 算进卡里",
        !cards.some((c) => c.asins.includes("B0NOISE0001")),
        JSON.stringify(cards.map((c) => c.asins)));
});

await withFixture("order-history-empty.html", async (run) => {
  eq("orders-empty 读到 0 张卡", await run("amzdom.readOrderCards(document).length"), 0);
});

// ── 订单详情页(物流同步流) ──────────────────────────────────────────
await withFixture("order-details.html", async (run) => {
  eq("order-details 状态为 ok", await run("amzdom.readOrderState(document)"), "ok");

  // 金额行按 label 扫,不按下标 —— 夹具里刻意多了礼品卡与促销两行
  const sub = await run("amzdom.readOrderSubtotals(document)");
  eq("order-details 运费", sub.shipping, "3.99");
  eq("order-details 税前总额", sub.beforeTax, "1296.79");
  eq("order-details 税费", sub.tax, "2.82");
  eq("order-details 总计(带千分位)", sub.total, "1299.61");

  // 隐藏的 #od-subtotals 副本排在真的之前,取第一个会读到全是 0.00 的模板
  check("order-details 没读到隐藏副本里的 0.00", sub.total !== "0.00", JSON.stringify(sub));

  const asins = await run("amzdom.readOrderAsins(document)");
  eq("order-details 商品 ASIN", asins, ["B0FB3VS68J", "B0CHXNPXVX"]);
  check("order-details 没把 Buy it again 推荐位算进来",
        !asins.includes("B0NOISE0003"), JSON.stringify(asins));

  // 文案里先出现 "4 payments" 的 4 和年份 2026,取第一个 4 位数会取错
  eq("order-details 卡后四位取的是 ending in 后面那个",
     await run("amzdom.readOrderPaymentLast4(document)"), "4417");

  check("order-details 找到跟踪链接",
        (await run("amzdom.findTrackingLink(document)") || "").includes("/ship-track?"));
});

// 跟踪按钮的外壳 class 换了,href 形状没变。
// 原先拿 class 当入口闸门 —— class 一变就返回 null,而 shipment.ts 把
// 「没有跟踪链接」当成 not_shipped:一批在路上的包裹会被整批记成未发货,
// 没有任何地方报错。
await withFixture("order-details-newbutton.html", async (run) => {
  const link = await run("amzdom.findTrackingLink(document)");
  check("新外壳 class 也能按 href 找到跟踪链接", !!link, String(link));
  check("找到的是真单号那条,不是隐藏模板里的占位符",
     String(link).includes("111-4820193-7736441"), String(link));
  check("没把「查看发票」当成跟踪链接",
     !String(link).includes("invoice"), String(link));
});

// 更坏的一种:href 形状也变了,两条 hint 全落空,只剩 class 兜底。
// 而 class 兜底那几个外壳里,「Cancel items」和「Track package」是邻居 ——
// 兜底要是「只要 href 非空就拿」,一次例行的物流同步会变成一次取消订单。
await withFixture("order-details-cancel-neighbor.html", async (run) => {
  const link = String(await run("amzdom.findTrackingLink(document)"));
  check("class 兜底没把「取消订单」当成跟踪链接", !link.includes("cancel"), link);
  check("class 兜底也没抓到「退货」", !link.includes("returns"), link);
  check("认出了文案写着 Track package 的那条", link.includes("/shipment-status/v2/"), link);
});

// Amazon 明说「这会儿给不了轨迹」。
// 认出它有两个作用:省掉 30 秒干等,以及把它与「我们没解析出来」分开 ——
// 都记成 0 条轨迹的话,选择器坏了会被当成「这批单都还没发货」。
await withFixture("tracking-unavailable.html", async (run) => {
  eq("认出 Amazon 的「暂时给不了轨迹」",
     await run("amzdom.isTrackingUnavailable(document)"), true);
});
await withFixture("tracking.html", async (run) => {
  eq("正常跟踪页不会被误判成「给不了轨迹」",
     await run("amzdom.isTrackingUnavailable(document)"), false);
});

await withFixture("order-details-cancelled.html", async (run) => {
  // 「订单被取消」和「页面没加载好」是两回事:这一页 #orderDetails 是存在的
  eq("order-details-cancelled 判为已取消",
     await run("amzdom.readOrderState(document)"), "cancelled");
  check("order-details-cancelled 页面上确实有 #orderDetails",
        await run("!!document.querySelector('#orderDetails')"));
});

// 「已取消」的**第二种渲染形态**:没有告警框,状态写在
// #shipment-top-row .a-color-base.od-status-message 里,文案里也没有 refund。
// 厂商 v2.5.3:4057-4070 专门补这一档 —— 补这一档本身就说明线上已经出现了。
// 实测(SP/wf/orderstate_probe.mjs):这一形态我们原先判 "ok",厂商判 cancelled。
// 判成 ok 的后果是一张已取消的订单被当成正常单继续同步物流,而没有任何地方报错。
await withFixture("order-details-cancelled-status.html", async (run) => {
  eq("order-details 只有 od-status-message 时也判为已取消",
     await run("amzdom.readOrderState(document)"), "cancelled");
  // 干扰项自己也得验:这一页确实没有告警框、文案里也确实没有 refund。
  // 不然上面那条即使实现没补这一档也可能靠旧判据蒙对。
  eq("这一页确实没有 .a-alert-heading(干扰项确实存在)",
     await run(`document.querySelectorAll(".a-alert-heading").length`), 0);
  eq("这一页的 #shipment-top-row 里确实没有 refund 字样(干扰项确实存在)",
     await run(`/refund/i.test(document.querySelector("#shipment-top-row").textContent)`), false);

  // 卡尾号的第二形态(厂商 v253:4399,2.4.1 起就有,是我们漏掉的老形态)。
  // 落空的表现是 payment_last4 一列静静全空 —— 没有任何地方说「选择器坏了」。
  eq("这一页确实没有 .pmts-payments-instrument-details(干扰项确实存在)",
     await run(`document.querySelectorAll(".pmts-payments-instrument-details").length`), 0);
  eq("order-details 卡尾号走第二形态也能读到,且不取文案里先出现的 4 位数",
     await run("amzdom.readOrderPaymentLast4(document)"), "4417");

  // 状态行判据是两条:厂商那条精确到 `.a-color-base`,我们补的第二条只要
  // `.od-status-message`。`a-color-base` 是纯配色工具类,Amazon 换一版主题就可能不一样,
  // 而 `od-status-message` 才是语义所在。**这一条放在本节最后** ——
  // 它会改掉夹具的 class,后面不能再有依赖原 class 的断言。
  eq("order-details 配色类被换掉后,第二条判据仍然兜得住",
     await run(`(() => {
        const el = document.querySelector(".od-status-message");
        el.classList.remove("a-color-base");
        el.classList.add("a-color-tertiary");
        return [document.querySelectorAll("#shipment-top-row .a-color-base.od-status-message").length,
                amzdom.readOrderState(document)];
     })()`), [0, "cancelled"]);
});

await withFixture("order-details-notfound.html", async (run) => {
  // 这一页**没有** #orderDetails。只等 #orderDetails 的写法会在这里干等到超时
  eq("order-details-notfound 判为打不开",
     await run("amzdom.readOrderState(document)"), "not_found");
  check("order-details-notfound 页面上没有 #orderDetails",
        await run("!document.querySelector('#orderDetails')"));
});

// ── 包裹跟踪页 ──────────────────────────────────────────────────────
await withFixture("tracking.html", async (run) => {
  // 隐藏的运单号副本排在真的之前;退化选择器里还有个不一样的号
  eq("tracking 运单号取的是可见的那个",
     await run("amzdom.readTrackingNumber(document)"), "9400111899223197428431");

  // 厂商取 .a-spacing-small 文本的 split(" ")[2] —— 在这个词序下取到的是 "shipped"
  eq("tracking 承运商不是 shipped", await run("amzdom.readCarrier(document)"), "USPS");

  eq("tracking 主状态映射到封闭集",
     await run("amzdom.readTrackingStatus(document)"), "in_transit");
  eq("tracking 预计送达", await run("amzdom.readDeliveryPromise(document)"), "Wednesday, August 27");

  const ev = await run("amzdom.readTrackingEvents(document)");
  // 容器外还有一组同构的事件行(相关订单),不带容器前缀就会混进来
  eq("tracking 只数容器内的事件", ev.length, 6);
  check("tracking 没把容器外的 Delivered 混进来",
        !ev.some((e) => (e.description || "").includes("Front door")),
        JSON.stringify(ev.map((e) => e.description)));

  eq("tracking 最新一条(倒序,带日期分组)", ev[0], {
    raw_day: "August 26, 2026", raw_time: "8:42 AM",
    description: "Out for delivery", city: "Santa Ana", state_code: "CA",
  });
  // 位置串 "Los Angeles, CA 90001":按逗号切,后段去掉最后一个 token 才是州
  eq("tracking 位置串拆成 city / state", { c: ev[2].city, s: ev[2].state_code },
     { c: "Los Angeles", s: "CA" });
  // 有一条真的没有 location,不能崩、也不能把上一条的位置串过来
  const noLoc = ev.find((e) => (e.description || "").includes("left the carrier facility"));
  eq("tracking 缺 location 的事件位置为空", { c: noLoc?.city, s: noLoc?.state_code },
     { c: null, s: null });
  // 日期分组跨了三组,最后一条该落在最早那一天
  eq("tracking 最后一条的日期分组", ev[ev.length - 1].raw_day, "August 24, 2026");
});

// 跟踪页只渲染了事件区(轨迹已经在更新、顶部 delivery card 还没画出来或被折叠)。
// 原先两条判据都落空 → readTrackingNumber 返回 null,而这一单在库里跟
// 「还没发货」长得一模一样,没有任何地方说「选择器坏了」。
// 第三条 `.tracking-event-trackingId-text h4` 出自厂商 v253:4851,2.4.1 起就有。
await withFixture("tracking-events-only.html", async (run) => {
  eq("tracking 只有事件区时也读得到运单号",
     await run("amzdom.readTrackingNumber(document)"), "9400111899223197428431");
  eq("tracking 原先那两条在这张页上确实都落空(干扰项确实存在)",
     await run(`(() => {
        const vis = (s) => [...document.querySelectorAll(s)]
          .filter((e) => e.getClientRects().length > 0).length;
        return [vis(".pt-delivery-card-trackingId"), vis("#carrierRelatedInfo-container > div h4")];
     })()`), [0, 0]);
  // 隐藏模板里那个占位号排在最前:读到它比读不到更坏 ——
  // 一个假运单号会被当成真的写进库,物流同步从此追一个不存在的包裹。
  eq("tracking 没读到隐藏模板里的占位运单号(干扰项确实存在)",
     await run(`document.querySelector(".pt-delivery-card-trackingId").textContent.includes("0000000000000000")`),
     true);
  // 这一页 #primaryStatus 在,所以「跟踪页就绪」成立 ——
  // 也就是说它不会超时,会安安静静地返回一个没有运单号的结果
  eq("tracking 这一页确实算「就绪」(所以不会靠超时暴露)",
     await run(`!!document.querySelector("#primaryStatus")`), true);
});

await withFixture("tracking-delivered.html", async (run) => {
  eq("tracking-delivered 状态", await run("amzdom.readTrackingStatus(document)"), "delivered");
  // 另一种词序:"Shipped with AMZL US"。两份夹具合起来才说明盲取第 3 个词是靠运气
  eq("tracking-delivered 承运商", await run("amzdom.readCarrier(document)"), "AMZL US");
  // 已签收的单没有预计送达,读不到不该报错
  eq("tracking-delivered 没有预计送达", await run("amzdom.readDeliveryPromise(document)"), null);
});

await browser.close();

console.log(`\n  通过 ${pass} 条`);
if (failures.length) {
  console.log(`  失败 ${failures.length} 条:`);
  for (const f of failures) console.log("    ✗ " + f);
  process.exit(1);
}
console.log("  全部通过\n");
