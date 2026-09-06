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
});

await withFixture("cart-empty.html", async (run) => {
  eq("cart-empty 行数为 0", await run("amzdom.readCartLines(document).length"), 0);
  // 「车是空的」要有正面证据:容器在、就是 0 行。
  eq("cart-empty 的 0 行是「容器在、没有行」", await run("amzdom.readCartState(document)"),
     { lines: [], scopeFound: true });
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
     await parse(renamed, "amzdom.readCartState(d)"), { lines: [], scopeFound: false });
  eq("cart 容器改名时页面上确实还有一行(干扰项确实存在)",
     await parse(renamed, `d.querySelectorAll(".sc-list-item").length`), 1);

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

  check("checkout 读到订单总额", !!(await run("amzdom.readGrandTotal(document)")));

  const summary = await run("amzdom.readOrderSummary(document)");
  check("checkout 按 label 扫到运费", summary.shipping !== undefined, JSON.stringify(summary));
  check("checkout 按 label 扫到税费", summary.tax !== undefined, JSON.stringify(summary));

  // 夹具的支付文案里故意先出现别的 4 位数,取"第一个 4 位数字"的写法会当场露馅
  eq("checkout 卡后四位取的是 ending in 后面那个",
     await run("amzdom.readPaymentLast4(document)"), "4417");

  // #submitOrderButtonId 里排在前面的是隐藏的 anti-csrftoken-a2z。
  // 后代选择器会选中它 —— click() 打在隐藏 input 上不报错也不跳转,
  // 于是等满 60 秒抛 ORDER_CONFIRM_TIMEOUT,任务落进「可能已下单」桶,
  // 运营被迫逐单登录买家号确认一个根本不存在的订单。
  eq("checkout 下单按钮不是隐藏的 csrf input",
     await run("amzdom.findSubmitOrderButton(document)?.type"), "submit");
  eq("checkout 下单按钮不带 name=anti-csrftoken-a2z",
     await run("amzdom.findSubmitOrderButton(document)?.getAttribute('name')"), null);
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
  check("address「选择器坏了」那句话里点明了重试无用",
        (await run(`amzdom.describeMiss(document, ["#no-such-entry"])`)).includes("重试无用"));
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
     await run("amzdom.readAddressSaveOutcome(document)"), null);
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
        return amzdom.readAddressSaveOutcome(document);
     })()`), "alerts");
  eq("address-form 建议弹窗展开 → suggestion",
     await run(`(() => {
        document.querySelector("#address-ui-widgets-enterAddressLine1-full-validation-alerts")
                .textContent = "";
        document.querySelector(amzdom.SEL.address.suggestionPopup).style.display = "block";
        return amzdom.readAddressSaveOutcome(document);
     })()`), "suggestion");
  eq("address-form 收货地址栏出现 → saved(压过还开着的建议弹窗)",
     await run(`(() => {
        const d = document.createElement("div");
        d.id = "deliver-to-address-text";
        d.textContent = "Marcus Delgado, 1425 S Bristol St Apt 12B, Santa Ana, CA 92707";
        document.body.appendChild(d);
        return amzdom.readAddressSaveOutcome(document);
     })()`), "saved");
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
