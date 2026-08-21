"""下单前护栏裁决(服务端做,插件只上报实测值)。

阈值随任务下发、由服务端裁决 —— 改护栏不需要发新插件版本。
厂商的护栏写死在插件里,改一次要全员升级。
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

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
) -> Verdict:
    """输入:任务护栏参数 + 结算页实测值 + 站点当天 → 输出:Verdict。

    判定顺序:先 FBA(最便宜),再限价(业务上最要紧),最后交期。
    """
    if require_fba and is_fba is not True:
        # 注意是 `is not True`,不是 `is False`:**读不到配送方(None)也不放行**。
        # 「未知即放行」等于把 require_fba 变成一句愿望 —— 选择器一旦被 Amazon 改版打掉,
        # 护栏会在无人察觉的情况下整体失效,而库里看起来一切正常。
        # 与交期那条同一个立场:解析不出来一律不放行,交人裁决。
        detail = ("配送方非 Amazon 自营" if is_fba is False
                  else "结算页读不到配送方,按不通过处理")
        return Verdict(False, "NOT_FBA", detail)

    total = _to_decimal(actual_total)
    if total is None:
        return Verdict(False, "PLUGIN_INTERNAL", f"实付金额无法解析:{actual_total!r}")
    if total > price_cap:
        return Verdict(
            False, "PRICE_CAP_EXCEEDED",
            f"实付 {total} 超过限价 {price_cap}",
        )

    # 结算页每个商品面板各有一条交期文案。整单什么时候到,取决于**最晚**的那件,
    # 所以取最晚的一条来判。解析放在这里而不是插件里:改解析规则不用发新插件版本。
    candidates = [r for r in (list(delivery_raws) if delivery_raws else [delivery_raw]) if r]
    if not candidates:
        return Verdict(False, "DELIVERY_UNPARSEABLE", "结算页没读到任何送达时间")

    parsed_pairs: list[tuple[date, str]] = []
    for raw in candidates:
        got = parse_delivery(raw, today=today)
        if got is None:
            # 有一条读不懂就整单转人工。只挑看得懂的那些取最晚,会在
            # 「看不懂的那条其实更晚」时放行一单不该放的。
            return Verdict(False, "DELIVERY_UNPARSEABLE", f"无法解析送达时间:{raw!r}")
        parsed_pairs.append((got, raw))

    parsed, used = max(parsed_pairs, key=lambda pr: pr[0])

    if parsed < today:
        # 解析出过去的日期说明解析本身出错了(Amazon 的预计送达不可能在过去)。
        # 这一条直接堵住厂商那个「减一年」缺陷造成的负数天数放行。
        return Verdict(False, "DELIVERY_UNPARSEABLE",
                       f"解析出过去的日期 {parsed},原文 {used!r}")

    days = (parsed - today).days
    if days > max_delivery_days:
        return Verdict(False, "DELIVERY_TOO_LATE",
                       f"预计 {parsed}({days} 天),超过上限 {max_delivery_days} 天",
                       delivery_date=parsed, delivery_raw_used=used)

    return Verdict(True, delivery_date=parsed, delivery_raw_used=used)


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
