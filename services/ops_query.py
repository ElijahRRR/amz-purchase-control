"""**这套系统本身还在正常干活吗** —— 运维体检的读侧。只读。

与 `services/task_query.py` 的分工不是「读哪张表」,是**回答哪个问题**:
那边回答「这些单怎么样了」(状态桶、错误码分布、某一单的全貌),
这边回答「护栏和定时链还活着吗」。后者的特征是:出问题时**单子看起来全都正常**,
所以必须专门去数,不会有人因为某一单不对劲而发现它。

眼下两只眼睛:

  · `recent()` —— 运行记录(`ops.runs`)。这张表一直是只写不读的:cli.py 每跑
    一条 workflow 就写一行,而全项目没有任何地方读它。写了没人看等于没写 ——
    而 `task_sweep` 是全项目唯一必须挂定时的一条,它哪天悄悄停了,
    claimed 的任务会一直堆着没人知道。
  · `assert_skipped()` —— 回填时那道 ASIN 断言「没能比」的近 7 日计数。
    它整体失效的样子正是**一批看着完全正常的 purchased**:Amazon 改个类名,
    插件采到的 ASIN 恒为空,断言退化成盲取第一张卡,而每一单都是绿的。
"""

from datetime import datetime, timedelta, timezone
from typing import Any

from registry import paths

_RECENT_SQL = """
SELECT id, workflow, params, started_at, finished_at, status, summary, operator,
       EXTRACT(EPOCH FROM (coalesce(finished_at, now()) - started_at))::int AS seconds
  FROM ops.runs
 ORDER BY started_at DESC
 LIMIT %(limit)s
"""

#: 每条工作流的**最后一次真跑**。单独查,不从上面那份「最近 N 次」里挑。
#:
#: 从那份里挑会出这种事:task_intake 一小时跑了 60 次,把 task_sweep 一小时前
#: 那次挤出了窗口 —— 界面于是报「从没跑过 + 逾期」,而它其实好好的。
#: **在监控页上误报,比不报还坏**:红旗一旦会自己冒出来,就没人再信红旗。
#:
#: `NOT (params ? 'dry_run' AND params->>'dry_run' = 'true')` —— 空跑不算跑过。
#: 空跑什么都没清扫。定时器停了、有人手工 --dry-run 试了一下,那一格就从红变绿,
#: 而 claimed 的任务照样堆着。这正是「看起来有护栏、实际防不住」。
_LAST_REAL_SQL = """
SELECT DISTINCT ON (workflow)
       id, workflow, params, started_at, finished_at, status, summary, operator,
       EXTRACT(EPOCH FROM (coalesce(finished_at, now()) - started_at))::int AS seconds
  FROM ops.runs
 WHERE coalesce(params->>'dry_run', 'false') <> 'true'
 ORDER BY workflow, started_at DESC
"""

#: 停在 running 超过这么久,就不是「在跑」而是「开跑后再没消息」。
#: 取一小时:项目里最长的一条(task_intake 批量落库)也是分钟级。
STUCK_AFTER = timedelta(hours=1)

