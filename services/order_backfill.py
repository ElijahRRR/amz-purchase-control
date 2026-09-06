"""回填时的 ASIN 断言。

所有者以几万单实测背书「订单历史第一张卡就是刚下的单」,因此**不做**下单前快照。
这里只做一条零成本断言:那张卡的商品链接插件本来就要解析出 ASIN,顺手比一下
是不是本单的。不多一次页面加载、不改主流程。

不符时不静默写库 —— 转人工。库层还有 uq_tasks_amazon_order_no 兜底。
"""

from typing import Literal

#: 三态。**不是 bool**,而且刻意不给「真值/假值」的便利:
#: 写成 `if not asins_match(...)` 会在三个值上编译通过、跑出错的分支。
AssertResult = Literal["match", "mismatch", "not_observed"]


def asins_match(expected: list[str], observed: list[str]) -> AssertResult:
    """输入:任务的 ASIN 列表 + 订单卡上观察到的 ASIN 列表 → 输出:三态之一。

      · `match`         —— 对上了
      · `mismatch`      —— 采到了,但不是本单的。**不写单号,转人工**
      · `not_observed`  —— 一个都没采到。既定取舍不变:**不阻断回填**
                           (断言的职责是抓错配,不是制造噪音),但调用方必须
                           把它与 `match` 分开处置

    **为什么要三态。** 原来这里是 `if not observed: return True` ——「没采到」与
    「对上了」返回同一个值,于是唯一的调用方只有一个分支,这两件事在事件流里、
    库里、任何统计里都长得一模一样。Amazon 某次改版把订单卡的商品链接换个类名,
    `observed` 就恒为 `[]`,而订单号本身仍读得出来:断言整体退化成厂商那套
    「盲取第一张卡」,回填照常成功,**没有任何地方看得见这件事**。
    直到某天有人发现一批任务挂着别人的订单号 —— 而那时已经错了几百单。

    两种不同的情况渲染出同一个结果就是缺陷。取舍(不阻断)保留,可见性补上。

    比较按集合:同一 ASIN 多件商品在卡片上可能只出现一次。
    """
    if not observed:
        return "not_observed"
    if set(a.strip().upper() for a in observed) == set(a.strip().upper() for a in expected):
        return "match"
    return "mismatch"
