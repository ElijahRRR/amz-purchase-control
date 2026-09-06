"""有界自动重试:默认关;开了也只动够格的那几条。

这个文件里几乎每一条都对应一个「写错方向就会真花钱」的地方 ——
自动重试的失败模式不是「重试没生效」,是**自动重复下单**。
所以这里断的不只是「该动的动了」,更是「不该动的一条都没动」。
"""

import pytest

from registry import paths, settings
from services import error_codes, task_admin, task_retry
from workflows import task_retry as wf


def _mk(conn, env_id: int, key: str) -> int:
    """输入:买家号 id + 唯一键 → 输出:一条 ready 任务的 id。"""
    return conn.execute(
        """INSERT INTO procure.tasks
             (line_key, upstream_order_no, buyer_env_id, ship_name, ship_phone,
              ship_line1, ship_city, ship_state, ship_postcode, price_cap, status)
           VALUES (%s,%s,%s,'Name','5550001','1 Main St','Santa Ana','CA','92707',
                   12.50,'ready')
           RETURNING id""",
        (key, key, env_id),
    ).fetchone()["id"]


def _fail(conn, task_id: int, code: str, *, minutes_ago: int = 60,
          retry_count: int | None = None, status: str = "exception") -> None:
    """输入:任务 id + 错误码(+ 多久以前失败的 / 已经自动重过几次)→ 输出:无。

    `updated_at` 就是选单用的「失败时间」(task_queue.fail 失败那一刻把它更新成 now())。
    不传 retry_count 就**不动**那一列 —— 造「重过几次之后又失败了」这种场景时,
    夹具自己把计数抹掉的话,测出来的就是另一件事。
    """
    bump = "retry_count = %(n)s," if retry_count is not None else ""
    conn.execute(
        f"""UPDATE procure.tasks
              SET status = %(status)s, error_code = %(code)s, error_detail = '页面没等到',
                  {bump}
                  updated_at = now() - make_interval(mins => %(mins)s)
            WHERE id = %(id)s""",
        {"status": status, "code": code, "n": retry_count,
         "mins": minutes_ago, "id": task_id},
    )


def _row(conn, task_id: int) -> dict:
    return dict(conn.execute(
        "SELECT status, error_code, retry_count FROM procure.tasks WHERE id = %s",
        (task_id,)).fetchone())


def _kinds(conn, task_id: int) -> list[str]:
    return [r["kind"] for r in conn.execute(
        "SELECT kind FROM procure.task_events WHERE task_id = %s ORDER BY id",
        (task_id,)).fetchall()]


@pytest.fixture()
def on(monkeypatch):
    """开着自动重试:最多 2 次,失败后隔 10 分钟。"""
    monkeypatch.setenv("AMZ_AUTO_RETRY_MAX", "2")
    monkeypatch.setenv("AMZ_AUTO_RETRY_BACKOFF_MIN", "10")


# ── 默认关 ──────────────────────────────────────────────────────────────

def test_off_by_default_not_a_single_task_moves(conn, seed, monkeypatch):
    """没配环境变量 = 关。一条够格得不能再够格的单也不许动。

    默认关是所有者的决定,理由与 feishu_writeback 同一条:有副作用的动作不该因为
    「代码里有这个功能」就默认发生 —— 而这个动作的副作用是在亚马逊上再拍一次单。
    """
    monkeypatch.delenv("AMZ_AUTO_RETRY_MAX", raising=False)
    _env, _inst, tasks = seed
    _fail(conn, tasks[0], "CHECKOUT_TIMEOUT")
    conn.commit()

    summary = wf.run({"dry_run": False})

    assert "跳过" in summary and "AMZ_AUTO_RETRY_MAX" in summary, \
        "跳过的链必须在运行记录里解释自己为什么跳过"
    assert _row(conn, tasks[0]) == {"status": "exception",
                                    "error_code": "CHECKOUT_TIMEOUT", "retry_count": 0}
    assert _kinds(conn, tasks[0]) == []


