/** 把纯解析函数打成一个 IIFE 包,供 test/dom.test.mjs 在 Playwright 页面里调用。
 *  生产代码不引这个文件 —— 它只是测试的入口。 */

export * from "./parse.js";
export { SEL, URLS, ASIN_RE, ORDER_NO_RE } from "./selectors.js";
