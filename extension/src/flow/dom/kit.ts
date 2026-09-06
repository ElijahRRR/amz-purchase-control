/** 把解析层(以及需要真 DOM 才验得了的那几样)打成一个 IIFE 包,
 *  供 test/dom.test.mjs 在 Playwright 页面里调用。
 *  生产代码不引这个文件 —— 它只是测试的入口。
 *
 *  为什么把 openFrame 和 AmazonDriver 也放进来:执行中掉线那条兜底
 *  (AmazonDriver.guardLogin)只有在**真的有一个 iframe**、而且那个 iframe 真的
 *  被 X-Frame-Options 挡住时才走得到那条分支。Node 里没有 document,
 *  smoke 走的是模拟驱动 —— 只有浏览器页面里验得了。 */

export * from "./parse.js";
export { SEL, URLS, ASIN_RE, ORDER_NO_RE } from "./selectors.js";
export { openFrame, withFrame } from "./frame.js";
export { AmazonDriver } from "../amazon.js";
export { DriverError, LoginLostError } from "../driver.js";
