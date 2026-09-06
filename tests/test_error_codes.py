

def test_every_code_lands_in_exactly_one_disposition_group():
    """三分(现在是四分)的封闭分类必须真的把封闭集里的每个码分完。

    这条 docstring 刻意**不写码的个数** —— 写了的话每加一个码都要来改它一次,
    而漏改的那次会让人以为分类还是完整的。个数由 LABELS 自己说了算。

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


def test_nothing_that_might_already_be_ordered_is_ever_auto_retryable():
    """「可能已经下单」的码永远不许出现在「可自动重试」里。

    这两组相交的后果不是分类难看,是 workflows/task_retry.py 会把一批
    **可能已经在亚马逊上下过单**的任务自动再拍一遍。
    上面那条分组测试已经间接盖住了它(POSSIBLY_ORDERED ⊆ TO_MANUAL,而三组互不相交),
    但间接成立的东西不该只靠间接成立 —— 那条测试哪天被改了口径,这条还在。
    代码里也有一道同样的断言(services/task_retry._retryable_codes),它拦的是
    「有人改了分组、测试还没跑到、而定时任务照跑」。
    """
    from services import error_codes as e
    overlap = e.RETRYABLE & e.POSSIBLY_ORDERED
    assert not overlap, f"这些码既算可自动重试、又算可能已下单:{sorted(overlap)}"


def test_the_ui_reads_auto_retry_from_config_not_from_a_hardcoded_constant(monkeypatch):
    """RETRYABLE 这一组现在**有东西在消费它**了,而且开没开由配置说了算。

    这条测试盯的不是代码行为,是**文案与事实的一致性**——只是那个「事实」变了:
      · 旧事实:没有任何 workflow 把 exception 退回 ready,所以界面不许说
        「系统自己会再试」。那时用一个写死的 AUTO_RETRY_IMPLEMENTED=False 来表达它。
      · 新事实:workflows/task_retry.py 在消费这一组,但**默认关**
        (AMZ_AUTO_RETRY_MAX=0),开没开是配置的事。

    所以那个写死的常量必须消失,不能翻成 True 了事:功能做出来之后,一个写死的
    布尔迟早与配置说的不是同一件事,而界面照着它写文案 —— 关着却说会自动重试,
    一桶没人管的单被晾着;开着却说要人工重置,人会去点已经排队等系统重的单。
    """
    from registry import paths
    from services import error_codes as e, task_retry

    assert not hasattr(e, "AUTO_RETRY_IMPLEMENTED"), (
        "别把这个常量加回来 —— 开没开去读 services/task_retry.config(),"
        "它读的是配置本身,界面(/v1/admin/meta)拿到的也是它"
    )
    assert (paths.repo_root() / "workflows" / "task_retry.py").exists(), \
        "注释与文档都说 RETRYABLE 有自动重试在消费,那条链必须真的在"

    for var in ("AMZ_AUTO_RETRY_MAX", "AMZ_AUTO_RETRY_BACKOFF_MIN",
                "AMZ_AUTO_RETRY_MAX_AGE_MIN", "AMZ_AUTO_RETRY_BATCH"):
        monkeypatch.delenv(var, raising=False)
    assert task_retry.config()["enabled"] is False, "自动重试必须默认关"
    monkeypatch.setenv("AMZ_AUTO_RETRY_MAX", "3")
    assert task_retry.config() == {"enabled": True, "max": 3, "backoff_min": 10,
                                   "max_age_min": 1440, "batch": 20}
