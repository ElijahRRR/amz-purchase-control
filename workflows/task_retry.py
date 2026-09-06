"""有界自动重试:把 RETRYABLE 那一组的 exception 退回队列,重够次数就交给人。

    python cli.py task_retry --dry-run    # 先看这一轮会动到谁
    python cli.py task_retry

**默认关**(`AMZ_AUTO_RETRY_MAX=0`)。没开的时候这条链每轮只是安静地跳过,
并把原因说出来 —— 一条会跳过的链在运行记录里必须解释自己为什么跳过,
否则运维只看到一条每 10 分钟成功一次、什么也没干的记录。
没开也不算「必须定时」,运营台的工作流记录页不会为它标红(照 feishu_writeback 的先例)。

与 task_sweep 分成两条链:那一条清扫的是 `claimed` 超时,**刻意不退回 ready**
(插件可能已经真下了单)。这一条只碰 `exception`,而且只碰其中
「页面慢/结构没等到」那一组 —— 两条链的判断方向相反,合在一起迟早有人改错一边。

**一轮有上限**(`AMZ_AUTO_RETRY_BATCH`,默认 20 条),而且**失败太久的不重**
(`AMZ_AUTO_RETRY_MAX_AGE_MIN`,默认 24 小时)。这两道拦的是同一个场景:
把上限从 0 改成 N 的那一轮,库里积着的历史 exception 会一次性全部退回队列。

选谁的条件、以及为什么是这几条,见 services/task_retry.py。
"""

from registry import db
from services import task_admin, task_retry


#: 摘要里最多点名多少条。这段字符串会原样写进 ops.runs.summary,再原样显示在
#: 运营台那一页 —— 一次重了三百条的话,不截断就是往库里塞一行几千字的记录,
#: 而那一页只会变得没法看。数量本身在前半句里,不会因为截断丢掉。
_NAMED_MAX = 20


def _head(items: list[str]) -> str:
    """输入:一批点名 → 输出:最多 _NAMED_MAX 条,余下的只报数。"""
    if len(items) <= _NAMED_MAX:
        return ", ".join(items)
    return ", ".join(items[:_NAMED_MAX]) + f", …另有 {len(items) - _NAMED_MAX} 条"


def run(params: dict) -> str:
    """输入:params(dry_run 可选)→ 输出:结果摘要。"""
    cfg = task_retry.config()
    if not cfg["enabled"]:
        # 不接受 -p 参数把它临时打开:「默认关」要是能被一句命令行绕开,
        # 那它就不是默认关,而是「取决于谁在敲命令」。要开就去 .env 里写清楚,
        # 让界面文案与这条链读的是同一个开关。
        return "跳过:自动重试没开(AMZ_AUTO_RETRY_MAX=0)"

    with db.pg_conn() as conn:
        rows = task_retry.candidates(conn, cfg=cfg)
        head = (f"{len(rows)} 条够格自动重试"
                f"(上限 {cfg['max']} 次;失败后隔够 {cfg['backoff_min']} 分钟、"
                f"且不超过 {cfg['max_age_min']} 分钟;本轮最多 {cfg['batch']} 条)")
        if len(rows) >= cfg["batch"]:
            # 取满了就说一声。不说的话,摘要里那个数会被读成「库里就这么多够格的」,
            # 而它其实是「这一轮取到的」—— 后面可能还排着两百条。
            # 空跑尤其要说:所有者正是拿空跑那份输出决定「要不要真跑」的。
            head += ";本轮取满,余下的下一轮继续"

        if params.get("dry_run"):
            # 空跑与真跑用的是同一个 candidates(),不是另写一条查询 ——
            # 「空跑报一批、真跑动另一批」本项目栽过一次(task_intake)。
            preview = "\n".join(
                f"    #{r['id']} {r['upstream_order_no']} {r['env_code']} "
                f"{r['error_code']} 已试 {r['retry_count']}/{cfg['max']}"
                for r in rows[:_NAMED_MAX])
            more = (f"\n    …另有 {len(rows) - _NAMED_MAX} 条"
                    if len(rows) > _NAMED_MAX else "")
            return f"dry-run:{head}" + (f"\n{preview}{more}" if rows else "")

        done: list[str] = []
        refused: list[str] = []
        for r in rows:
            try:
                got = task_retry.retry_one(conn, r["id"], cfg=cfg)
            except task_admin.AdminRefused as exc:
                # 选完到重之间任务被人处置过/被插件领走了,是正常的并发,不是故障。
                # 但要报出来:一条「够格却没重成」如果静默消失,下一轮它还在,
                # 而没人知道它每轮都被拒。
                refused.append(f"#{r['id']} {exc.code}")
            else:
                done.append(f"#{got['task_id']} 第 {got['attempt']}/{got['max']} 次")

        tail = f";{len(refused)} 条中途被拒({_head(refused)})" if refused else ""
        return (f"{head} → 已退回队列 {len(done)} 条"
                + (f" ({_head(done)})" if done else "") + tail)
