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
# 区间分隔符
_RANGE = re.compile(r"\s+[-–—]\s+")


def parse_delivery(raw: str | None, *, today: date) -> date | None:
    """输入:Amazon 原始文案 + 站点当天日期 → 输出:送达日期;无法解析返回 None。

    解析顺序是有意的,每一条都对应厂商实现里的一个缺陷:

    1. 黑名单先判 —— "Arriving after Christmas" 这类不该被后面的规则蒙对
    2. **区间取结束日** —— 厂商取起始日,让 "Aug 21 - Sep 5" 按 8/21 过闸
    3. **带年份优先于不带年份** —— 厂商的负向断言会把 "August 21, 2026" 回溯成 8 月 2 日
    4. **月日优先于星期几** —— 厂商的星期几分支排在前面,"Monday, Aug 31" 被解析成「下个周一」
    5. 不带年份时**向未来取最近的一年** —— 厂商写反了(超过一个月就减一年),
       产生负数天数差从而放行超期订单
    """
    if not raw:
        return None
    text = raw.strip()
    if not text:
        return None

    for pat in UNPARSEABLE:
        if pat.search(text):
            return None

    # 区间取结束日:"Aug 21 - Sep 5" → "Sep 5"
    parts = _RANGE.split(text)
    if len(parts) > 1:
        text = parts[-1].strip()
        # 结束段可能只有日号("Aug 21 - 25"),补上起始段的月份
        if text.isdigit():
            head = _NO_YEAR.search(parts[0]) or _WITH_YEAR.search(parts[0])
            if head:
                text = f"{head.group(1)} {text}"

    lowered = text.lower()
    if "today" in lowered:
        return today
    if "tomorrow" in lowered:
        return today + timedelta(days=1)

    # 带年份 —— 必须先于不带年份
    m = _WITH_YEAR.search(text)
    if m:
        return _safe_date(int(m.group(3)), _MONTHS[m.group(1).lower()], int(m.group(2)))

    # 月 + 日(无年份)—— 必须先于星期几
    m = _NO_YEAR.search(text)
    if m:
        month, day = _MONTHS[m.group(1).lower()], int(m.group(2))
        return _resolve_year(month, day, today=today)

    # 星期几 —— 只有在完全没有月日信息时才用
    m = _WEEKDAY.search(text)
    if m:
        target = _WEEKDAYS[m.group(1).lower()]
        ahead = (target - today.weekday()) % 7
        return today + timedelta(days=ahead or 7)

    return None


def _resolve_year(month: int, day: int, *, today: date) -> date | None:
    """输入:月日 + 今天 → 输出:向未来取最近的那一年的日期。

    Amazon 的预计送达永远在未来。所以当年若已过去就取下一年 ——
    这正好覆盖跨年场景(12 月 28 日看到 "January 4" 应算明年)。
    厂商的实现是反的:「比一个月后还晚就减一年」,于是 8 月看到 "October 15"
    被算成去年 10 月,天数差变成 -309,闸门直接放行。
    """
    candidate = _safe_date(today.year, month, day)
    if candidate is None:
        return None
    if candidate < today:
        return _safe_date(today.year + 1, month, day)
    return candidate


def _safe_date(year: int, month: int, day: int) -> date | None:
    """输入:年月日 → 输出:date;非法日期(如 2 月 30 日)返回 None 而不是抛异常。"""
    try:
        return date(year, month, day)
    except ValueError:
        return None
