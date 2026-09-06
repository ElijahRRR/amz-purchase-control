import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 金额显示。库里存的是 numeric,JSON 里是字符串 —— 不转 number,钱不过浮点。 */
export function money(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const s = String(v);
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s).toFixed(2) : s;
}

/** 分钟数说成人话:90 → 「90 分钟」,1440 → 「24 小时」,4320 → 「3 天」。
 *
 * 只在整除时才换单位 —— 「1.5 天」这种说法要人在脑子里再算一次,
 * 而这个数出现的地方(自动重试那道年龄闸)是要人据此判断「这单还会不会被系统碰」的。
 */
export function minutesText(min: number): string {
  if (min % 1440 === 0 && min >= 1440) return `${min / 1440} 天`;
  if (min % 60 === 0 && min >= 60) return `${min / 60} 小时`;
  return `${min} 分钟`;
}

/** 后端给的是 ISO timestamptz。列表里只要 MM-DD HH:mm。 */
export function shortTime(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fullTime(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
