"""买家号 ID(amazon_customer_id):对账 + **登录的不是这个买家号**。

在此之前 `buyer_envs.amazon_customer_id` 是一列**永远为空的数据** ——
db_schema 写着「插件从页面提取,仅作对账」,而全仓一个写入点都没有。

补上写入点之后,它顺带能答一个真会出事的问题:**这台机器登着的到底是不是
这个买家号**。防关联环境一多,谁的 profile 里登了哪个号是记不住的;
登错了的机器在运营台上原先是满格绿色的「在线 · 可派」,而它领到的每一单
都会用另一个买家号在亚马逊上真买下来 —— 钱花了、货发了,库里记的是这个买家号。

判据与登录态是**两条独立的轴**,所以两套词、两道闸,不共用一句话。
"""

import pytest

from services import instance, task_queue, vocab

ID_A = "A3KM7PLQ92XVYD"
ID_B = "A1ZZZZZZZZZZZZ"


def _beat(client, customer_id=None, uid="inst-A", **extra):
    body = {"instance_uid": uid, **extra}
    if customer_id is not None:
        body["amazon_customer_id"] = customer_id
    return client.post("/v1/instances/heartbeat", json=body)


def _env(conn):
    return conn.execute(
        "SELECT amazon_customer_id FROM procure.buyer_envs WHERE code='env-172'"
    ).fetchone()["amazon_customer_id"]


def _events(conn, kind=None):
    sql = "SELECT kind, payload FROM procure.env_events"
    sql += f" WHERE kind = '{kind}'" if kind else ""
    return conn.execute(sql + " ORDER BY id").fetchall()


# ── 首次写入 ────────────────────────────────────────────────────────────

def test_the_first_report_fills_in_an_empty_column(client, conn, seed):
    """这一列此前没有任何写入点 —— 补上的就是这一条。"""
    r = _beat(client, ID_A)
    assert r.status_code == 200
    assert r.json()["data"]["account_state"] == "ok"
    assert _env(conn) == ID_A
    ev = _events(conn, "customer_id_seen")
    assert len(ev) == 1
    assert ev[0]["payload"]["reported"] == ID_A


def test_the_first_report_is_written_once_not_every_beat(client, conn, seed):
    """20 秒一次的心跳不该每次都往事件流里灌一条同样的话。"""
    _beat(client, ID_A)
    _beat(client, ID_A)
    _beat(client, ID_A)
    assert len(_events(conn, "customer_id_seen")) == 1


def test_not_reporting_keeps_the_last_one(client, conn, seed):
    """不传 = 这一轮没有新消息(与 login_state 同一条规则)。

    抹成空的话,一台登错号的机器只要有一轮读不到 customerId,
    认领闸当场重新打开。
    """
    _beat(client, ID_A)
    _beat(client)                       # 这一轮什么都没读到
    inst = conn.execute(
        "SELECT amazon_customer_id FROM procure.plugin_instances WHERE instance_uid='inst-A'"
    ).fetchone()
    assert inst["amazon_customer_id"] == ID_A
    assert _env(conn) == ID_A


# ── 不一样:不覆盖,拒认领 ──────────────────────────────────────────────

def test_a_different_account_does_not_overwrite_the_column(client, conn, seed):
    """**不覆盖**是这一条的关键。

    覆盖的话,一台登错号的机器会把买家号那一列改成它自己登的号 ——
    「登错了」这件事被它自己抹平,下一轮心跳一切正常,而单子照派。
    """
    _beat(client, ID_A)
    r = _beat(client, ID_B)
    assert r.json()["data"]["account_state"] == "mismatch"
    assert _env(conn) == ID_A, "库里那一列被登错号的机器改掉了"


def test_a_mismatched_instance_is_refused_at_claim(client, conn, seed):
    """认领时拒,而且**说得出闸的名字** —— 不是回一个「没有单」。

    回「没有单」的话,插件每 10 秒安静地问一次,运营台上那台机器写着「待命」,
    而队列里正堆着单。这与 INSTANCE_SIGNED_OUT 是同一个形状、同一个理由。
    """
    _beat(client, ID_A)
    _beat(client, ID_B)
    r = client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"})
    assert r.status_code == 409
    body = r.json()
    assert body["error"]["code"] == "INSTANCE_ACCOUNT_MISMATCH"
    # 两个 ID 都要在话里 —— 人得判断该去改机器还是改库
    assert ID_A in body["error"]["message"] and ID_B in body["error"]["message"]
    assert {t["status"] for t in conn.execute(
        "SELECT status FROM procure.tasks").fetchall()} == {"ready"}


