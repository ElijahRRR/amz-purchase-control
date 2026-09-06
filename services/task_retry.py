"""有界自动重试:选出「重一下大概就过了」的那几条,退回队列,次数与间隔都封死。

**默认关**(`AMZ_AUTO_RETRY_MAX=0`)。理由与 feishu_writeback 同一条:
有副作用的动作不该因为「代码里有这个功能」就默认发生 —— 而这个动作的副作用
是在亚马逊上再拍一次单。

这个模块只负责两件事,工作流(workflows/task_retry.py)负责把它们串起来:
  · `candidates()` —— 谁**够格**被自动重(五个条件必须同时成立)
  · `retry_one()`  —— 真的去重那一条(状态流转借道 task_admin.reset_to_queue)

**为什么不自己写一条 exception → ready**:人工重置那条路已经在
`services/task_admin.reset_to_queue` 里,它上面挂着 `NEEDS_ACK` 那道闸。
另写一条等于把闸绕过去,而且两条路迟早分叉 —— 本项目已经因为「两份副本」
栽过两次,这一条的分叉后果是**自动重复下单**。
"""

from typing import Any

from registry import settings
from services import error_codes, task_admin

#: 事件流与 ops.runs 里的署名。人工动作那一栏填的是人名,这里填的是「谁都不是」——
#: 一条自动重试在时间线上必须一眼看出没有人参与,不能借用某个运营的名字。
OPERATOR = "auto_retry"

#: 选单条件。前七条是**这一张单**够不够格,七条同时成立才算数,少任何一条都可能
#: 变成重复下单或者无限重试:
#:   ① status = 'exception'  —— manual 不碰。manual 的含义就是「等人裁决」,
#:      系统在这里替人做决定,那道闸就白设了
#:   ② error_code ∈ RETRYABLE —— 页面慢/结构没等到这一类
#:   ③ error_code ∉ POSSIBLY_ORDERED —— 见 _retryable_codes():两组按定义不交,
#:      这里是第二道,防的是有人改了分组还没人发现
#:   ④ **NOT may_have_ordered** —— 这一单没越过下单点。①②③ 合起来仍然拦不住它:
#:      status 是**插件**在 /fail 里用自己算的 to_manual 定的,插件那侧漏判一次
#:      (版本旧了、两边分叉、算错),一张点过下单按钮的单就会落成 exception,
#:      而它的码恰恰在 RETRYABLE 里(run.ts 的 catch 直接用 DriverError 自己的码,
#:      PLUGIN_INTERNAL / CART_MISMATCH 都在那一组)。那一轮的后果是
#:      **定时任务自动重复下单**。这一列不经插件的判断,记的是它自己说过的话
#:   ⑤ retry_count < 上限 —— 界的是「同一张单重几次」
#:   ⑥ 失败已经过了 backoff —— 立刻重拍只是拿同一个坏环境再撞一次
#:   ⑦ 失败**没有太久**(AMZ_AUTO_RETRY_MAX_AGE_MIN)—— 见下
#:
#: 第八道不属于任何一张单,属于这一轮:
#:   ⑧ LIMIT batch —— 一轮最多放这么多条回队列
#:
#: **⑦⑧ 拦的是同一件事:「有界」不能只界在单张任务上。** ⑤ 管的是同一张单重几次,
#: 管不了一轮放几张单 —— 所有者第一次把 AMZ_AUTO_RETRY_MAX 从 0 改成 N 的那一轮,
#: 库里积着的**全部历史** exception 的 retry_count 都是 0、都早过了 backoff,
#: 于是一轮全部退回队列,插件挨个在亚马逊上重拍一遍。⑧ 把这一批摊到多轮里
#: (照 services/shipment.py 那条 LIMIT 的先例),⑦ 才是真正拦住它的那一道:
#: 攒了几个月的失败单早就在别处被处置掉了,不该由一条定时任务替人重新买回来。
#: 「跑之前先 --dry-run 看看会动到谁」是给人的提醒,不是护栏 —— 它靠人记得敲。
#:
#: 时间基准取 `updated_at`:失败那一刻 task_queue.fail 会把它更新成 now()。
#: 它也会被改地址之类的人工动作推后 —— 推后让这一条晚一点被 ⑤ 放行、又让它在 ⑥
#: 眼里更年轻,两个方向都是「有人刚碰过这一单」,与这两道闸的意思一致;
#: 没有任何路径会把它提前。
_CANDIDATE_SQL = """
SELECT t.id, t.upstream_order_no, t.error_code, t.retry_count, t.updated_at,
       b.code AS env_code
  FROM procure.tasks t
  JOIN procure.buyer_envs b ON b.id = t.buyer_env_id
 WHERE t.status = 'exception'
   AND t.error_code = ANY(%(codes)s)
   AND NOT (t.error_code = ANY(%(never)s))
   AND NOT t.may_have_ordered
   AND t.retry_count < %(max)s
   AND t.updated_at < now() - make_interval(mins => %(backoff)s)
   AND t.updated_at > now() - make_interval(mins => %(max_age)s)
 ORDER BY t.updated_at, t.id
 LIMIT %(batch)s
"""


