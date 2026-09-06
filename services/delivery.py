"""结算页「预计送达」文案解析(服务端做,插件只上报原文)。

为什么放在服务端:厂商插件把这套解析写在客户端 420 行里,被 6 处缺陷架空
(见 AMZ-Purchase-Assistant 的分析 §8.3)。放服务端的好处是改解析规则不用发新插件版本,
且能对同一批原文回归测试。

首期只覆盖 US 站英文文案。刻意**不引第三方日期库**:格式是有限封闭集,显式解析
可读、可测、行为确定;通用库对 "Sept 12" 这类输入的行为反而不可预期。
"""

import re
from datetime import date, timedelta

# 无法解析的已知模式:命中即判定为「不可解析」,由调用方转人工。
# 厂商的做法是弹窗让操作员选「继续下单」,等于把护栏交给疲劳的人。
UNPARSEABLE = (
    re.compile(r"arriv\w*\s+after", re.I),
    re.compile(r"\bChristmas\b", re.I),
    re.compile(r"\bEaster\b", re.I),
    re.compile(r"\bHoliday\b", re.I),
    re.compile(r"\bNew\s+Year\b", re.I),
    re.compile(r"\bValentine", re.I),
    re.compile(r"\bThanksgiving", re.I),
)

_MONTHS = {
    "january": 1, "jan": 1,
    "february": 2, "feb": 2,
    "march": 3, "mar": 3,
    "april": 4, "apr": 4,
    "may": 5,
    "june": 6, "jun": 6,
    "july": 7, "jul": 7,
    "august": 8, "aug": 8,
    "september": 9, "sept": 9, "sep": 9,   # Sept 是 Amazon 常用写法,必须收
    "october": 10, "oct": 10,
    "november": 11, "nov": 11,
    "december": 12, "dec": 12,
}
_MONTH_ALT = "|".join(sorted(_MONTHS, key=len, reverse=True))  # 长的在前,避免 sep 抢了 sept

_WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}

# 带年份:August 21, 2026
_WITH_YEAR = re.compile(rf"\b({_MONTH_ALT})\s+(\d{{1,2}})\s*,\s*(\d{{4}})\b", re.I)
# 不带年份:August 21 / Aug 21 / Sept 12
_NO_YEAR = re.compile(rf"\b({_MONTH_ALT})\s+(\d{{1,2}})\b", re.I)
# 星期几
_WEEKDAY = re.compile(r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.I)
# 区间分隔符:连字符两侧**各要求一个空白**。整段带星期几的写法
# ("Wed, Sep 10 - Fri, Sep 12")靠它切开取结束段。
_RANGE = re.compile(r"\s+[-–—]\s+")
# 「月 日 - [月] 日」整体,**不要求连字符两侧有空白**。
#
# 只有 _RANGE 的时候,Amazon 的紧凑写法 `Sep 8-20`(A/B 实验里常见)切不动,
# 于是退回去取全串第一个月日 = 区间的**起始日**:同一个区间,只差连字符两侧
# 那两个空格,闸门就从「拦截,14 天超上限」翻成「放行,2 天」。
#
# 要求**左边必须有月名**是这条正则不误伤的关键:"2-4 business days" 没有月名,
# ISO 串 "2026-09-08" 也没有,两者都碰不到它。右边的月名可省("Sep 8 - 20")。
_MD_RANGE = re.compile(
    rf"\b({_MONTH_ALT})\s+(\d{{1,2}})\s*[-–—]\s*(?:({_MONTH_ALT})\s+)?(\d{{1,2}})\b", re.I)

#: 不带年份的月日向未来滚一年时,滚出去多远就算「这不可能是一条送达日期」。
#:
#: 没有这个上界会出这种事:`Ships Sep 3, arrives Sep 12` 里的 `Sep 3` 是**发货日**、
#: 在站点当天之前,滚年规则把它变成 2027-09-03 —— 一个 **Amazon 从未给出的日期**,
#: 然后写进 tasks.delivery_date、印在运营台详情上。人去核对时会先怀疑亚马逊页面,
#: 而不是我们的解析器,排查成本被这个凭空捏造的具体日期直接抬高一个量级。
#:
#: 300 天是保守界:亚马逊的预计送达不会这么远,滚过头的那个日期一定是我们读错了段。
#: 超界返回 None,由 price_guard 统一判成 DELIVERY_UNPARSEABLE 转人工 ——
#: 与「带年份那条路解析出过去的日期」的结论对齐。
#:
#: **这个上界只管我们自己推断出来的年份。** 页面白纸黑字写了年份的
#: (`August 21, 2026`)照它写的算,不适用这一条。
MAX_FUTURE_DAYS = 300


