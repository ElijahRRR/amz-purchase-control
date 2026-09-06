"""下单前护栏裁决(服务端做,插件只上报实测值)。

阈值随任务下发、由服务端裁决 —— 改护栏不需要发新插件版本。
厂商的护栏写死在插件里,改一次要全员升级。
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

from registry import settings
from services.delivery import parse_delivery


@dataclass(frozen=True)
class Verdict:
    """裁决结果。allow=False 时 error_code 必填。"""

    allow: bool
    error_code: str | None = None
    detail: str | None = None
    delivery_date: date | None = None
    #: 最终采信的那一条交期原文。结算页上每个商品面板各有一条,取最晚的那条;
    #: 回填时要写进 tasks.delivery_raw 的就是它,不能让插件自己另挑一条。
    delivery_raw_used: str | None = None
    #: **真正拿去跟 price_cap 比的那个数** = 实付 + 礼品卡抵扣。
    #: 服务端自己算,不采信插件算好的那份。落进 tasks.goods_total,
    #: 也回给插件让它的日志写的是这次真发生过的比较。
    #: 算不出来时是 None(那种情况一定 allow=False)。
    goods_total: Decimal | None = None
    #: 礼品卡抵扣额(服务端解析后的值),None = 这一单没有礼品卡抵扣。
    gift_card_amount: Decimal | None = None
    #: **非阻断**的自洽记录:Σ单价×数量 与货款差得离谱时的一句话。
    #: 不拦单 —— 它是可观测性,不是护栏。写进 guard_check 事件的载荷。
    consistency_note: str | None = None


def adjudicate(
    *,
    price_cap: Decimal,
    max_delivery_days: int,
    actual_total: str | Decimal | None,
    delivery_raw: str | None = None,
    delivery_raws: Sequence[str] | None = None,
    today: date,
    require_fba: bool = True,
    is_fba: bool | None = None,
    gift_card_applied: bool = False,
    gift_card_amount: str | Decimal | None = None,
    expected_card_last4: str | None = None,
    payment_last4: str | None = None,
    line_items: Sequence[Mapping] | None = None,
) -> Verdict:
    """输入:任务护栏参数 + 结算页实测值 + 站点当天 → 输出:Verdict。

    判定顺序:FBA → 支付方式 → 货款(下界 + 限价)→ 交期。
    前两条最便宜且与金额无关,限价在业务上最要紧,交期要解析所以放最后。

    **限价比的是「这一单的货款」,不是「这张卡要扣的钱」。**
    买家号里有礼品卡余额时,结算页 grand-total-cell 上写的是抵扣之后的数
    (全额抵扣就是 0.00)。拿它比限价,护栏在任何用礼品卡的买家号上整体失效,
    而库里和界面上一切正常 —— 实测:礼品卡垫 1100 的 2241.86 元单,
    price_cap=1200 照样放行。所以这里自己算:

        goods_total = actual_total + gift_card_amount

    插件也算了一份并报上来,但**不采信** —— 「如果价格超过限价就…」这类判断
    放在被管的一方手里,闸门就不成其为闸门。
    """
    if require_fba and is_fba is not True:
        # 注意是 `is not True`,不是 `is False`:**读不到配送方(None)也不放行**。
        # 「未知即放行」等于把 require_fba 变成一句愿望 —— 选择器一旦被 Amazon 改版打掉,
        # 护栏会在无人察觉的情况下整体失效,而库里看起来一切正常。
        # 与交期那条同一个立场:解析不出来一律不放行,交人裁决。
        detail = ("配送方非 Amazon 自营" if is_fba is False
                  else "结算页读不到配送方,按不通过处理")
        return Verdict(False, "NOT_FBA", detail)

    # ── 支付方式:配了期望卡才校验,留空 = 这个买家号不看这一条 ──
    #
    # 只校验,**不替买家号切卡**。厂商 v2.5.3 会点开 payselect 页勾选指定尾号的卡
    # 再确认下单 —— 改一个买家号的支付配置是人的动作,不是拍单流程的动作。
    # 这道闸放在下单**之前**:此前 payment_last4 是纯写入-展示字段,
    # 换了卡要等对账时有人逐条比库里的尾号和银行流水才会发现。
    if expected_card_last4:
        want = expected_card_last4.strip()
        if want and payment_last4 != want:
            got = payment_last4 or "读不出来"
            # 读不到也算不符:一道「读不出来就放行」的闸,在选择器被改版打掉那天
            # 会在无人察觉的情况下整体失效 —— 与 require_fba 那条同一个立场。
            return Verdict(False, "PAYMENT_METHOD_UNEXPECTED",
                           f"结算页选中的卡尾号是 {got},"
                           f"这个买家号配的是 {want} —— 不下单,交人核对")

    total = _to_decimal(actual_total)
    if total is None:
        return Verdict(False, "PLUGIN_INTERNAL", f"实付金额无法解析:{actual_total!r}")

    # ── 货款 = 实付 + 礼品卡抵扣 ──
    gift = _to_decimal(gift_card_amount) if gift_card_applied else None
    if gift_card_applied and gift is None:
        # 认出了抵扣行却读不出金额:货款基数算不出来。
        # 这一档必须**拒**而不是退回去当成没有礼品卡 —— 后者会让护栏拿
        # 一个偏小的数去比限价,而库里看起来一切正常。
        return Verdict(False, "PLUGIN_INTERNAL",
                       f"结算页认出礼品卡抵扣行但读不出抵扣金额({gift_card_amount!r}),"
                       f"这一单的货款算不出来,不下单")
    if gift is not None and gift < 0:
        return Verdict(False, "PLUGIN_INTERNAL",
                       f"礼品卡抵扣读成负数 {gift},这个数不可信,不下单")
    goods = total + (gift or Decimal(0))

    # 自洽记录**在任何 return 之前**算出来。它是非阻断信号,但恰恰在
    # 「护栏正拿这个数拦单」的时候最该看得见:一张货款 2241.86、
    # Σ单价×数量 只报上来 1.00(单价选择器半坏)的单被限价拦下时,
    # 运营要判断的是「这单真超了」还是「基数读坏了」,而这句话是唯一的线索。
    # 原先它写在下界与限价两条 return **之后**,于是那两条路上永远是 None ——
    # 只有交期那几条阻断带得上它。
    note = _consistency_note(line_items, goods)

    # 下界。判的是**货款**不是实付:礼品卡全额抵扣的单实付确实是 0.00,那是对的;
    # 而货款 0(或负)只有两种来源 —— 金额还在 shimmer,或者选择器读错了格子。
    # 没有礼品卡时 goods == total,所以这一条同时是「实付 0 不许放行」。
    # 原先这里只有「读不到就拒」和「超限价就拒」,**没有下界**:
    # 实测 actual_total 取 "0.00" / "0" / "-5.09" 三种值,adjudicate 全部放行。
    if goods <= 0:
        return Verdict(False, "PLUGIN_INTERNAL",
                       f"结算页货款读成 {goods}(实付 {total}"
                       + (f",礼品卡抵扣 {gift}" if gift is not None else "")
                       + "),这个数不可信,不下单",
                       goods_total=goods, gift_card_amount=gift, consistency_note=note)

    if goods > price_cap:
        return Verdict(
            False, "PRICE_CAP_EXCEEDED",
            f"货款 {goods} 超过限价 {price_cap}"
            + (f"(实付 {total},其中礼品卡抵扣 {gift})" if gift is not None else ""),
            goods_total=goods, gift_card_amount=gift, consistency_note=note,
        )

    # 结算页每个商品面板各有一条交期文案。整单什么时候到,取决于**最晚**的那件,
    # 所以取最晚的一条来判。解析放在这里而不是插件里:改解析规则不用发新插件版本。
    candidates = [r for r in (list(delivery_raws) if delivery_raws else [delivery_raw]) if r]
    if not candidates:
        return Verdict(False, "DELIVERY_UNPARSEABLE", "结算页没读到任何送达时间",
                       goods_total=goods, gift_card_amount=gift, consistency_note=note)

    parsed_pairs: list[tuple[date, str]] = []
    for raw in candidates:
        got = parse_delivery(raw, today=today)
        if got is None:
            # 有一条读不懂就整单转人工。只挑看得懂的那些取最晚,会在
            # 「看不懂的那条其实更晚」时放行一单不该放的。
            return Verdict(False, "DELIVERY_UNPARSEABLE", f"无法解析送达时间:{raw!r}",
                           goods_total=goods, gift_card_amount=gift, consistency_note=note)
        parsed_pairs.append((got, raw))

    parsed, used = max(parsed_pairs, key=lambda pr: pr[0])

    if parsed < today:
        # 解析出过去的日期说明解析本身出错了(Amazon 的预计送达不可能在过去)。
        # 这一条直接堵住厂商那个「减一年」缺陷造成的负数天数放行。
        return Verdict(False, "DELIVERY_UNPARSEABLE",
                       f"解析出过去的日期 {parsed},原文 {used!r}",
                       goods_total=goods, gift_card_amount=gift, consistency_note=note)

    days = (parsed - today).days
    if days > max_delivery_days:
        return Verdict(False, "DELIVERY_TOO_LATE",
                       f"预计 {parsed}({days} 天),超过上限 {max_delivery_days} 天",
                       delivery_date=parsed, delivery_raw_used=used,
                       goods_total=goods, gift_card_amount=gift, consistency_note=note)

    return Verdict(True, delivery_date=parsed, delivery_raw_used=used,
                   goods_total=goods, gift_card_amount=gift, consistency_note=note)


def _consistency_note(line_items: Sequence[Mapping] | None,
                      goods: Decimal) -> str | None:
    """输入:结算页实测的行 + 服务端算出的货款 → 输出:一句话,或 None。

    **不是护栏,是可观测性。** 超了不拦单 —— 商品面板的单价是税前不含运费的,
    与货款天然有差,拿它当闸会把正常单拦一片。

    它答的是另一个问题:「这一单有几件商品的价格我们其实没看见」。
    line_items 此前是收了不用的:GuardCheckReq 收下它,routes 从不往这里传,
    adjudicate 的签名里压根没有这个参数。于是护栏与单价之间没有任何交叉验证 ——
    礼品卡金额哪天读错了(货款基数整个偏掉),也没有第二个数能发现。

    阈值从 registry/settings 取(铁律 3)。
    """
    if not line_items:
        return None
    total = Decimal(0)
    for item in line_items:
        price = _to_decimal(item.get("unit_price"))
        qty = item.get("quantity")
        if price is None or not isinstance(qty, int) or qty <= 0:
            # 报上来的行本身就读不动:这件事值得记一笔,但不在这里下结论
            return f"实测单价里有读不动的行({item!r}),没法与货款 {goods} 对账"
        total += price * qty
    if total <= 0 or goods <= 0:
        return None
    tol = settings.price_consistency_tolerance_pct()
    diff_pct = abs(goods - total) / goods * 100
    if diff_pct <= tol:
        return None
    return (f"Σ单价×数量 = {total},与货款 {goods} 差 {diff_pct:.1f}%"
            f"(阈值 {tol}%)。不拦单 —— 结算页单价是税前不含运费的,天然有差;"
            f"差得离谱通常意味着少读了几条单价,或者礼品卡抵扣读错了")


def _to_decimal(value) -> Decimal | None:
    """输入:金额(字符串/Decimal/数字)→ 输出:Decimal;不可解析返回 None。

    只接受纯数字串。带货币符号的字符串在这里就拒绝 —— 金额必须在进入系统前
    就是结构化的,不能像厂商那样一路存 "$10.79" 甚至 "￥1,234\\n(￥0)"。
    """
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