def config() -> dict[str, Any]:
    """输入:无 → 输出:{enabled, max, backoff_min, max_age_min, batch}。

    界面文案、工作流选单、运营台「这条链要不要盯着」读的都是这一份 ——
    三处各自去读环境变量的话,迟早出现「界面说系统会自动重试、而那条链根本没开」。
    界面上不许写系统不会做的承诺,这是那条承诺的唯一出处。

    `max_age_min` 也要下发给界面:它决定的不是「什么时候重」,而是**会不会重** ——
    一条失败超过它的单,系统永远不会碰。界面要是不知道这道闸,就会对着一张
    没人会再管的单继续写「不点它也会被放回队列」。`batch` 只影响快慢
    (这一轮没轮到的下一轮还在),所以界面拿到了也不拿它写承诺。
    """
    n = settings.auto_retry_max()
    return {"enabled": n > 0, "max": n,
            "backoff_min": settings.auto_retry_backoff_minutes(),
            "max_age_min": settings.auto_retry_max_age_minutes(),
            "batch": settings.auto_retry_batch()}


def _retryable_codes() -> list[str]:
    """输入:无 → 输出:允许自动重试的错误码;两组有交集就**整轮拒绝**。

    `RETRYABLE` 与 `POSSIBLY_ORDERED` 按定义不相交(有 tests/test_error_codes.py
    盯着)。这里再拦一次,拦的是「有人改了分组、测试还没跑到、而定时任务照跑」——
    那一轮的后果不是报错,是**把一批可能已经下过单的任务自动再拍一遍**。

    用 `raise AssertionError` 而不是 `assert`:`python -O` 会把 assert 整条删掉。
    一条被优化掉的护栏正是本项目最防的那种「看起来有护栏、实际防不住」。
    """
    overlap = error_codes.RETRYABLE & error_codes.POSSIBLY_ORDERED
    if overlap:
        raise AssertionError(
            f"RETRYABLE 与 POSSIBLY_ORDERED 出现交集:{sorted(overlap)}。"
            "自动重拍一张可能已经在亚马逊上下过单的任务 = 自动重复下单。"
            "这一轮什么都不做,先去 services/error_codes.py 把分组改对。"
        )
    return sorted(error_codes.RETRYABLE)