#: 每条工作流「多久没跑算不正常」。None = 不该定时,按需跑,从没跑过也正常。
#:
#: 为什么要有这张表:没有它,界面只能一视同仁地把「从没跑过」标红,
#: 于是 db_init(装机时跑一次的引导脚本)会永远红着。
#: **一张永远红着的卡片会把人训练成忽略红色** —— 等 task_sweep 真的停了,
#: 那一格红得跟旁边那格一模一样,没人会多看一眼。
#:
#: 名字从 workflows/ 目录读,期望写在这里 —— 加了工作流却没声明期望,
#: 测试会断(tests/test_admin.py)。
EXPECTED_INTERVAL: dict[str, timedelta | None] = {
    # 全项目唯一必须挂定时的一条。它停了,claimed 的任务会一直堆着,
    # 而队列看起来一切正常 —— 所以它的阈值给得紧。
    "task_sweep": timedelta(hours=2),
    # 上游那条链。它停了,新单一张都进不来 —— 而界面上「队列待拍 0」
    # 跟「今天上游确实没派单」长得一模一样,不会有人觉得不对。
    # 阈值可配(AMZ_FEISHU_SYNC_MAX_AGE_MIN),因为拉单频率是运维决定的。
    "feishu_sync": None,       # ← 运行时按 settings 取,见下面的 _expected()
    # 回写。**只在真的开了回写时才算「必须定时」** —— 没开的话它每轮只是
    # 安静地跳过,把它标成逾期就又多了一格永远红着的卡片,
    # 而一格永远红着的卡片会把人训练成忽略红色。
    "feishu_writeback": None,  # ← 同上,见 _expected()
    # 有界自动重试。**只在真的开了自动重试时才算「必须定时」**(同回写那条理由:
    # 关着的时候它每轮只是安静地跳过)。开着就必须盯 —— 界面在开着时对运营承诺
    # 「系统最多自动重试 N 次」,这条链停了那句话就是假的,而界面本身看不出来:
    # 那一桶单会安安静静地待在拍单异常里,谁也没在管。
    "task_retry": None,        # ← 同上,见 _expected()
    # 接表前看一眼列名用的,按需跑。
    "feishu_probe": None,
    # 手工/应急投放文件时才跑。没有投放就没有运行,不算异常。
    "task_intake": None,
    # 装机时跑一次的引导脚本。
    "db_init": None,
}


def _expected(name: str) -> timedelta | None:
    """输入:工作流名 → 输出:它「多久没跑算不正常」。

    两条飞书链不走那张静态表:
      · feishu_sync —— 拉单频率是运维决定的,写死在代码里的话,
        改成低频跑的人会得到一格永远红着的卡片。
      · feishu_writeback —— 没开回写就根本不该盯它。
    """
    from registry import settings

    if name == "feishu_sync":
        return timedelta(minutes=settings.feishu_sync_max_age_minutes())
    if name == "feishu_writeback":
        return timedelta(minutes=settings.feishu_sync_max_age_minutes()) \
            if _writeback_on() else None
    if name == "task_retry":
        # 推荐 */10 挂,阈值给 2 小时(宽 12 倍)。想比这还低频地跑,说明并不真指望
        # 它自动重 —— 那就把 AMZ_AUTO_RETRY_MAX 调回 0,界面会跟着改回「需人工重置」,
        # 而不是留一格永远红着的卡片(一格永远红着的卡片会把人训练成忽略红色)。
        return timedelta(hours=2) if _auto_retry_on() else None
    return EXPECTED_INTERVAL.get(name)


def _writeback_on() -> bool:
    """输入:无 → 输出:回写开没开。读不到配置就当没开 —— 报警宁可少报。"""
    try:
        from services import feishu_intake

        return bool((feishu_intake.load_mapping().get("writeback") or {}).get("enabled"))
    except Exception:
        return False


def _auto_retry_on() -> bool:
    """输入:无 → 输出:自动重试开没开。读不到配置就当没开 —— 报警宁可少报。

    与工作流选单、与 /v1/admin/meta 下发给界面的是**同一个** config(),
    不在这里另判一次「大于 0 算开」。
    """
    try:
        from services import task_retry

        return bool(task_retry.config()["enabled"])
    except Exception:
        return False


def _workflow_names() -> list[str]:
    """输入:无 → 输出:workflows/ 下真实存在的工作流名。

    从文件系统读,不写死一份清单 —— 写死的那份迟早跟目录对不上,
    而这一页的意义正是「哪一条该跑却没跑」,清单错了整页就白做。
    """
    d = paths.repo_root() / "workflows"
    return sorted(f.stem for f in d.glob("*.py") if f.stem != "__init__")