def test_off_means_off_even_when_asked_by_hand(conn, seed, monkeypatch):
    """命令行参数不许把它临时打开。

    「默认关」要是能被一句 `-p max=5` 绕开,那它就不是默认关,而是
    「取决于谁在敲命令」—— 而界面文案读的是配置,会继续说「需人工重置」。
    """
    monkeypatch.delenv("AMZ_AUTO_RETRY_MAX", raising=False)
    _env, _inst, tasks = seed
    _fail(conn, tasks[0], "CHECKOUT_TIMEOUT")
    conn.commit()

    assert "跳过" in wf.run({"dry_run": False, "max": "5", "enabled": "1"})
    assert _row(conn, tasks[0])["status"] == "exception"


# ── 开着:只动够格的 ────────────────────────────────────────────────────

def test_moves_only_the_ones_that_meet_every_condition(conn, seed, on):
    """六个条件是「全部满足」,不是「满足一个就行」。

    这里**直接断 candidates()**,不只看「谁最后被动了」。只看结局的话,
    选单 SQL 的条件被改宽也照样绿:retry_one 会把多选出来的那几条再拒一次,
    任务确实没被动 —— 但**空跑变了**。`--dry-run` 会把一批 manual 的、
    以及已经重满的单列进「这一轮会动到谁」,摘要里那个「N 条够格」也跟着虚高,
    而 CLAUDE.md 要求「改完代码第一次必须先 --dry-run,人眼确认输出再跑真的」:
    空跑输出正是所有者拿来做决定的那份东西。
    (实测过:把 SQL 的 status 放宽到 IN ('exception','manual')、或者把
    retry_count 那一行整行删掉,全套测试都还是全绿。)
    """
    env_id, _inst, tasks = seed
    good = tasks[0]
    _fail(conn, good, "CHECKOUT_TIMEOUT")                       # ✓ 够格

    business = _mk(conn, env_id, "k-business")
    _fail(conn, business, "OUT_OF_STOCK")                       # ✗ 业务拦截,重了也一样

    to_manual = _mk(conn, env_id, "k-manual")
    _fail(conn, to_manual, "CAPTCHA_ENCOUNTERED")               # ✗ 风控,要人裁决

    waiting = _mk(conn, env_id, "k-waiting")                    # ✗ status=manual:
    _fail(conn, waiting, "CLAIM_TIMEOUT", status="manual")      #    manual 的含义就是等人

    # ✗ status=manual,**但码在 RETRYABLE 那一组里**。这一条是专门盯条件 ① 的:
    # 上面那条 CLAIM_TIMEOUT 挡不住 status 被改宽,因为它的码本来就不在这一组。
    # 而 manual + PLUGIN_INTERNAL 是真实可达的组合:插件越过下单点之后抛
    # DriverError('PLUGIN_INTERNAL'),码还在 RETRYABLE 里,单却已经因为
    # mayHaveOrdered 转了待人工(extension/src/flow/run.ts)。
    # 这种单机器**永远**不许碰 —— 它正是「可能已经在亚马逊上下过单」的那一类。
    waiting_retryable = _mk(conn, env_id, "k-waiting-retryable")
    _fail(conn, waiting_retryable, "PLUGIN_INTERNAL", status="manual")

    # ✗ 重满了。专门盯条件 ④ —— 删掉 SQL 里那一行,这一条就会混进候选
    exhausted = _mk(conn, env_id, "k-exhausted")
    _fail(conn, exhausted, "CHECKOUT_TIMEOUT", retry_count=2)   # 上限 2

    queued = tasks[1]                                           # ✗ 还在队列里,没失败过
    conn.commit()

    # 选单本身只该给出一条。这一句才是真正盯着那六个条件的 ——
    # 底下那些「谁没被动过」的断言,兜底的是 retry_one 的复判,不是选单。
    assert [r["id"] for r in task_retry.candidates(conn)] == [good]

    summary = wf.run({"dry_run": False})

    assert _row(conn, good) == {"status": "ready", "error_code": None, "retry_count": 1}
    assert _kinds(conn, good) == ["auto_retry"]
    assert f"#{good}" in summary and "1/2" in summary
    assert summary.startswith("1 条够格自动重试"), f"摘要里的条数不许虚高:{summary}"

    expect = {business: ("exception", "OUT_OF_STOCK", 0),
              to_manual: ("exception", "CAPTCHA_ENCOUNTERED", 0),
              waiting: ("manual", "CLAIM_TIMEOUT", 0),
              waiting_retryable: ("manual", "PLUGIN_INTERNAL", 0),
              exhausted: ("exception", "CHECKOUT_TIMEOUT", 2),
              queued: ("ready", None, 0)}
    for other, (status, code, n) in expect.items():
        assert _row(conn, other) == {"status": status, "error_code": code,
                                     "retry_count": n}, f"任务 {other} 不该被动过"
        assert "auto_retry" not in _kinds(conn, other)


