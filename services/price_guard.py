"""下单前护栏裁决(服务端做,插件只上报实测值)。

阈值随任务下发、由服务端裁决 —— 改护栏不需要发新插件版本。
厂商的护栏写死在插件里,改一次要全员升级。
"""

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


def adjudicate(
    *,
    price_cap: Decimal,
    max_delivery_days: int,
    actual_total: str | Decimal | None,
    delivery_raw: str | None,
    today: date,
    require_fba: bool = True,
    is_fba: bool | None = None,
) -> Verdict:
    """输入:任务护栏参数 + 结算页实测值 + 站点当天 → 输出:Verdict。

    判定顺序:先 FBA(最便宜),再限价(业务上最要紧),最后交期。
    """
    if require_fba and is_fba is False:
        return Verdict(False, "NOT_FBA", "配送方非 Amazon 自营")

    total = _to_decimal(actual_total)
    if total is None:
        return Verdict(False, "PLUGIN_INTERNAL", f"实付金额无法解析:{actual_total!r}")
    if total > price_cap:
        return Verdict(
            False, "PRICE_CAP_EXCEEDED",
            f"实付 {total} 超过限价 {price_cap}",
        )

    parsed = parse_delivery(delivery_raw, today=today)
    if parsed is None:
        # 解析不出来一律转人工,不放行。
        # 厂商那边解析失败时弹窗让操作员选「继续下单」,等于把护栏交给疲劳的人。
        return Verdict(False, "DELIVERY_UNPARSEABLE", f"无法解析送达时间:{delivery_raw!r}")
    if parsed < today:
        # 解析出过去的日期说明解析本身出错了(Amazon 的预计送达不可能在过去)。
        # 这一条直接堵住厂商那个「减一年」缺陷造成的负数天数放行。
        return Verdict(False, "DELIVERY_UNPARSEABLE",
                       f"解析出过去的日期 {parsed},原文 {delivery_raw!r}")

    days = (parsed - today).days
    if days > max_delivery_days:
        return Verdict(False, "DELIVERY_TOO_LATE",
                       f"预计 {parsed}({days} 天),超过上限 {max_delivery_days} 天",
                       delivery_date=parsed)

    return Verdict(True, delivery_date=parsed)


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
