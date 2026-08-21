

def test_every_code_lands_in_exactly_one_disposition_group():
    """三分(现在是四分)的封闭分类必须真的把 19 个码分完。

    2026-08-21 之前有 7 个码不在任何一组 —— 表面上是个封闭分类,
    实际有三分之一落在分类之外,而且恰好是最常见的那几个(无货、非 FBA、
    地址不可投递)。照着这几组建处置 SOP 的人会漏掉它们。
    这条测试的作用是:以后**加码却忘了归组**,在这里就断。
    """
    from services import error_codes as e

    groups = {
        "RETRYABLE": e.RETRYABLE,
        "TO_MANUAL": e.TO_MANUAL,
        "BUSINESS_BLOCKED": e.BUSINESS_BLOCKED,
    }
    ungrouped = set(e.LABELS) - set().union(*groups.values())
    assert not ungrouped, f"这些码没有归组,处置方式无从谈起:{sorted(ungrouped)}"

    overlapped = {c: [n for n, g in groups.items() if c in g]
                  for c in e.LABELS
                  if sum(c in g for g in groups.values()) > 1}
    assert not overlapped, f"这些码归了不止一组,处置方式互相矛盾:{overlapped}"

    # 组里不能有 LABELS 之外的码 —— 那种码永远不会出现,是死规则
    for name, g in groups.items():
        assert g <= set(e.LABELS), f"{name} 里有 LABELS 之外的码:{sorted(g - set(e.LABELS))}"


def test_possibly_ordered_is_a_subset_of_to_manual():
    """「可能已经下单」必须同时是「必须转人工」。

    反过来说:如果哪天有个码只在 POSSIBLY_ORDERED 里而不在 TO_MANUAL 里,
    它就会走 exception,可能被人当成普通失败重置回队列 —— 那正是重复下单。
    """
    from services import error_codes as e
    assert e.POSSIBLY_ORDERED <= e.TO_MANUAL


def test_retryable_does_not_claim_an_automation_that_does_not_exist():
    """没有任何东西把 exception 自动退回 ready。

    这条测试盯的不是代码行为,是**文案与事实的一致性**:
    只要 AUTO_RETRY_IMPLEMENTED 还是 False,界面就不许说「系统自己会再试」。
    哪天真做了自动重试,把这个常量翻成 True,这条测试会提醒去改界面文案。
    """
    from services import error_codes as e
    assert e.AUTO_RETRY_IMPLEMENTED is False, (
        "自动重试做出来了?那就去把 web 的错误码分布页文案改掉 —— "
        "现在那里写的是「目前没有自动重试,要人来点」"
    )
