#!/usr/bin/env node
/** 解析层的离线验证。
 *
 * 真实 Amazon 页面拿不到,所以对着 test/fixtures/ 里按逆向报告造出来的 DOM 跑。
 * 夹具里塞满了干扰项(隐藏的同 id 副本、Saved for later、推荐位、模板节点),
 * 选择器写松了会当场被抓住。
 *
 *   npm run test:dom
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const KIT = join(here, "..", "dist", "domkit.js");

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
});

await withFixture("checkout-thirdparty.html", async (run) => {
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
