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

/** 限价这一条到底核过没有、核出什么结果 —— **界面上唯一的定义处**。
 *
 * 这个项目已经在同一个坑里栽过两次,两次都是「两种不同的情况渲染出同一个结果」:
 *
 *   第一次(已修):`actual_total` 是 null 时整个表达式是假值,落进 else 分支,
 *   画绿点写「未超」。那是一个**从来没算过的护栏结论**,长得跟真算过的一模一样。
 *
 *   第二次(这次):`actual_total` 是 "0.00" 时照样落进那个分支。而 0.00 正是
 *   礼品卡全额抵扣的单在结算页上的样子 —— 一张货款 2241.86、限价 1000 的单,
 *   详情页会写「总计 $0.00 · 限价 $1,000.00,未超」并配一个绿点。
 *
 * 所以判据收成一处,四态:
 *   · **外部下单**              → 不适用(石板灰)。那一单没走过我们的结算页,
 *                                 price_cap 是个占位的 0 —— 拿它去比会得出
 *                                 「0 ≥ 0,未超」这种从没发生过的护栏结论
 *   · 没有任何数可比            → 没法核(空心琥珀)
 *   · 有数,但 ≤ 0              → 没法核(空心琥珀)。金额还在 shimmer,或者读错了格子
 *   · 有礼品卡抵扣              → 照常判超没超,但文案必须把两个数都说出来
 *   · 其余                      → 照常
 *
 * **「不适用」与「没法核」必须是两档。** 后者说的是「本该核、这次没核成」,
 * 看到它的人会去查;外部单根本没有限价这回事,渲染成同一句会让人去查一批
 * 其实一切正常的单。服务端那边的同一套判据在 services/task_query.over_cap。
 *
 * 比的是**货款**(goods_total,服务端在护栏那一步真正比过的那个数),
 * 没有它才退回 actual_total —— 强制回填的单和这一列落库之前的历史单没有它。
 * 服务端那边的同一套判据在 services/task_query.over_cap / cap_basis。
 */
export type CapVerdict = {
  state: "unknown" | "over" | "within" | "not_applicable";
  tone: "amber-hollow" | "red" | "emerald" | "dashed-zinc";
  /** 真正拿去跟限价比的那个数;没法核 / 不适用时是 null。 */
  basis: string | null;
  text: string;
};

export function capVerdict(t: {
  price_cap: string;
  actual_total: string | null;
  goods_total?: string | null;
  gift_card_amount?: string | null;
  purchase_source?: string;
}): CapVerdict {
  // 外部下单先判:限价这一条对它不成立,不是「这次没核成」。
  if (t.purchase_source === "external") {
    return { state: "not_applicable", tone: "dashed-zinc", basis: null,
             text: "外部下单 —— 这一单不经本系统采购,限价这一条不适用" };
  }
  const raw = t.goods_total ?? t.actual_total;
  const cap = Number(t.price_cap);
  if (raw === null || raw === undefined || raw === "") {
    return { state: "unknown", tone: "amber-hollow", basis: null,
             text: `实付金额没回传,限价 ${money(t.price_cap)} 这一条没法核` };
  }
  const basis = Number(raw);
  if (!Number.isFinite(basis) || basis <= 0) {
    return { state: "unknown", tone: "amber-hollow", basis: raw,
             text: `实付读成 ${money(raw)},这个数不可信 —— 限价这一条没法核` };
  }
  const gift = t.gift_card_amount;
  const withGift = gift !== null && gift !== undefined && gift !== ""
    ? `货款 ${money(raw)}(其中礼品卡抵扣 ${money(gift)}),限价 ${money(t.price_cap)}`
    : null;
  if (basis > cap) {
    return { state: "over", tone: "red", basis: raw,
             text: withGift ? `${withGift},超 ${money(String(basis - cap))}`
                            : `超限价 ${money(String(basis - cap))}` };
  }
  return { state: "within", tone: "emerald", basis: raw,
           text: withGift ? `${withGift},未超` : `限价 ${money(t.price_cap)},未超` };
}

/** 这一单**此刻**在不在自动重试的射程里 —— **界面上唯一的定义处**。
 *
 * 条件与 `services/task_retry._CANDIDATE_SQL` 的选单一一对应,少判一条,
 * 界面就会替系统许一个它不会兑现的诺:
 *  ① 开着(`meta.auto_retry.enabled`)
 *  ② `status = 'exception'`(`manual` 那一桶系统不碰 —— 「等人裁决」的单
 *     由系统替人做决定的话,那道闸就白设了)
 *  ③ 码在 `RETRYABLE` 那一组
 *  ④ **没越过下单点**(`AND NOT t.may_have_ordered`)。这一档真实可达:
 *     越过下单点之后抛 DriverError,码落在 RETRYABLE 里、单却已经花过钱
 *  ⑤ 失败没超过 `max_age_min`。年龄由服务端用库里的 now() 算好
 *     (`updated_age_seconds`),前端不拿浏览器时钟去减 —— 两把尺子对不上的话,
 *     界面会在「系统还会再试」和「太久了,系统不会碰它」之间说错话
 *
 * 「已经重满 max 次」**不在这里判**:那时「上限 N 次」这句话仍然成立,
 * 而且正是要让人看见它已经用满了。
 *
 * 收在这一处,是因为详情弹窗与列表都要用它 —— 两边各写一遍的话,迟早一边说
 * 「系统会来重」、另一边说「要人去点」,而这两句话指向相反的动作。
 */
export function autoRetryApplies(
  t: { status: string; error_code: string | null; may_have_ordered: boolean;
       updated_age_seconds: number },
  auto: { enabled: boolean; max_age_min: number },
  retryable: readonly string[],
): boolean {
  return auto.enabled
    && t.status === "exception"
    && !!t.error_code
    && retryable.includes(t.error_code)
    && !t.may_have_ordered
    && t.updated_age_seconds < auto.max_age_min * 60;
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
