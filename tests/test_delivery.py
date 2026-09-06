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
    ("Aug 25 - Aug 28", date(2026, 8, 28)),
    ("Aug 21 - 25", date(2026, 8, 25)),          # 结束段只有日号,补月份
    ("Sep 10 - Sep 30", date(2026, 9, 30)),
])
def test_vendor_defect_2_range_takes_end(raw, expected):
    assert p(raw) == expected


def test_range_end_date_exact():
    assert p("Aug 21 - Sep 5") == date(2026, 9, 5)


# ── 我们自己的缺口 OG-1:区间只认「空格 + 连字符 + 空格」──────────────────
#
# 与厂商缺陷 2 同型,只是触发条件更窄:`_RANGE` 要求连字符两侧各至少一个空白,
# 于是 Amazon 的紧凑写法 `Sep 8-20` 切不动,退回去取全串第一个月日 = **起始日**。
# 实测(wf/our_gap_proof.py,站点当天 2026-09-06、上限 7 天):同一个区间,
# 只差连字符两侧那两个空格,闸门从「拦截 DELIVERY_TOO_LATE」翻成「放行」。

SEP6 = date(2026, 9, 6)


@pytest.mark.parametrize("raw", [
    "Sep 8 - Sep 20",
    "Sep 8 - 20",
    "Sep 8-20",          # 无空格
    "Sept 8–20",         # en dash 且无空格
    "Sep 8 -20",         # 只有左边有空格
    "Sep 8- 20",         # 只有右边有空格
    "Arriving Sep 8-20 by 8 PM",
])
def test_our_gap_1_compact_range_still_takes_the_end_day(raw):
    """五种写法必须收敛到同一个日子。差一个空格就换一个结论,那不是护栏是掷骰子。"""
    assert p(raw, today=SEP6) == date(2026, 9, 20)


def test_our_gap_1_compact_range_flips_the_guard_back(): 
    """闸门层面再断一次 —— 解析对了但没传到裁决上,等于没修。"""
    from decimal import Decimal

    from services.price_guard import adjudicate

    for raw in ("Sep 8 - Sep 20", "Sep 8-20", "Sept 8–20"):
        v = adjudicate(price_cap=Decimal("999"), max_delivery_days=7,
                       actual_total="10.00", is_fba=True,
                       delivery_raws=[raw], today=SEP6)
        assert v.allow is False and v.error_code == "DELIVERY_TOO_LATE", raw
        assert v.delivery_date == date(2026, 9, 20), raw


@pytest.mark.parametrize("raw", [
    "2-4 business days",      # 没有月名,归一化不许碰它
    "Overnight 12 AM - 8 AM",
])
def test_our_gap_1_range_normalisation_does_not_touch_non_dates(raw):
    """放宽区间正则最容易误伤的两类。它要求连字符**左边必须有月名**,
    所以 "2-4 business days" 和 ISO 日期都碰不到。"""
    assert p(raw, today=SEP6) is None


@pytest.mark.parametrize("raw", [
    "Sep 8 - 10 PM",       # 10 是钟点,不是日号
    "Sep 8 - 10 AM",
])
def test_our_gap_1_a_clock_time_is_not_the_end_of_a_range(raw):
    """区间归一化不许把「几点」读成「几号」。

    "Sep 8 - 10 PM" 归一化成 "Sep 10" 的话,一条我们其实读不懂的文案会变成
    一个看着很确定的日期,而且比真实交期晚两天 —— 编一个日期出来比返回 None 危险。
    """
    assert p(raw, today=SEP6) is None


def test_our_gap_1_iso_date_is_not_a_range():
    """`2026-09-08` 里有两个连字符,但一个月名都没有 —— 归一化不该动它。

    (我们并不解析 ISO 串,这条断的是「没被区间正则拆坏了之后又蒙对/蒙错」。)
    """
    assert p("Delivery 2026-09-08", today=SEP6) is None


# ── 我们自己的缺口 OG-2:取第一个月日 + 无上界地向未来滚一年 ──────────────

def test_our_gap_2_takes_the_latest_month_day_not_the_first():
    """`Ships Sep 3, arrives Sep 12` —— 第一个月日是**发货日**。

    取第一个的后果不只是差几天:Sep 3 在 9/6 那天已经过去,滚年规则把它变成
    2027-09-03,daysDiff=362,这一单被误拦转人工,而运营台详情里印着
    「预计 2027-09-03」—— 一个 Amazon 从未给出的日期。人去核对时会先怀疑
    亚马逊页面,而不是我们的解析器。
    """
    assert p("Ships Sep 3, arrives Sep 12", today=SEP6) == date(2026, 9, 12)


def test_our_gap_2_latest_matches_the_guards_own_stance():
    """取最晚与 price_guard「多条交期取最晚」是同一个立场,不该只在跨条时成立。"""
    assert p("Sep 9 or Sep 14", today=SEP6) == date(2026, 9, 14)
    assert p("Sep 14 or Sep 9", today=SEP6) == date(2026, 9, 14)