def test_a_fresh_failure_waits_out_the_backoff(conn, seed, on):
    """刚失败的不重。

    页面慢、结构没等到这类失败往往一阵一阵的(亚马逊正卡、代理正抖),
    立刻重拍只是拿同一个坏环境再撞一次,还会把错误码分布刷成一片同样的码。
    """
    _env, _inst, tasks = seed
    fresh, old = tasks[0], tasks[1]
    _fail(conn, fresh, "CART_MISMATCH", minutes_ago=1)      # backoff=10,还没到
    _fail(conn, old, "CART_MISMATCH", minutes_ago=11)       # 到了
    conn.commit()

    wf.run({"dry_run": False})

    assert _row(conn, fresh)["status"] == "exception"
    assert _row(conn, old)["status"] == "ready"


def test_one_round_has_a_ceiling_too(conn, seed, on, monkeypatch):
    """「有界」不能只界在单张任务上:一轮放几条也得有个数。

    retry_count 管的是「同一张单重几次」,管不了「一轮放几张单」——
    所有者第一次把 AMZ_AUTO_RETRY_MAX 从 0 改成 N 的那一轮,库里积着的历史
    exception 的 retry_count 全是 0、全都早过了 backoff,一轮就会全部退回队列,
    插件挨个在亚马逊上重拍一遍。
    """
    monkeypatch.setenv("AMZ_AUTO_RETRY_BATCH", "3")
    env_id, _inst, _tasks = seed
    ids = []
    for i in range(7):
        tid = _mk(conn, env_id, f"k-many-{i}")
        _fail(conn, tid, "CHECKOUT_TIMEOUT", minutes_ago=60 + i)   # 越靠前失败得越晚
        ids.append(tid)
    conn.commit()

    # 直接断选单本身:摘要里的条数是它给的,空跑列的也是它给的
    assert len(task_retry.candidates(conn)) == 3

    summary = wf.run({"dry_run": False})
    assert "本轮取满" in summary, "取满了要说一声,否则那个数会被读成「库里就这么多」"

    moved = [i for i in ids if _row(conn, i)["status"] == "ready"]
    # 失败得最早的先重(ORDER BY updated_at),不是随机挑三条 ——
    # minutes_ago = 60 + i,所以 i 越大失败得越早,最早的三条是 ids[4:]。
    assert moved == ids[4:], f"一轮最多 3 条,且先失败的先重:{moved}"


def test_a_failure_that_has_been_sitting_too_long_is_left_to_people(conn, seed, on,
                                                                    monkeypatch):
    """失败太久的不自动重 —— 那是人的事。

    一条 120 天前失败的单还留在 exception 里,通常说明它早就在别处被处置掉了
    (上游取消了、有人手工买了)。这时自动再拍一次,买回来的既不是当初要的东西,
    也没人在等它。一轮条数上限只能把这一批摊到几轮里,真正拦住它的是这道年龄闸。
    """
    monkeypatch.setenv("AMZ_AUTO_RETRY_MAX_AGE_MIN", "1440")   # 24 小时
    env_id, _inst, tasks = seed
    fresh = tasks[0]
    _fail(conn, fresh, "CHECKOUT_TIMEOUT", minutes_ago=60)             # 1 小时前
    stale = _mk(conn, env_id, "k-stale")
    _fail(conn, stale, "CHECKOUT_TIMEOUT", minutes_ago=120 * 24 * 60)  # 120 天前
    conn.commit()

    assert [r["id"] for r in task_retry.candidates(conn)] == [fresh]

    wf.run({"dry_run": False})

    assert _row(conn, fresh)["status"] == "ready"
    assert _row(conn, stale) == {"status": "exception",
                                 "error_code": "CHECKOUT_TIMEOUT", "retry_count": 0}


