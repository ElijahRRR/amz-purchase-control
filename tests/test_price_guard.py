"""护栏裁决:比的那个数必须是「这一单的货款」。

这一整个文件盯的是同一件事的几个面:

    readGrandTotal 读到的 `.grand-total-cell` 是**这张卡要扣的钱**。
    买家号里躺着礼品卡余额时,它是抵扣**之后**的数,全额抵扣就是 0.00。

在这之前 adjudicate 只有两条金额判据:「读不到就拒」和「超限价就拒」,
**没有下界**。实测(SP/wf/probe_price_guard.py,直接 import 我们自己的函数):

    actual_total="2241.86" → allow=True
    actual_total="0.00"    → allow=True     ← 礼品卡全额抵扣就长这样
    actual_total="0"       → allow=True
    actual_total="-5.09"   → allow=True

配上礼品卡就是:限价护栏在任何用礼品卡的买家号上整体失效,
而库里落一个 0.00、运营台上画个绿点写「未超」—— 一切正常。

与 README「几条贯穿全项目的判断」里那条已经出现过一次的缺陷是同一个:
「详情弹窗在没有实付金额时画绿点写『未超』」。上一次的触发值是 null(已修),
这一次是 0.00。
"""

from datetime import date
from decimal import Decimal

import pytest

from services.price_guard import adjudicate

TODAY = date(2026, 8, 21)
RAWS = ["Thursday, August 28"]


def guard(**kw):
    """默认是一张能过的单:FBA、交期正常、限价 2500。只把要试的那几项覆盖掉。"""
    base = dict(price_cap=Decimal("2500.00"), max_delivery_days=7,
                actual_total="2241.86", delivery_raws=RAWS, today=TODAY,
                require_fba=True, is_fba=True)
    base.update(kw)
    return adjudicate(**base)


# ── 礼品卡:货款 = 实付 + 抵扣 ──────────────────────────────────────────

def test_gift_card_is_added_back_before_comparing_with_the_cap():
    """礼品卡全额抵扣:实付 0.00,货款仍然是 2241.86,护栏比的是后者。"""
    v = guard(actual_total="0.00", gift_card_applied=True, gift_card_amount="2241.86")
    assert v.allow is True
    assert v.goods_total == Decimal("2241.86")
    assert v.gift_card_amount == Decimal("2241.86")


def test_the_exact_scenario_that_used_to_pass_now_gets_blocked():
    """实测复现过的那一单:真值 2241.86,礼品卡垫 1100,限价 1200。

    修之前 adjudicate 收到的是 actual_total=1141.86 → 1141.86 ≤ 1200 → 放行,
    并把 1141.86 当成成交额写进库。同一张任务卡上,「一张真值 1141.86 的单」
    与「一张真值 2241.86、礼品卡垫了 1100 的单」长得一模一样。
    """
    v = guard(price_cap=Decimal("1200.00"), actual_total="1141.86",
              gift_card_applied=True, gift_card_amount="1100.00")
    assert v.allow is False and v.error_code == "PRICE_CAP_EXCEEDED"
    assert v.goods_total == Decimal("2241.86")
    # 详情里要同时说清两个数,不然运营看着「货款 2241.86 超限价」会去问
    # 「可我这单明明只刷了 1141.86」
    assert "1141.86" in v.detail and "1100.00" in v.detail


def test_gift_card_applied_but_amount_unknown_is_refused():
    """认出抵扣行却读不出金额 → 拒。

    退回去当成「没有礼品卡」是最坏的选择:护栏会拿一个偏小的数去比限价,
    而库里看起来一切正常。这一档必须停下来。
    """
    v = guard(actual_total="0.00", gift_card_applied=True, gift_card_amount=None)
    assert v.allow is False and v.error_code == "PLUGIN_INTERNAL"
    assert "读不出抵扣金额" in v.detail
    assert v.goods_total is None      # 算不出来就是算不出来,不许编一个


def test_gift_card_amount_zero_is_not_the_same_as_unknown():
    """插件明确报「抵扣 0.00」时按 0 算 —— 于是货款 = 实付,该拒的照拒。

    这一条与上一条一起把「不知道」和「知道是 0」分开:两者渲染出同一个结果
    才是缺陷,分开之后各走各的判据。
    """
    v = guard(actual_total="0.00", gift_card_applied=True, gift_card_amount="0.00")
    assert v.allow is False and v.error_code == "PLUGIN_INTERNAL"
    assert "货款读成 0.00" in v.detail