def recent(conn, *, limit: int = 60) -> dict[str, Any]:
    """输入:连接 → 输出:{items, by_workflow}。

    `by_workflow` 是每条工作流的**最后一次**运行,并且**每条都出现** ——
    包括从来没跑过的。一条从没跑过的 task_sweep 在「最近运行」列表里
    是看不见的(它没有行),而那恰恰是最该报警的情况。
    """
    limit = max(1, min(int(limit), 500))   # 负数会让 LIMIT 直接报错,超大值把内存喂满
    rows = [dict(r) for r in conn.execute(_RECENT_SQL, {"limit": limit}).fetchall()]
    now = datetime.now(timezone.utc)

    def mark_stuck(r: dict[str, Any]) -> dict[str, Any]:
        # 停在 running 又超过时限的,不是在跑,是没了下文。
        # 界面上这两种必须分开:一个是等它,一个是去查它。
        r["stuck"] = (r["status"] == "running"
                      and r["started_at"] is not None
                      and now - r["started_at"] > STUCK_AFTER)
        return r

    for r in rows:
        mark_stuck(r)

    # 「最后一次跑」单独查,不从上面那 limit 行里挑 —— 挑的话,一条跑得频繁的
    # 工作流会把另一条挤出窗口,于是健康的那条被报成「从没跑过 + 逾期」。
    latest: dict[str, dict[str, Any] | None] = {name: None for name in _workflow_names()}
    for r in conn.execute(_LAST_REAL_SQL).fetchall():
        if r["workflow"] in latest:
            latest[r["workflow"]] = mark_stuck(dict(r))

    by_workflow = []
    for name in latest:
        last = latest[name]
        age = int((now - last["started_at"]).total_seconds()) if last else None
        expect = _expected(name)
        # 「过期」只对该定时的那几条有意义。按需跑的从没跑过是正常的,
        # 把它也标红等于教人忽略红色。
        overdue = bool(expect is not None
                       and (age is None or age > expect.total_seconds()))
        by_workflow.append({
            "workflow": name,
            "last": last,
            "age_seconds": age,
            "scheduled": expect is not None,
            "expected_seconds": int(expect.total_seconds()) if expect else None,
            "overdue": overdue,
        })

    # 顶栏那个数字要是**真的总数**,不是 items 的长度。
    # 拿 len(items) 当总数的话,超过 limit 之后它会永远停在 60 —— 一个不动的
    # 计数器比没有计数器更坏,它会让人以为「最近就跑了这么多次」。
    total = conn.execute("SELECT count(*) AS n FROM ops.runs").fetchone()["n"]

    return {
        "items": rows,
        "total": total,
        "limit": limit,
        "by_workflow": by_workflow,
        "stuck_after_seconds": int(STUCK_AFTER.total_seconds()),
    }


#: 「近 7 日」而不是「有史以来」。一个只增不减的总数回答不了「现在坏没坏」——
#: 而这个数唯一有用的读法就是拿它跟同期的回填条数比:接近了,说明选择器已经坏了。
ASSERT_SKIPPED_DAYS = 7

_ASSERT_SKIPPED_SQL = """
SELECT count(*) AS n
  FROM procure.task_events
 WHERE kind = 'assert_skipped'
   AND created_at >= now() - make_interval(days => %(days)s)
"""


def assert_skipped(conn, *, days: int = ASSERT_SKIPPED_DAYS) -> dict[str, Any]:
    """输入:连接(+ 回看几天)→ 输出:{recent_7d, days, label}。

    回填时的 ASIN 断言在「一个 ASIN 都没采到」时**照旧放行**(既定取舍:
    断言的职责是抓错配,不是制造噪音)。既然放行,这件事就只能靠数出来 ——
    否则它整体失效时,库里是一批看着完全正常的 purchased,
    没有任何一条错误码提示那道断言已经不工作了。

    `label` 一并给出,是因为这个数要显示在错误码分布页上,而那一页的其它文案
    都从 `/v1/admin/meta` 的封闭集里取;这一个不属于任何封闭集,
    再让前端自己写一份中文就又多了一处会分叉的副本。出处仍是 services/vocab。
    """
    from services import vocab

    n = conn.execute(_ASSERT_SKIPPED_SQL, {"days": days}).fetchone()["n"]
    return {"recent_7d": n, "days": days,
            "label": vocab.OPS_METRIC_LABELS["assert_skipped"]}