def test_neither_ceiling_can_be_turned_into_a_silent_off_switch(monkeypatch):
    """条数和年龄这两个上界,0 与负数都按 1 算,**不当成「关」**。

    按 0 算的话,这条链每轮安静地什么都不做,而界面还在替它对运营承诺
    「系统最多自动重试 N 次」,工作流记录页那一格还是绿的 —— 一个看起来在跑、
    实际什么都没做的功能,比没有这个功能更害人。
    关只有一个开关:AMZ_AUTO_RETRY_MAX=0,界面跟着它改口说「需人工重置」。
    """
    monkeypatch.setenv("AMZ_AUTO_RETRY_BATCH", "0")
    monkeypatch.setenv("AMZ_AUTO_RETRY_MAX_AGE_MIN", "-5")
    assert settings.auto_retry_batch() == 1
    assert settings.auto_retry_max_age_minutes() == 1


def test_a_negative_config_never_widens_the_gate(monkeypatch):
    """负数不许把闸门变宽 —— 两个方向都得往「更保守」那边倒。

    backoff 写成负数,make_interval 会把窗口挪到**未来**,于是每一条 exception
    都立刻满足条件:一个手滑的负号把这道闸整个抹掉,而现象只是
    「自动重试怎么这么积极」,没人会想到是配置写反了。
    上限写成负数则跟「关」是同一个意思,但界面显示「最多 -1 次」会让人以为界面坏了。
    """
    monkeypatch.setenv("AMZ_AUTO_RETRY_BACKOFF_MIN", "-99999")
    monkeypatch.setenv("AMZ_AUTO_RETRY_MAX", "-3")
    assert settings.auto_retry_backoff_minutes() == 0
    assert settings.auto_retry_max() == 0
    cfg = task_retry.config()
    assert (cfg["enabled"], cfg["max"], cfg["backoff_min"]) == (False, 0, 0)


def test_stops_at_the_ceiling(conn, seed, on):
    """重满了就交给人 —— 同一张单重几次,全靠这个数。"""
    _env, _inst, tasks = seed
    used_up, one_left = tasks[0], tasks[1]
    _fail(conn, used_up, "PLUGIN_INTERNAL", retry_count=2)     # 上限 2,用完了
    _fail(conn, one_left, "PLUGIN_INTERNAL", retry_count=1)    # 还剩一次
    conn.commit()

    # 空跑清单里也不许有它。这一句盯的是选单 SQL 那一行:少了它,重满的单
    # 照样会被列进「这一轮会动到谁」—— 真跑时 retry_one 会拒掉,任务确实没动,
    # 但所有者是照着空跑那份输出做决定的,那份输出错了没人会发现。
    preview = wf.run({"dry_run": True})
    assert f"#{one_left}" in preview and f"#{used_up}" not in preview, preview
    assert preview.startswith("dry-run:1 条够格自动重试"), preview

    wf.run({"dry_run": False})

    assert _row(conn, used_up) == {"status": "exception",
                                   "error_code": "PLUGIN_INTERNAL", "retry_count": 2}
    assert _row(conn, one_left) == {"status": "ready", "error_code": None, "retry_count": 2}

    # 再跑一轮:刚重过的那条已经不是 exception,谁也不动
    wf.run({"dry_run": False})
    assert _row(conn, one_left)["retry_count"] == 2

    with pytest.raises(task_admin.AdminRefused) as exc:
        task_retry.retry_one(conn, used_up)
    assert exc.value.code == "RETRY_EXHAUSTED"


def test_retry_one_re_judges_the_two_time_gates_by_itself(conn, seed, on):
    """两道时间闸不能只活在选单 SQL 里 —— 直接调 retry_one 的那条路也得挡住。

    retry_one 是个带完整 docstring 的公开积木,docstring 明说自己会把条件再判一遍。
    下一个人给运营台加「立即重试」按钮时会照着这句话直接调它:那条路上要是漏了
    backoff,现象就是「刚失败就立刻拿同一个坏环境再撞一次」,还会把错误码分布
    刷成一片同样的码 —— 而选单那份 SQL 一个字都不会拦到它。
    """
    env_id, _inst, tasks = seed
    fresh = tasks[0]
    _fail(conn, fresh, "CHECKOUT_TIMEOUT", minutes_ago=1)               # backoff=10
    stale = _mk(conn, env_id, "k-ancient")
    _fail(conn, stale, "CHECKOUT_TIMEOUT", minutes_ago=120 * 24 * 60)   # 120 天前
    conn.commit()

    # 选单本来就不会给出这两条,所以下面走的是「有人绕过选单直接调」那条路
    assert task_retry.candidates(conn) == []

    with pytest.raises(task_admin.AdminRefused) as exc:
        task_retry.retry_one(conn, fresh)
    assert exc.value.code == "BACKOFF_NOT_MET"

    with pytest.raises(task_admin.AdminRefused) as exc:
        task_retry.retry_one(conn, stale)
    assert exc.value.code == "TOO_OLD"

    for tid in (fresh, stale):
        assert _row(conn, tid)["status"] == "exception"
        assert _row(conn, tid)["retry_count"] == 0


