"""错误码封闭集 —— 事实来源在 docs/01-系统设计.md §4,这里是它的可执行镜像。

为什么要有这个模块:CLAUDE.md 写着「错误码是封闭集,由 services/task_event.py 校验」,
但在 2026-08-21 之前 task_event 只校验了 kind,**从没校验过 code**。
也就是说插件传什么码就写什么码,封闭集只存在于文档里。
这正是本项目反复遇到的那类问题:「看起来有护栏、实际防不住」比没有护栏更危险 ——
读文档的人以为库里的 error_code 是可枚举的,于是照着它建统计和处置 SOP。

改动流程:先改 docs/01-系统设计.md §4,再改这里,两边必须一字不差。
"""

#: code → 中文含义。界面上只出现中文,英文码降为旁边的灰色小字。
LABELS: dict[str, str] = {
    "OUT_OF_STOCK": "商品无货",
    "QTY_UNAVAILABLE": "目标数量不可选",
    "ADD_TO_CART_FAILED": "加购后未跳转",
    "BUNDLE_PRODUCT": "捆绑商品,需人工",
    "NOT_FBA": "配送方非 Amazon",
    "CART_MISMATCH": "购物车与任务不符",
    "ADDRESS_FORM_TIMEOUT": "地址表单加载超时",
    "ADDRESS_STATE_UNMATCHED": "州匹配失败",
    "ADDRESS_SUGGESTION_BLOCKED": "Amazon 提示地址不可投递",
    "ADDRESS_NOT_APPLIED": "地址填了但没生效",
    "PRICE_CAP_EXCEEDED": "实付超限价",
    "DELIVERY_TOO_LATE": "交期超限",
    "DELIVERY_UNPARSEABLE": "交期无法解析",
    "CHECKOUT_TIMEOUT": "结算页跳转超时",
    "ORDER_CONFIRM_TIMEOUT": "下单后未见确认页",
    "ORDER_NO_AMBIGUOUS": "无法确定哪个单号属于本单",
    "CAPTCHA_ENCOUNTERED": "命中验证码/风控",
    "CLAIM_TIMEOUT": "认领超时未回传",
    "PLUGIN_INTERNAL": "插件内部异常",
}

ERROR_CODES = frozenset(LABELS)

#: 可自动重试:页面慢或结构没等到,重置回 ready 即可。
RETRYABLE = frozenset({
    "ADD_TO_CART_FAILED", "CART_MISMATCH", "ADDRESS_FORM_TIMEOUT",
    "CHECKOUT_TIMEOUT", "PLUGIN_INTERNAL",
})

#: 必须转人工,禁止自动重试。
#: 前三个的共同点是**可能已经在 Amazon 上真下了单**,重试就是重复下单;
#: 其余是护栏拦截与风控,重试多少次结果都一样,要人来裁决。
TO_MANUAL = frozenset({
    "ORDER_CONFIRM_TIMEOUT", "ORDER_NO_AMBIGUOUS", "CLAIM_TIMEOUT",
    "PRICE_CAP_EXCEEDED", "DELIVERY_TOO_LATE", "DELIVERY_UNPARSEABLE",
    "CAPTCHA_ENCOUNTERED",
})


#: 「可能已经在 Amazon 上真下了单」的那一类。重置回队列前必须有人先去买家号里
#: 确认过 —— 直接重置就是让下一个实例把同一单再买一遍。
POSSIBLY_ORDERED = frozenset({
    "ORDER_CONFIRM_TIMEOUT", "ORDER_NO_AMBIGUOUS", "CLAIM_TIMEOUT",
})

#: 业务性拦截:重试多少次结果都一样,但也不涉及「可能已经下单」的风险。
#: 处置是改单(换 ASIN、改地址、调数量)或者放弃,不是重试也不是去查订单。
#:
#: 这一组是 2026-08-21 补的。在此之前 19 个码里有 7 个**不在任何一组**:
#: 表面上是个三分的封闭分类,实际有三分之一的码落在分类之外。
#: 照着这三组建处置 SOP 的人会漏掉它们,而它们恰好是最常见的那几个
#: (无货、非 FBA、地址不可投递)。这就是本项目反复遇到的
#: 「看起来有护栏、实际防不住」——有测试盯着,见 tests/test_error_codes.py。
BUSINESS_BLOCKED = frozenset({
    "OUT_OF_STOCK", "QTY_UNAVAILABLE", "BUNDLE_PRODUCT", "NOT_FBA",
    "ADDRESS_STATE_UNMATCHED", "ADDRESS_SUGGESTION_BLOCKED", "ADDRESS_NOT_APPLIED",
})

#: ⚠ RETRYABLE **目前没有任何自动重试在消费它**。
#: 没有 workflow 把 exception 退回 ready —— task_sweep 只清扫 claimed 超时,
#: 而且刻意不退回 ready(插件可能已经真下了单)。
#: 所以这一组当下的含义是「人点一下重置基本能过」,不是「系统会自己再来」。
#: 界面上的文案必须照这个事实写 —— 写成「系统自己会再试」就是在界面上撒谎,
#: 运营会因此把一桶其实没人管的单晾在那儿。
#: 要不要真做自动重试是产品决定,留给所有者;在做出来之前这条注释不许删。
AUTO_RETRY_IMPLEMENTED = False


def validate(code: str) -> str:
    """输入:错误码 → 输出:原样返回;不在封闭集内抛 ValueError。

    宁可拒收也不放进库:一个拼错的码写进去,就永远不会出现在按码分组的统计里,
    那条任务在运营眼里等于消失了。
    """
    if code not in ERROR_CODES:
        raise ValueError(
            f"未知错误码 {code!r}。封闭集见 docs/01-系统设计.md §4,"
            f"共 {len(ERROR_CODES)} 个:{', '.join(sorted(ERROR_CODES))}"
        )
    return code


def label(code: str | None) -> str:
    """输入:错误码 → 输出:中文含义;认不出就原样返回。"""
    if not code:
        return ""
    return LABELS.get(code, code)
