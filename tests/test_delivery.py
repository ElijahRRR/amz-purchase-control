"""交期解析。

每个「厂商缺陷」用例都直接对应 AMZ-Purchase-Assistant 分析 §8.3 里的一条实测缺陷,
是回归护栏:这些格式一旦解析错,交期闸门就会放行超期订单。
"""

from datetime import date

import pytest

from services.delivery import parse_delivery

TODAY = date(2026, 8, 20)


def p(raw, today=TODAY):
    return parse_delivery(raw, today=today)


# ── 基本格式 ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("Today", date(2026, 8, 20)),
    ("Arriving today", date(2026, 8, 20)),
    ("Tomorrow", date(2026, 8, 21)),
    ("Arriving tomorrow by 10 PM", date(2026, 8, 21)),
    ("August 27", date(2026, 8, 27)),
    ("Aug 27", date(2026, 8, 27)),
    ("Thursday, August 27", date(2026, 8, 27)),
    ("Arriving Aug 27", date(2026, 8, 27)),
])
def test_basic_formats(raw, expected):
    assert p(raw) == expected


# ── 厂商缺陷 1:带年份被负向断言回溯截断 ────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("August 21, 2026", date(2026, 8, 21)),      # 厂商解析成 8 月 2 日
    ("September 15, 2026", date(2026, 9, 15)),   # 厂商解析成 9 月 1 日
    ("July 10, 2027", date(2027, 7, 10)),        # 厂商解析成 7 月 1 日
])
def test_vendor_defect_1_year_truncation(raw, expected):
    assert p(raw) == expected


# ── 厂商缺陷 2:区间取起始日而非结束日 ──────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("Aug 21 - Sep 5", date(2026, 9, 5)),        # 厂商取 8/21
    ("July 7 - July 10", date(2026, 7, 10)),     # 厂商取 7/7 —— 注意已过期,见下条
    ("Aug 25 - Aug 28", date(2026, 8, 28)),
    ("Aug 21 - 25", date(2026, 8, 25)),          # 结束段只有日号,补月份
])
def test_vendor_defect_2_range_takes_end(raw, expected):
    got = p(raw)
    # July 7-10 已过 2026-08-20,按「向未来取最近一年」规则应落到 2027
    assert got in (expected, expected.replace(year=expected.year + 1))


def test_range_end_date_exact():
    assert p("Aug 21 - Sep 5") == date(2026, 9, 5)


# ── 厂商缺陷 3:\w{3} 无锚定,"Sept" 被切成 "ept" 落到 2001 年 ───────────

@pytest.mark.parametrize("raw,expected", [
    ("Sept 12", date(2026, 9, 12)),              # 厂商 → 2001-09-12
    ("Arriving Sept 12", date(2026, 9, 12)),
    ("Sep 12", date(2026, 9, 12)),
    ("September 12", date(2026, 9, 12)),
])
def test_vendor_defect_3_sept_abbreviation(raw, expected):
    assert p(raw) == expected


# ── 厂商缺陷 4:跨年方向写反(超过一个月就减一年)──────────────────────

def test_vendor_defect_4_far_future_stays_future():
    """8 月看到 10 月 15 日应是今年 10 月,厂商算成去年 → -309 天 → 放行。"""
    assert p("October 15") == date(2026, 10, 15)


def test_vendor_defect_4_year_rollover():
    """12 月 28 日看到 January 4 应算明年。"""
    assert p("January 4", today=date(2026, 12, 28)) == date(2027, 1, 4)


def test_vendor_defect_4_same_day_is_today_not_next_year():
    assert p("August 20") == date(2026, 8, 20)


# ── 厂商缺陷 6:星期几分支抢在月日之前 ──────────────────────────────────

def test_vendor_defect_6_weekday_does_not_shadow_month_day():
    """"Monday, Aug 31" 必须解析成 8/31,厂商解析成「下一个周一」(8/24)。"""
    assert p("Monday, Aug 31") == date(2026, 8, 31)
    assert p("Monday, August 31") == date(2026, 8, 31)


def test_weekday_only_when_no_month_day():
    # 2026-08-20 是周四;下一个周一是 8/24
    assert p("Monday") == date(2026, 8, 24)


def test_weekday_today_rolls_to_next_week():
    # 今天是周四,单说 "Thursday" 指下周四
    assert p("Thursday") == date(2026, 8, 27)


# ── 不可解析:必须返回 None 交人工,不能蒙一个日期 ──────────────────────

@pytest.mark.parametrize("raw", [
    "Arriving after Christmas",
    "Arrives after the holidays",
    "Delivery before New Year",
    "",
    None,
    "   ",
    "Arriving soon",
    "2-4 business days",
])
def test_unparseable_returns_none(raw):
    assert p(raw) is None


def test_invalid_calendar_date_returns_none():
    assert p("February 30") is None