def candidates(conn, *, cfg: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """输入:连接(+ 配置)→ 输出:这一轮够格被自动重试的任务列表(可能为空)。

    只读。`--dry-run` 与真跑读的是**同一个函数** —— 空跑报一批、真跑动另一批
    是本项目栽过的坑(task_intake 的 dry-run 曾只做字段校验、不查库)。
    """
    cfg = cfg or config()
    if not cfg["enabled"]:
        return []
    return [dict(r) for r in conn.execute(_CANDIDATE_SQL, {
        "codes": _retryable_codes(),
        "never": sorted(error_codes.POSSIBLY_ORDERED),
        "max": cfg["max"],
        "backoff": cfg["backoff_min"],
        "max_age": cfg["max_age_min"],
        "batch": cfg["batch"],
    }).fetchall()]


def retry_one(conn, task_id: int, *, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """输入:任务 id → 输出:{task_id, attempt, max, was_error_code};不够格抛 AdminRefused。

    选单那七条在这里**一条不少地再判一遍**,不信任调用方递过来的那一行:选单和执行
    之间隔着一段时间,期间插件可能已经把这条任务领走了,人也可能已经手工处置过。
    照着一份过期快照去重置,重的就是另一条任务的状态。

    **两道时间闸(backoff / max_age)也在这里判**,不是只活在选单 SQL 里。
    这个函数是个带完整 docstring 的公开积木,下一个人给运营台加「立即重试」按钮时
    会照着这句话直接调它 —— 那条路上要是没有 backoff,现象就是「刚失败就立刻拿
    同一个坏环境再撞一次」,还会把错误码分布刷成一片同样的码。
    两个比较都交给 SQL 的 `now()` 去做,不用 Python 时钟:同一个事务里 `now()`
    是固定的,所以选单放行的那一条,到这里必定还放行 —— 复判不会反过来添乱;
    换成两把不同的尺子,差的就是时区与时钟漂移。

    `acknowledged` 恒为 False,而且 `by="auto"` 时 task_admin 会直接拒绝带回执 ——
    自动重试遇到「可能已下单」必须**被拒**,不是绕过。
    """
    cfg = cfg or config()
    if not cfg["enabled"]:
        raise task_admin.AdminRefused("AUTO_RETRY_OFF", "自动重试没开(AMZ_AUTO_RETRY_MAX=0)")
    codes = set(_retryable_codes())

    row = conn.execute(
        """SELECT id, status, error_code, retry_count, may_have_ordered,
                  -- 与 _CANDIDATE_SQL 的 ⑥⑦ 互为反面,边界要对齐:
                  -- 那边放行的是 backoff 之前、max_age 之后,这两个就是它们的否定。
                  updated_at >= now() - make_interval(mins => %(backoff)s) AS too_fresh,
                  updated_at <= now() - make_interval(mins => %(max_age)s) AS too_old
             FROM procure.tasks WHERE id = %(id)s""",
        {"id": task_id, "backoff": cfg["backoff_min"], "max_age": cfg["max_age_min"]},
    ).fetchone()
    if row is None:
        raise task_admin.AdminRefused("TASK_NOT_FOUND", f"任务 {task_id} 不存在")
    if row["status"] != "exception":
        raise task_admin.AdminRefused(
            "BAD_STATUS", f"只有拍单异常能自动重试,当前是 {row['status']}")
    if row["error_code"] in error_codes.POSSIBLY_ORDERED:
        # 到不了这里(_retryable_codes 已经拦过交集,SQL 里也排除了)。
        # 留着是因为这条判断的代价是一行,而漏掉的代价是重复下单。
        raise task_admin.AdminRefused(
            "POSSIBLY_ORDERED",
            f"{row['error_code']} 可能已经在亚马逊上下过单,永远不自动重试")
    if row["may_have_ordered"]:
        # 上面那条按**码**判,这条按**事实**判:下单按钮点过了。
        # 两条都要有 —— 越过下单点之后抛 DriverError 落下来的码在 RETRYABLE 里,
        # 上面那条对它一句话都说不上。reset_to_queue 那道 NEEDS_ACK 是最后一道
        # (by="auto" 连带回执的资格都没有),但让定时任务撞到那道闸才被拒,
        # 意味着每一轮都会有一批「够格却被拒」——这里直接不选它。
        raise task_admin.AdminRefused(
            "POSSIBLY_ORDERED",
            "这一单已经越过下单点(下单按钮点过了),永远不自动重试")
    if row["error_code"] not in codes:
        raise task_admin.AdminRefused(
            "NOT_RETRYABLE", f"{row['error_code']} 不在可自动重试的那一组里")
    if row["retry_count"] >= cfg["max"]:
        raise task_admin.AdminRefused(
            "RETRY_EXHAUSTED",
            f"已经自动重试过 {row['retry_count']} 次,到上限 {cfg['max']} 了,该人来看了")
    if row["too_fresh"]:
        raise task_admin.AdminRefused(
            "BACKOFF_NOT_MET",
            f"刚失败不到 {cfg['backoff_min']} 分钟,还不到自动重的时候 —— "
            "立刻重拍只是拿同一个坏环境再撞一次")
    if row["too_old"]:
        raise task_admin.AdminRefused(
            "TOO_OLD",
            f"失败已经超过 {cfg['max_age_min']} 分钟,不再自动重,交给人 —— "
            "攒这么久的单多半已经在别处处置过了")

    attempt = row["retry_count"] + 1
    task_admin.reset_to_queue(
        conn, task_id, acknowledged=False, operator=OPERATOR, by="auto",
        payload_extra={"attempt": attempt, "max": cfg["max"],
                       "backoff_min": cfg["backoff_min"]},
    )
    return {"task_id": task_id, "attempt": attempt, "max": cfg["max"],
            "was_error_code": row["error_code"]}