def test_negative_gift_card_amount_is_refused():
    """抵扣额是个**量**。负数意味着解析层把符号或格子读错了,不许拿它加回去。"""
    v = guard(actual_total="2241.86", gift_card_applied=True, gift_card_amount="-100.00")
    assert v.allow is False and v.error_code == "PLUGIN_INTERNAL"
    assert "负数" in v.detail


def test_gift_card_not_applied_leaves_goods_total_equal_to_actual_total():
    v = guard()
    assert v.allow is True
    assert v.goods_total == Decimal("2241.86")
    assert v.gift_card_amount is None


# ── 下界:0 与负数 ──────────────────────────────────────────────────────

@pytest.mark.parametrize("total", ["0.00", "0", "-5.09"])
def test_no_gift_card_and_non_positive_total_is_refused(total):
    """这三个取值在修之前**全部放行**(实测见文件头)。"""
    v = guard(actual_total=total)
    assert v.allow is False and v.error_code == "PLUGIN_INTERNAL"
    assert "不可信" in v.detail


def test_unreadable_total_still_refused():
    """原有的那条判据不许被新逻辑挤掉。"""
    for bad in ("", None, "$10.79"):
        v = guard(actual_total=bad)
        assert v.allow is False and v.error_code == "PLUGIN_INTERNAL", bad
        assert "无法解析" in v.detail


# ── 支付方式:配了期望卡才校验 ────────────────────────────────────────

def test_expected_card_blank_means_this_gate_is_off():
    """留空 = 这个买家号不校验支付方式,与 require_fba 同一形态。"""
    for blank in (None, "", "   "):
        assert guard(expected_card_last4=blank, payment_last4="9021").allow is True


def test_card_mismatch_is_blocked_before_the_order_is_placed():
    v = guard(expected_card_last4="4417", payment_last4="9021")
    assert v.allow is False and v.error_code == "PAYMENT_METHOD_UNEXPECTED"
    assert "9021" in v.detail and "4417" in v.detail


def test_card_unreadable_counts_as_mismatch():
    """「读不出来就放行」的闸,在选择器被改版打掉那天会无声失效。

    与 require_fba 那条(`is not True`,读不到也不放行)同一个立场。
    """
    v = guard(expected_card_last4="4417", payment_last4=None)
    assert v.allow is False and v.error_code == "PAYMENT_METHOD_UNEXPECTED"
    assert "读不出来" in v.detail


def test_card_match_passes():
    assert guard(expected_card_last4="4417", payment_last4="4417").allow is True


def test_payment_gate_runs_before_the_money_gates():
    """卡不对时报的是 PAYMENT_METHOD_UNEXPECTED,不是别的码。

    顺序本身是有含义的:支付这一条与金额无关,先判它,运营拿到的就是
    「去换回那张卡」而不是「金额读坏了」这两句完全不同的话。
    """
    v = guard(actual_total="0.00", expected_card_last4="4417", payment_last4="9021")
    assert v.error_code == "PAYMENT_METHOD_UNEXPECTED"


# ── 拆分支付:这道闸只管第一张卡的话,比没有这道闸更危险 ──────────────

def test_split_payment_slots_edge_values_never_block_on_their_own():
    """0 / 1 / 老形态页面 —— 这几档都不是拆分支付,一个都不许拦。

    结算页有一种老形态:卡文案直接放在支付面板里,根本没有
    selected-payment-method 这层壳,槽位数真的是 0(夹具 checkout.html 就是)。
    把 0 判成异常,等于在这种页面上把每一单都拦下。
    """
    card = dict(expected_card_last4="4417", payment_last4="4417")
    for slots in (None, 0, 1):
        assert guard(payment_slots=slots, **card).allow is True, slots
    # 礼品卡占掉一个槽位之后只剩一张卡
    assert guard(payment_slots=2, gift_card_applied=True,
                 gift_card_amount="100.00", **card).allow is True
    # 礼品卡报了 applied 但页面上没数出槽位:cards 会算成 -1,同样不许拦
    assert guard(payment_slots=0, gift_card_applied=True,
                 gift_card_amount="100.00", **card).allow is True


def test_split_payment_blocks_before_any_money_is_read():
    """判定顺序:支付这条在金额之前。

    理由是运营拿到的应该是「去核对这个买家号的支付方式」,
    而不是一句与此无关的金额话术。这里给一个连解析都过不去的实付,
    错误码仍然必须是支付那条。
    """
    v = guard(actual_total="读不动的东西", payment_slots=3,
              expected_card_last4="4417", payment_last4="4417")
    assert v.allow is False and v.error_code == "PAYMENT_METHOD_UNEXPECTED"