def test_our_gap_2_rolling_a_year_forward_has_an_upper_bound():
    """滚过 300 天就返回 None —— 不产出一个 Amazon 从没说过的日期。

    `Aug 21 - Sep 5` 在 2026-09-06 看到:结束日 9/5 昨天刚过,滚一年是 364 天后。
    那不是一条送达日期,是我们读错了段(或者页面本身是旧的)。
    与「带年份那条路解析出过去的日期」一样归 DELIVERY_UNPARSEABLE 转人工。
    """
    assert p("Aug 21 - Sep 5", today=SEP6) is None


def test_our_gap_2_expired_range_is_unparseable_not_a_2027_date():
    """`July 7 - July 10` 在 8/20 看到:滚一年是 324 天后,超界。"""
    assert p("July 7 - July 10") is None


def test_our_gap_2_the_bound_does_not_break_year_rollover():
    """反面:真正的跨年场景必须照旧过 —— 上界拦的是「滚过头」,不是「跨年」。"""
    assert p("Wednesday, January 7", today=SEP6) == date(2027, 1, 7)
    assert p("January 4", today=date(2026, 12, 28)) == date(2027, 1, 4)


def test_our_gap_2_explicit_year_is_never_rolled():
    """页面自己写了年份就照它写的算,上界不适用 —— 那是我们**推断**年份时的闸。

    `August 21, 2026` 在 2026-09-06 是过去的日期,解析照实返回,
    由 price_guard 判成「解析出过去的日期」→ DELIVERY_UNPARSEABLE。
    结论与滚年超界那条一致,但理由不同,不能混成一处。
    """
    from decimal import Decimal

    from services.price_guard import adjudicate

    assert p("August 21, 2026", today=SEP6) == date(2026, 8, 21)
    v = adjudicate(price_cap=Decimal("999"), max_delivery_days=7,
                   actual_total="10.00", is_fba=True,
                   delivery_raws=["August 21, 2026"], today=SEP6)
    assert v.allow is False and v.error_code == "DELIVERY_UNPARSEABLE"


# ── 我们自己的缺口 OG-3:相对词抢在显式日期之前 ──────────────────────────

def test_our_gap_3_explicit_date_beats_relative_word():
    """`Tomorrow, September 8` 必须按页面写出来的 9/8 算,不是 today+1。

    服务端算的站点当天与 Amazon 页面翻页的时刻不会永远一致(美西已经 9/7、
    我们还是 9/6)。差这一天会同时进闸门判定和回填的 delivery_date,
    在 max_delivery_days 边界上把一单本该拦下的放行,而库里记的送达日期
    与 Amazon 订单页对不上 —— 表现为「我们记的日期比亚马逊早一天」这种
    查不出根因的系统性偏移。页面自己写出的月日永远比相对词可信。
    """
    assert p("Or fastest delivery Tomorrow, September 8", today=SEP6) == date(2026, 9, 8)
    assert p("Or fastest delivery Tomorrow, September 7", today=SEP6) == date(2026, 9, 7)


def test_our_gap_3_bare_relative_words_still_work():
    """反面:没有月日的时候相对词照旧管用 —— 它只是降了优先级,不是被删了。"""
    assert p("Tomorrow", today=SEP6) == date(2026, 9, 7)
    assert p("Arriving tomorrow by 10 PM", today=SEP6) == date(2026, 9, 7)
    assert p("Arriving today", today=SEP6) == SEP6


def test_our_gap_3_month_day_still_beats_weekday():
    """相对词插在显式日期与星期几之间,不许把原来那条顺序挤坏。"""
    assert p("Monday, September 8", today=SEP6) == date(2026, 9, 8)
    assert p("Monday", today=SEP6) == date(2026, 9, 7)   # 9/6 是周日


# ── wf/our_delivery_fuzz.py 那一批输入,逐条钉死 ────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("Sep 8 - 10", date(2026, 9, 10)),
    ("Sep 8 -10", date(2026, 9, 10)),
    ("Sep 8- 10", date(2026, 9, 10)),
    ("Sep 8-10", date(2026, 9, 10)),
    ("Sept 8–10", date(2026, 9, 10)),
    ("Sep 8 – 10", date(2026, 9, 10)),
    ("September 10 - September 30", date(2026, 9, 30)),
    ("Aug 21 - Sep 5", None),                       # 滚年超界 → 交人工
    ("Wed, Sep 10 - Fri, Sep 12", date(2026, 9, 12)),
    ("Arriving Sept 12", date(2026, 9, 12)),
    ("Sept 12", date(2026, 9, 12)),
    ("FREE delivery Thursday, September 10", date(2026, 9, 10)),
    ("Or fastest delivery Tomorrow, September 7", date(2026, 9, 7)),
    ("Or fastest delivery Tomorrow, September 8", date(2026, 9, 8)),
    ("Overnight 12 AM - 8 AM", None),
    ("2-4 business days", None),
    ("Arriving after Christmas", None),
    ("Ships Sep 3, arrives Sep 12", date(2026, 9, 12)),
    ("Monday, Sep 21", date(2026, 9, 21)),
    ("Monday, September 8", date(2026, 9, 8)),
    ("Wednesday, January 7", date(2027, 1, 7)),
    ("August 21, 2026", date(2026, 8, 21)),
])
def test_fuzz_corpus_matches_what_a_human_reads(raw, expected):
    """站点当天 2026-09-06。这一批是 wf/our_delivery_fuzz.py 跑出来的语料,
    「人读出来的最晚送达日」就是断言值 —— 读不出一个可信年份的那几条断 None。"""
    assert p(raw, today=SEP6) == expected


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