def test_the_second_judgement_never_refuses_what_the_first_one_passed(conn, seed, on):
    """复判是第二道闸,不是一道会跟第一道打架的闸。

    两处都用 SQL 的 now(),同一个事务里它是固定的 —— 所以选单放行的那一条,
    到 retry_one 必定还放行。换成 Python 时钟就会在边界上抖:选出来一批、
    转头自己拒掉一批,摘要里报「N 条够格 → 已退回 0 条」,而谁也说不清为什么。
    """
    _env, _inst, tasks = seed
    # 卡在 backoff 边界上(backoff=10,这条正好 10 分钟前失败)
    _fail(conn, tasks[0], "CHECKOUT_TIMEOUT", minutes_ago=10)
    conn.commit()

    picked = [r["id"] for r in task_retry.candidates(conn)]
    summary = wf.run({"dry_run": False})

    assert "中途被拒" not in summary, summary
    for tid in picked:
        assert _row(conn, tid)["status"] == "ready"


# ── 「可能已下单」那一组:永远不动 ──────────────────────────────────────

def test_possibly_ordered_never_moves_even_if_someone_puts_it_in_retryable(
        conn, seed, on, monkeypatch):
    """有人手改分组、把「可能已下单」塞进 RETRYABLE —— 这一轮必须什么都不做。

    两组按定义不相交(tests/test_error_codes.py 盯着),但测试只在有人跑它的时候拦。
    定时任务不会等测试:一旦相交,那一轮就是**把一批可能已经在亚马逊上下过单的
    任务自动再拍一遍**。所以选单前还要再断一次,而且这里断的是「整轮拒绝」,
    不是「悄悄把那几个码过滤掉」—— 分组错了就该有人去看,不该被自动兜住。
    """
    monkeypatch.setattr(error_codes, "RETRYABLE",
                        frozenset(error_codes.RETRYABLE | {"ORDER_CONFIRM_TIMEOUT"}))
    _env, _inst, tasks = seed
    risky, normal = tasks[0], tasks[1]
    _fail(conn, risky, "ORDER_CONFIRM_TIMEOUT")
    _fail(conn, normal, "CHECKOUT_TIMEOUT")
    conn.commit()

    with pytest.raises(AssertionError) as exc:
        wf.run({"dry_run": False})
    assert "ORDER_CONFIRM_TIMEOUT" in str(exc.value)

    assert _row(conn, risky)["status"] == "exception"
    assert _row(conn, risky)["retry_count"] == 0
    # 同一轮里够格的那条也没被重 —— 分组出错时整轮停下,不是「重一半」
    assert _row(conn, normal)["status"] == "exception"


def test_the_assert_survives_python_dash_o():
    """这道断言不能用 `assert` 写 —— `python -O` 会把 assert 整条删掉。

    一条能被解释器优化掉的护栏,正是本项目最防的那种「看起来有护栏、实际防不住」。
    """
    src = (paths.repo_root() / "services" / "task_retry.py").read_text(encoding="utf-8")
    body = src[src.index("def _retryable_codes"):src.index("def candidates")]
    assert "raise AssertionError" in body
    assert "\n    assert " not in body, "裸 assert 在 python -O 下会消失"


