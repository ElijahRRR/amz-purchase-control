/** 三页一个 hash,没上路由库。
 *
 * react-router 为三页付出的是一层心智负担和一个依赖;这里用 hash 就够了,
 * 而且刷新还在原页、地址栏能贴给同事 —— 那两条才是路由真正给的东西。
 */

import { useEffect, useState } from "react";

export const PAGES = ["tasks", "instances", "runs", "errors"] as const;
export type Page = (typeof PAGES)[number];

const parse = (): Page => {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (PAGES as readonly string[]).includes(h) ? (h as Page) : "tasks";
};

export function useRoute(): [Page, (p: Page) => void] {
  const [page, setPage] = useState<Page>(parse);
  useEffect(() => {
    const on = () => setPage(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [page, (p) => { window.location.hash = `#/${p}`; }];
}