# ── 多条交期原文:结算页每个商品面板各有一条,整单取最晚的那件 ──────────────

def test_guard_takes_latest_of_many_delivery_texts():
    from datetime import date
    from decimal import Decimal

    from services.price_guard import adjudicate

    today = date(2026, 8, 21)
    v = adjudicate(
        price_cap=Decimal("50.00"), max_delivery_days=7,
        actual_total="10.79", is_fba=True,
        delivery_raws=["Monday, August 24", "Thursday, August 27", "Tuesday, August 25"],
        today=today,
    )
    assert v.allow is True
    assert v.delivery_date == date(2026, 8, 27)
    # 采信的是最晚那条,回填时要写这条原文
    assert v.delivery_raw_used == "Thursday, August 27"


def test_guard_rejects_when_latest_of_many_is_too_late():
    from datetime import date
    from decimal import Decimal

    from services.price_guard import adjudicate

    v = adjudicate(
        price_cap=Decimal("50.00"), max_delivery_days=7,
        actual_total="10.79", is_fba=True,
        delivery_raws=["Monday, August 24", "Friday, September 4"],
        today=date(2026, 8, 21),
    )
    assert v.allow is False
    assert v.error_code == "DELIVERY_TOO_LATE"
    assert v.delivery_raw_used == "Friday, September 4"


def test_guard_rejects_whole_order_when_any_text_unparseable():
    """有一条读不懂就整单转人工。

    只挑看得懂的那些取最晚,会在「看不懂的那条其实更晚」时放行一单不该放的
    —— 这正是厂商那套「解析失败弹窗让人选继续」放走的那类单。
    """
    from datetime import date
    from decimal import Decimal

    from services.price_guard import adjudicate

    v = adjudicate(
        price_cap=Decimal("50.00"), max_delivery_days=7,
        actual_total="10.79", is_fba=True,
        delivery_raws=["Monday, August 24", "Arrives after the holidays"],
        today=date(2026, 8, 21),
    )
    assert v.allow is False
    assert v.error_code == "DELIVERY_UNPARSEABLE"


def test_guard_reports_when_checkout_had_no_delivery_text_at_all():
    from datetime import date
    from decimal import Decimal

    from services.price_guard import adjudicate

    v = adjudicate(
        price_cap=Decimal("50.00"), max_delivery_days=7,
        actual_total="10.79", is_fba=True, delivery_raws=[], today=date(2026, 8, 21),
    )
    assert v.allow is False
    assert v.error_code == "DELIVERY_UNPARSEABLE"


# ── FBA:读不到配送方不等于通过 ────────────────────────────────────────

def test_guard_blocks_when_fba_is_unknown():
    """`is_fba=None`(结算页读不到配送方)也不放行。

    「未知即放行」等于把 require_fba 变成一句愿望:选择器一旦被 Amazon 改版打掉,
    护栏会在无人察觉的情况下整体失效,而库里看起来一切正常 ——
    每一单都是 purchased,没有任何一条错误码提示护栏已经不工作了。

    与交期那条同一个立场:解析不出来一律不放行,交人裁决。
    """
    from datetime import date
    from decimal import Decimal

    from services.price_guard import adjudicate

    v = adjudicate(price_cap=Decimal("50.00"), max_delivery_days=7,
                   actual_total="10.79", is_fba=None,
                   delivery_raws=["Monday, August 24"], today=date(2026, 8, 21))
    assert v.allow is False
    assert v.error_code == "NOT_FBA"
    assert "读不到配送方" in v.detail


def test_guard_blocks_when_not_fba():
    from datetime import date
    from decimal import Decimal

    from services.price_guard import adjudicate

    v = adjudicate(price_cap=Decimal("50.00"), max_delivery_days=7,
                   actual_total="10.79", is_fba=False,
                   delivery_raws=["Monday, August 24"], today=date(2026, 8, 21))
    assert v.allow is False and v.error_code == "NOT_FBA"
    assert "非 Amazon 自营" in v.detail


def test_guard_ignores_fba_when_not_required():
    """require_fba=False 时读不到配送方不该拦 —— 这条闸是可关的。"""
    from datetime import date
    from decimal import Decimal

    from services.price_guard import adjudicate

    v = adjudicate(price_cap=Decimal("50.00"), max_delivery_days=7,
                   actual_total="10.79", is_fba=None, require_fba=False,
                   delivery_raws=["Monday, August 24"], today=date(2026, 8, 21))
    assert v.allow is True