def test_the_auto_path_is_refused_by_the_ack_gate_not_waved_through(conn, seed, on):
    """自动重试撞上「可能已下单」那道闸,要**被拒**,不是绕过去。

    NEEDS_ACK 的回执含义是**有人去那个买家号的订单页看过了**。自动重试里没有那个人,
    所以它连带 acknowledged 的资格都没有 —— 这一条断的就是「哪天有人在那条链上
    顺手写了 acknowledged=True」。
    """
    _env, _inst, tasks = seed
    risky = tasks[0]
    # 插件漏判时,ORDER_CONFIRM_TIMEOUT 也可能落成 exception(task_admin 的注释记着
    # 这个洞),所以这里刻意造成 exception 而不是 manual。
    _fail(conn, risky, "ORDER_CONFIRM_TIMEOUT")
    conn.commit()

    with pytest.raises(task_admin.AdminRefused) as exc:
        task_retry.retry_one(conn, risky)
    assert exc.value.code == "POSSIBLY_ORDERED"

    # 就算跳过 task_retry 直接去调状态流转,那道闸也在:机器不许带回执
    with pytest.raises(task_admin.AdminRefused) as exc:
        task_admin.reset_to_queue(conn, risky, acknowledged=True, by="auto")
    assert exc.value.code == "ACK_NOT_FOR_AUTO"

    # 不带回执就走到 NEEDS_ACK,一样被拒
    with pytest.raises(task_admin.AdminRefused) as exc:
        task_admin.reset_to_queue(conn, risky, acknowledged=False, by="auto")
    assert exc.value.code == "NEEDS_ACK"

    assert _row(conn, risky) == {"status": "exception",
                                 "error_code": "ORDER_CONFIRM_TIMEOUT", "retry_count": 0}

    src = (paths.repo_root() / "workflows" / "task_retry.py").read_text(encoding="utf-8")
    assert "acknowledged" not in src, "自动重试那条链里不该出现 acknowledged 这个词"


# ── 空跑 / 运行记录 ─────────────────────────────────────────────────────

def test_dry_run_lists_them_and_writes_nothing(conn, seed, on):
    """空跑报的那一批,就是真跑会动的那一批(同一个 candidates())。

    「空跑报一批、真跑动另一批」本项目栽过一次(task_intake 的 dry-run 曾只做
    字段校验、不查库)。空跑之所以有用,全靠这两批是同一批。
    """
    _env, _inst, tasks = seed
    _fail(conn, tasks[0], "ADDRESS_FORM_TIMEOUT")
    conn.commit()

    summary = wf.run({"dry_run": True})

    assert summary.startswith("dry-run:")
    assert f"#{tasks[0]}" in summary and "ADDRESS_FORM_TIMEOUT" in summary
    assert "已试 0/2" in summary
    assert _row(conn, tasks[0]) == {"status": "exception",
                                    "error_code": "ADDRESS_FORM_TIMEOUT", "retry_count": 0}
    assert conn.execute("SELECT count(*) AS n FROM procure.task_events").fetchone()["n"] == 0

    wf.run({"dry_run": False})
    assert _row(conn, tasks[0])["status"] == "ready", "空跑说会动的,真跑就该动"


def test_cli_records_the_run_in_ops_runs(conn, seed, on):
    """走 cli 的统一入口:开跑就写 ops.runs,跑完 UPDATE 成 success。

    运营台「工作流记录」那一页读的就是它 —— 自动重试一旦开着,这条链停了
    界面上那句「系统最多自动重试 N 次」就成了假话,而界面自己看不出来。
    """
    import cli

    _env, _inst, tasks = seed
    _fail(conn, tasks[0], "CHECKOUT_TIMEOUT")
    conn.commit()

    ok, summary = cli._run_one("task_retry", {"dry_run": False})

    assert ok, summary
    row = dict(conn.execute(
        "SELECT workflow, status, summary, finished_at FROM ops.runs ORDER BY id DESC LIMIT 1"
    ).fetchone())
    assert row["workflow"] == "task_retry"
    assert row["status"] == "success" and row["finished_at"] is not None
    assert f"#{tasks[0]}" in row["summary"]
    assert _row(conn, tasks[0])["status"] == "ready"


def test_runs_page_only_watches_it_when_it_is_on(client, conn, monkeypatch):
    """关着的时候不算「必须定时」,那一格不许红。

    照 feishu_writeback 的先例:一格永远红着的卡片会把人训练成忽略红色,
    等 task_sweep 真的停了,那一格红得跟旁边那格一模一样。
    """
    monkeypatch.delenv("AMZ_AUTO_RETRY_MAX", raising=False)
    by = {r["workflow"]: r
          for r in client.get("/v1/admin/runs").json()["data"]["by_workflow"]}
    assert by["task_retry"]["scheduled"] is False
    assert by["task_retry"]["overdue"] is False

    monkeypatch.setenv("AMZ_AUTO_RETRY_MAX", "3")
    by = {r["workflow"]: r
          for r in client.get("/v1/admin/runs").json()["data"]["by_workflow"]}
    assert by["task_retry"]["scheduled"] is True
    assert by["task_retry"]["overdue"] is True, "开着却从没跑过 = 界面在替一条没跑的链许诺"