# ── 自洽记录:不拦单,但要留痕 ────────────────────────────────────────

def test_consistency_note_is_silent_when_the_numbers_line_up():
    """夹具那张单:2048.49 商品 + 12.99 运费 + 180.38 税 = 2241.86,差 8.6%。

    默认阈值 15%,所以这一单**不该**记一笔 —— 一条每单都出现的告警等于没有。
    """
    v = guard(line_items=[{"asin": "B0FB3VS68J", "unit_price": "1299.99", "quantity": 1},
                          {"asin": "B0CHXNPXVX", "unit_price": "249.50", "quantity": 3}])
    assert v.allow is True and v.consistency_note is None


def test_consistency_note_when_half_the_unit_prices_are_missing():
    """两件商品只报上来一行 —— 护栏不受影响,但这件事必须看得见。

    实测形态:Amazon 改版后单价选择器只对第一个面板生效,priced.length=1
    不为 0,插件那条「一个都没读到」的告警不触发,库里第二件的
    actual_unit_price 是 NULL,运营台上半列空着,没有任何事件说明为什么。
    """
    v = guard(line_items=[{"asin": "B0FB3VS68J", "unit_price": "1299.99", "quantity": 1}])
    assert v.allow is True                      # **不拦单**
    assert v.consistency_note is not None
    assert "1299.99" in v.consistency_note


def test_consistency_note_threshold_comes_from_settings(monkeypatch):
    """阈值是可调参数,只准从 registry/settings 取(铁律 3)。"""
    items = [{"asin": "A", "unit_price": "2000.00", "quantity": 1}]
    monkeypatch.setenv("AMZ_PRICE_CONSISTENCY_TOLERANCE_PCT", "5")
    assert guard(line_items=items).consistency_note is not None
    monkeypatch.setenv("AMZ_PRICE_CONSISTENCY_TOLERANCE_PCT", "50")
    assert guard(line_items=items).consistency_note is None


def test_consistency_note_reports_unreadable_rows_instead_of_silently_skipping():
    v = guard(line_items=[{"asin": "A", "unit_price": None, "quantity": 1}])
    assert v.allow is True
    assert "读不动" in v.consistency_note


def test_consistency_note_survives_a_block():
    """被拦下的单也要带着这句话 —— 事后复盘时它常常是唯一的线索。

    这条测试自己曾经是「看起来有人盯着」的那种:名字和 docstring 都说的是
    consistency_note,断言里却一条 note 都没有,只断了 goods_total。
    而当时的实现恰好在限价这条路上把 note 丢了(算它的那一句写在两条
    return 之后),把 `_consistency_note` 整个改成 `return None` 这条照样绿。
    """
    v = guard(price_cap=Decimal("10.00"),
              line_items=[{"asin": "A", "unit_price": "1.00", "quantity": 1}])
    assert v.allow is False and v.error_code == "PRICE_CAP_EXCEEDED"
    assert v.goods_total == Decimal("2241.86")
    # 正在拿这个数拦单的时候最该看得见它:2241.86 的货款配上只报了 1.00 的单价,
    # 要么是这单真超了,要么是基数读坏了 —— 这句话是区分两者的唯一线索。
    assert v.consistency_note is not None
    assert "1.00" in v.consistency_note and "2241.86" in v.consistency_note


def test_consistency_note_survives_the_lower_bound_block_when_rows_are_unreadable():
    """下界那条 return 也得带上它 —— 与限价那条同一个理由。

    货款读成 0 时**没有百分比可算**(分母是它),那种情况 note 是 None 是
    设计如此,不是漏了:一个「0 与 2241.86 差 ∞%」的句子帮不上任何人。
    但「报上来的行本身就读不动」这一类与货款多少无关,必须照样带出来。
    """
    v = guard(actual_total="0.00",
              line_items=[{"asin": "A", "unit_price": None, "quantity": 1}])
    assert v.allow is False and v.error_code == "PLUGIN_INTERNAL"
    assert v.consistency_note is not None and "读不动" in v.consistency_note

    # 对照:行读得动、只是货款是 0 —— 这一档 note 就该是 None
    v2 = guard(actual_total="0.00",
               line_items=[{"asin": "A", "unit_price": "1299.99", "quantity": 1}])
    assert v2.allow is False and v2.consistency_note is None