def test_the_mismatch_is_recorded_once_per_account_not_once_per_beat(client, conn, seed):
    """一台登错号的机器 20 秒一次心跳,一天 4300 条 —— 那不是留痕,是噪音。

    真正要留痕的是**这件事第一次发生**,以及**换了个号登进去**(那是新消息)。
    """
    _beat(client, ID_A)
    _beat(client, ID_B)
    _beat(client, ID_B)
    _beat(client, ID_B)
    assert len(_events(conn, "customer_id_mismatch")) == 1
    _beat(client, "A9WWWWWWWWWWWW")      # 换了个号 = 新消息
    assert len(_events(conn, "customer_id_mismatch")) == 2


def test_coming_back_to_the_right_account_reopens_the_gate_by_itself(client, conn, seed):
    """换回正确的号,这道闸自己就开了 —— 因为它是**现算的**,不是库里存的一位。

    存一位布尔的话,它要在四个地方被清,漏清任何一处的表现都是
    「这个买家号从此一单也派不出去」,而界面上写的还是一个已经不成立的理由。
    """
    _beat(client, ID_A)
    _beat(client, ID_B)
    assert client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"}).status_code == 409
    _beat(client, ID_A)
    r = client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"})
    assert r.status_code == 200 and r.json()["data"] is not None


# ── 「以这个为准」──────────────────────────────────────────────────────

def test_taking_the_reported_account_as_the_truth_restores_dispatch(client, conn, seed):
    """人核对之后确认「库里那一列记错了」→ 改成插件报的,派单恢复。"""
    _beat(client, ID_A)
    _beat(client, ID_B)
    env_id = conn.execute(
        "SELECT id FROM procure.buyer_envs WHERE code='env-172'").fetchone()["id"]
    r = client.post(f"/v1/admin/envs/{env_id}/customer-id",
                    json={"amazon_customer_id": ID_B, "operator": "张三"})
    assert r.status_code == 200, r.text
    assert _env(conn) == ID_B
    assert client.post("/v1/tasks/claim",
                       json={"instance_uid": "inst-A"}).status_code == 200


def test_taking_it_as_the_truth_leaves_a_trace_with_a_name(client, conn, seed):
    """**一个能打开闸门的按钮,按完之后库里一个字都不留是不行的。**

    (expected_card_last4 至今仍是那样 —— 那是另一件事,这里不假装做过。)
    """
    _beat(client, ID_A)
    env_id = conn.execute(
        "SELECT id FROM procure.buyer_envs WHERE code='env-172'").fetchone()["id"]
    client.post(f"/v1/admin/envs/{env_id}/customer-id",
                json={"amazon_customer_id": ID_B, "operator": "张三"})
    ev = _events(conn, "customer_id_override")
    assert len(ev) == 1
    assert ev[0]["payload"] == {"expected": ID_A, "reported": ID_B,
                                "operator": "张三",
                                "note": "人工把买家号ID 改成了这个值"}
    got = client.get(f"/v1/admin/envs/{env_id}/events").json()["data"]["items"]
    # 中文标签由服务端贴好 —— 让调用方再写一份中文就又多了一处会分叉的副本
    assert got[0]["label"] == vocab.ENV_EVENT_LABELS["customer_id_override"]