def parse_delivery(raw: str | None, *, today: date) -> date | None:
    """输入:Amazon 原始文案 + 站点当天日期 → 输出:送达日期;无法解析返回 None。

    解析顺序是有意的。前五条各对应厂商实现里的一个缺陷,后三条是我们自己踩出来的:

    1. 黑名单先判 —— "Arriving after Christmas" 这类不该被后面的规则蒙对
    2. **区间取结束日** —— 厂商取起始日,让 "Aug 21 - Sep 5" 按 8/21 过闸。
       紧凑写法("Sep 8-20",连字符两侧无空白)也算区间,见 `_MD_RANGE`:
       我们自己曾经只认带空白的那种,差两个空格就换一个结论
    3. **带年份优先于不带年份** —— 厂商的负向断言会把 "August 21, 2026" 回溯成 8 月 2 日
    4. **月日优先于星期几** —— 厂商的星期几分支排在前面,"Monday, Aug 31" 被解析成「下个周一」
    5. 不带年份时**向未来取最近的一年** —— 厂商写反了(超过一个月就减一年),
       产生负数天数差从而放行超期订单
    6. **同一段文案里有多个月日就取最晚的那个**,不是第一个 ——
       "Ships Sep 3, arrives Sep 12" 的第一个是发货日;与 price_guard
       「多条交期取最晚」是同一个立场,不该只在跨条时成立
    7. **向未来滚年有上界**(`MAX_FUTURE_DAYS`)—— 滚过头就返回 None 交人工,
       不产出一个 Amazon 从没说过的 2027 年日期
    8. **显式日期优先于相对词**(today/tomorrow),相对词再优先于星期几 ——
       "Tomorrow, September 8" 按页面写出的 9/8 算。服务端算的站点当天与
       Amazon 页面翻页的时刻不会永远一致,页面自己写出来的月日永远更可信

    读到了月日却定不出一个可信的年份时**返回 None,不再往下猜**(不回退到相对词或
    星期几):页面明明写了日子而我们读不懂,那就是该交人工的情形,
    蒙一个日期出来正是厂商那套「解析失败弹窗让人选继续下单」的另一种形状。
    """
    if not raw:
        return None
    text = raw.strip()
    if not text:
        return None

    for pat in UNPARSEABLE:
        if pat.search(text):
            return None

    # 区间取结束日。先归一化「月 日 - [月] 日」(含无空白的紧凑写法),
    # 剩下的整段区间("Wed, Sep 10 - Fri, Sep 12")再按空白分隔切。
    text = _MD_RANGE.sub(lambda m: f"{m.group(3) or m.group(1)} {m.group(4)}", text)
    parts = _RANGE.split(text)
    if len(parts) > 1:
        text = parts[-1].strip()
        # 结束段可能只有日号("Aug 21 — 25" 这种归一化没吃到的形状),补上起始段的月份
        if text.isdigit():
            head = _NO_YEAR.search(parts[0]) or _WITH_YEAR.search(parts[0])
            if head:
                text = f"{head.group(1)} {text}"

    # 带年份 —— 必须先于不带年份。多个就取最晚的那个。
    dated = [d for d in (_safe_date(int(m.group(3)), _MONTHS[m.group(1).lower()],
                                    int(m.group(2)))
                         for m in _WITH_YEAR.finditer(text))
             if d is not None]
    if dated:
        return max(dated)
    if _WITH_YEAR.search(text):
        return None          # 写了年份但不是一个合法日期(2 月 30 日)—— 不再往下猜

    # 月 + 日(无年份)—— 必须先于相对词,也必须先于星期几
    if _NO_YEAR.search(text):
        resolved = [d for d in (_resolve_year(_MONTHS[m.group(1).lower()], int(m.group(2)),
                                              today=today)
                                for m in _NO_YEAR.finditer(text))
                    if d is not None]
        return max(resolved) if resolved else None

    # 相对词 —— 只有在页面完全没写出月日时才用
    lowered = text.lower()
    if "today" in lowered:
        return today
    if "tomorrow" in lowered:
        return today + timedelta(days=1)

    # 星期几 —— 只有在完全没有月日、也没有相对词时才用
    m = _WEEKDAY.search(text)
    if m:
        target = _WEEKDAYS[m.group(1).lower()]
        ahead = (target - today.weekday()) % 7
        return today + timedelta(days=ahead or 7)

    return None


def _resolve_year(month: int, day: int, *, today: date) -> date | None:
    """输入:月日 + 今天 → 输出:向未来取最近的那一年的日期;滚过头返回 None。

    Amazon 的预计送达永远在未来。所以当年若已过去就取下一年 ——
    这正好覆盖跨年场景(12 月 28 日看到 "January 4" 应算明年)。
    厂商的实现是反的:「比一个月后还晚就减一年」,于是 8 月看到 "October 15"
    被算成去年 10 月,天数差变成 -309,闸门直接放行。

    **但向未来滚年是有上界的**(`MAX_FUTURE_DAYS`)。无上界地滚,
    "Ships Sep 3, arrives Sep 12" 里那个已经过去的 `Sep 3` 会变成 2027-09-03 ——
    一个 Amazon 从未给出的日期,却带着具体到日的可信外观进了库和界面。
    滚出去太远说明这根本不是一条送达日期(多半是发货日,或者我们读错了段),
    返回 None 交人工比编一个具体日期诚实。
    """
    candidate = _safe_date(today.year, month, day)
    if candidate is None:
        return None
    if candidate >= today:
        return candidate
    nxt = _safe_date(today.year + 1, month, day)
    if nxt is None or (nxt - today).days > MAX_FUTURE_DAYS:
        return None
    return nxt


def _safe_date(year: int, month: int, day: int) -> date | None:
    """输入:年月日 → 输出:date;非法日期(如 2 月 30 日)返回 None 而不是抛异常。"""
    try:
        return date(year, month, day)
    except ValueError:
        return None
