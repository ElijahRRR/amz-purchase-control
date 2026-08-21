"""回填时的 ASIN 断言。

所有者以几万单实测背书「订单历史第一张卡就是刚下的单」,因此**不做**下单前快照。
这里只做一条零成本断言:那张卡的商品链接插件本来就要解析出 ASIN,顺手比一下
是不是本单的。不多一次页面加载、不改主流程。

不符时不静默写库 —— 转人工。库层还有 uq_tasks_amazon_order_no 兜底。
"""


def asins_match(expected: list[str], observed: list[str]) -> bool:
    """输入:任务的 ASIN 列表 + 订单卡上观察到的 ASIN 列表 → 输出:是否一致。

    observed 为空视为「没采到」,不判失败 —— 断言的职责是抓错配,不是制造噪音。
    比较按集合:同一 ASIN 多件商品在卡片上可能只出现一次。
    """
    if not observed:
        return True
    return set(a.strip().upper() for a in observed) == set(a.strip().upper() for a in expected)