def test_a_misshapen_account_is_refused_with_a_name(client, conn, seed):
    """形状不对的值写进去就成了「这个买家号该是谁」——
    这道闸从此永远拦着它自己,而运营看到的理由是假的。"""
    env_id = conn.execute(
        "SELECT id FROM procure.buyer_envs WHERE code='env-172'").fetchone()["id"]
    r = client.post(f"/v1/admin/envs/{env_id}/customer-id",
                    json={"amazon_customer_id": "not-an-id"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "BAD_CUSTOMER_ID"


# ── 形状不对的上报:不写库,但也不拒这条心跳 ────────────────────────────

def test_a_misshapen_report_is_dropped_without_killing_the_heartbeat(client, conn, seed):
    """拒这条心跳的话,`last_seen_at` 不再更新 —— 这台机器在运营台上变成「失联」,
    登录态也送不上去:**一个毒值把整条通道堵死**。

    所以只把它挡在库外,并原样回给插件让它在日志里看得见 ——
    静默丢掉才是这个项目最不该有的处置。
    """
    for bad in ("", "   ", "0", "1234567890", "A12", "a3km7plq92xvyd"):
        r = _beat(client, bad)
        assert r.status_code == 200, bad
        assert r.json()["data"]["account_state"] == "unknown", bad
    assert _env(conn) is None
    assert _events(conn) == []
    assert _beat(client, "A12").json()["data"]["customer_id_rejected"] == "A12"


# ── 与登录态是两条轴 ────────────────────────────────────────────────────

def test_admin_instances_agrees_with_the_real_claim_gate(client, conn, seed):
    """运营台那一列与真闸调的是**同一个函数**。

    daily_cap 那次分叉的教训:界面自己算一遍「可派单」,算法跟真闸不一样,
    于是界面上绿着、实际派不出。
    """
    _beat(client, ID_A)
    _beat(client, ID_B)
    row = client.get("/v1/admin/instances").json()["data"]["items"][0]
    assert row["account_state"] == "mismatch"
    assert row["account_blocks_dispatch"] is True
    assert row["dispatchable"] is False
    # 两个 ID 都下发:界面要写「登录的不是这个买家号(A… ≠ A…)」
    assert row["amazon_customer_id"] == ID_A
    assert row["instance_customer_id"] == ID_B
    # 真闸
    assert client.post("/v1/tasks/claim",
                       json={"instance_uid": "inst-A"}).status_code == 409


def test_never_reported_is_unknown_and_does_not_block(client, conn, seed):
    """老插件从不报这一位,买家号那一列也可能一直是空的。

    拦住 `unknown` 的话,每一台还没报过账号的机器都领不到第一单 ——
    与 login_state 的 unknown 是同一个道理。但界面上它必须与 ok 分得开。
    """
    _beat(client)
    row = client.get("/v1/admin/instances").json()["data"]["items"][0]
    assert row["account_state"] == "unknown"
    assert row["account_blocks_dispatch"] is False
    assert row["dispatchable"] is True
    assert client.post("/v1/tasks/claim",
                       json={"instance_uid": "inst-A"}).status_code == 200


def test_login_state_and_account_state_are_two_axes(client, conn, seed):
    """心跳一秒不落、登录态 ok 的机器,浏览器里登的照样可能是隔壁那个号。"""
    _beat(client, ID_A, login_state="ok")
    _beat(client, ID_B, login_state="ok")
    row = client.get("/v1/admin/instances").json()["data"]["items"][0]
    assert row["login_state"] == "ok" and row["login_blocks_dispatch"] is False
    assert row["account_state"] == "mismatch"


# ── 封闭集 ──────────────────────────────────────────────────────────────

def test_account_state_closed_set_has_exactly_one_meaning_everywhere(client):
    """封闭集 ↔ 中文标签 ↔ 色调 ↔ meta,四处一个不多一个不少。

    少一处的表现是界面上冒出一个裸英文 `mismatch` —— 而这一格恰恰是
    要人立刻去处理的那一格。
    """
    assert set(vocab.ACCOUNT_STATE_LABELS) == task_queue.ACCOUNT_STATES
    assert set(vocab.ACCOUNT_STATE_TONE) == task_queue.ACCOUNT_STATES
    got = client.get("/v1/admin/meta").json()["data"]["account_state"]
    assert got["labels"] == vocab.ACCOUNT_STATE_LABELS
    assert got["tone"] == vocab.ACCOUNT_STATE_TONE
    # ok 与 unknown 必须是两个词(「买家号对得上」 vs 「还没比对过」)——
    # 渲染成同一个词就是这个项目反复栽的那种缺陷。
    assert len(set(vocab.ACCOUNT_STATE_LABELS.values())) == 3


def test_env_event_kinds_and_labels_do_not_drift(conn, seed):
    assert set(vocab.ENV_EVENT_LABELS) == instance.ENV_EVENT_KINDS
    env_id = conn.execute(
        "SELECT id FROM procure.buyer_envs WHERE code='env-172'").fetchone()["id"]
    with pytest.raises(ValueError, match="未知买家号事件类型"):
        instance.record_env_event(conn, env_id, "customer_id_whatever")


def test_account_mismatch_is_deliberately_not_an_error_code():
    """`INSTANCE_ACCOUNT_MISMATCH` **不进 docs/01 §4 那张错误码表**,
    照 `INSTANCE_SIGNED_OUT` 的先例。

    它回答的不是「这一单为什么失败」—— 单子本身没毛病,是那台机器登错了号。
    处置是去换账号(或者改库里那一列),`tasks.error_code` 一个字都不会写;
    编一个码进去,它会永远停在 0 次出现,还得硬塞进四个处置分组之一。
    """
    from services import error_codes

    assert "INSTANCE_ACCOUNT_MISMATCH" not in error_codes.ERROR_CODES
    assert "INSTANCE_SIGNED_OUT" not in error_codes.ERROR_CODES