# ── 界面拿到的事实 ──────────────────────────────────────────────────────

def test_meta_tells_the_web_whether_it_is_on(client, monkeypatch):
    """界面关于 RETRYABLE 那一组的每一句话都从这里来,所以这几个值不能少也不能错。

    `max_age_min` 也得下发:它决定的不是「什么时候重」,而是**会不会重** ——
    界面不知道这道闸,就会对着一张系统永远不会碰的单继续写「不点它也会被放回队列」。
    """
    for var in ("AMZ_AUTO_RETRY_MAX", "AMZ_AUTO_RETRY_BACKOFF_MIN",
                "AMZ_AUTO_RETRY_MAX_AGE_MIN", "AMZ_AUTO_RETRY_BATCH"):
        monkeypatch.delenv(var, raising=False)
    d = client.get("/v1/admin/meta").json()["data"]
    assert d["auto_retry"] == {"enabled": False, "max": 0, "backoff_min": 10,
                               "max_age_min": 1440, "batch": 20}

    monkeypatch.setenv("AMZ_AUTO_RETRY_MAX", "3")
    monkeypatch.setenv("AMZ_AUTO_RETRY_BACKOFF_MIN", "20")
    monkeypatch.setenv("AMZ_AUTO_RETRY_MAX_AGE_MIN", "300")
    monkeypatch.setenv("AMZ_AUTO_RETRY_BATCH", "5")
    d = client.get("/v1/admin/meta").json()["data"]
    assert d["auto_retry"] == {"enabled": True, "max": 3, "backoff_min": 20,
                               "max_age_min": 300, "batch": 5}

    # 那个写死的「做没做自动重试」的布尔不许回来:功能做出来之后,
    # 开没开是配置的事,一个写死的常量迟早与配置说的不是同一件事。
    assert "auto_retry_implemented" not in d["error_code"]


def test_detail_carries_how_many_times_the_machine_tried(client, conn, seed, on):
    """详情要显示已试次数 —— 「系统最多重 N 次」只说了一半,人要知道还剩几次。"""
    _env, _inst, tasks = seed
    _fail(conn, tasks[0], "CHECKOUT_TIMEOUT")
    conn.commit()
    wf.run({"dry_run": False})

    d = client.get(f"/v1/admin/tasks/{tasks[0]}").json()["data"]
    assert d["retry_count"] == 1


# ── 人点的那一下 vs 机器干的那一下 ─────────────────────────────────────

def test_a_manual_reset_does_not_burn_an_automatic_attempt(conn, seed, on):
    """人工重置不计数,而且在事件流里与自动重试**分得开**。

    不分开的后果是:出现重复下单时,没人答得上「这一单是谁又放回队列的」——
    而这正是那种时候第一个要问的问题。
    """
    _env, _inst, tasks = seed
    task_id = tasks[0]
    _fail(conn, task_id, "CHECKOUT_TIMEOUT")

    task_admin.reset_to_queue(conn, task_id, operator="小王")
    assert _row(conn, task_id)["retry_count"] == 0, "人点的那一下不该占掉机器的次数"
    assert _kinds(conn, task_id) == ["admin"]

    _fail(conn, task_id, "CHECKOUT_TIMEOUT")
    conn.commit()
    wf.run({"dry_run": False})

    assert _row(conn, task_id)["retry_count"] == 1
    assert _kinds(conn, task_id) == ["admin", "auto_retry"]

    ev = dict(conn.execute(
        """SELECT kind, payload FROM procure.task_events
            WHERE task_id = %s ORDER BY id DESC LIMIT 1""", (task_id,)).fetchone())
    assert ev["payload"]["by"] == "auto"
    assert ev["payload"]["attempt"] == 1 and ev["payload"]["max"] == 2
    # 重置会把 tasks.error_code 清空,「当初为什么重的」只剩事件里这一份
    assert ev["payload"]["was_error_code"] == "CHECKOUT_TIMEOUT"
    assert ev["payload"]["acknowledged"] is False
