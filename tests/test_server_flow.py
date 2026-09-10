"""P1 验收:不碰 Amazon,跑通 注册 → 认领 → 上报 → 完成/失败 → 状态流转。"""

import pytest

UID = "inst-mock-A"


def _register(client, env_code="env-172"):
    r = client.post("/v1/instances/register",
                    json={"env_code": env_code, "instance_uid": UID,
                          "plugin_version": "0.1.0"})
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _claim(client):
    r = client.post("/v1/tasks/claim", json={"instance_uid": UID})
    assert r.status_code == 200, r.text
    return r.json()["data"]


def test_health(client):
    assert client.get("/health").json()["ok"] is True


def test_register_unknown_env_404(client, seed):
    r = client.post("/v1/instances/register",
                    json={"env_code": "nope", "instance_uid": UID})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "ENV_NOT_FOUND"


def test_register_is_idempotent(client, seed):
    a = _register(client)
    b = _register(client)
    assert a["instance_id"] == b["instance_id"]


def test_heartbeat_requires_registration(client, seed):
    r = client.post("/v1/instances/heartbeat", json={"instance_uid": "ghost"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "INSTANCE_NOT_REGISTERED"


def test_claim_returns_full_task_payload(client, seed):
    _register(client)
    data = _claim(client)
    assert data["marketplace"] == "US"
    assert data["shipping"]["postcode"] == "92707"
    assert data["products"] == [{"asin": "B0FB3VS68J", "quantity": 1}]
    assert data["guards"]["price_cap"] == "12.50"
    assert data["guards"]["max_delivery_days"] == 7


def test_claim_returns_null_when_env_paused(client, conn, seed):
    _register(client)
    conn.execute("UPDATE procure.buyer_envs SET status='paused'")
    assert _claim(client) is None


def test_claim_returns_null_when_nothing_ready(client, conn, seed):
    _register(client)
    conn.execute("UPDATE procure.tasks SET status='pending'")
    assert _claim(client) is None


# ── 护栏 ────────────────────────────────────────────────────────────────

def test_guard_allows_within_cap(client, seed):
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "10.79",
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    assert r.json()["data"]["allow"] is True


def test_guard_blocks_over_price_cap(client, seed):
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "99.00",
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    d = r.json()["data"]
    assert d["allow"] is False and d["error_code"] == "PRICE_CAP_EXCEEDED"


def test_guard_blocks_non_fba(client, seed):
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "1.00",
        "delivery_raw": "Tomorrow", "is_fba": False,
    })
    assert r.json()["data"]["error_code"] == "NOT_FBA"


def test_guard_blocks_unparseable_delivery(client, seed):
    """解析不出来不放行 —— 厂商那边是弹窗让操作员选『继续下单』。"""
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "1.00",
        "delivery_raw": "Arriving after Christmas", "is_fba": True,
    })
    assert r.json()["data"]["error_code"] == "DELIVERY_UNPARSEABLE"


def test_guard_block_is_recorded_as_event(client, conn, seed):
    _register(client)
    t = _claim(client)
    client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "99.00",
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    row = conn.execute(
        "SELECT kind, code FROM procure.task_events WHERE task_id=%s ORDER BY id DESC LIMIT 1",
        (t["task_id"],),
    ).fetchone()
    assert row == {"kind": "guard_block", "code": "PRICE_CAP_EXCEEDED"}


def test_require_fba_really_comes_from_the_column_not_from_a_default(client, conn, seed):
    """把库里那一列改成 false,NOT_FBA 就不该再拦。

    在此之前这道闸是个恒为真的常量:refdata/schema.sql 里没有这一列,
    server/routes/tasks.py 调 adjudicate 时也不传 require_fba,走的是
    services/price_guard.adjudicate 签名里的默认 True。
    也就是说文档和 GuardsOut 里那个"可关的闸"改哪儿都不生效,而界面上它一直亮着。
    这条测试盯的就是「它现在真的从库里那一列来」。
    """
    _register(client)
    conn.execute("UPDATE procure.tasks SET require_fba = false")
    t = _claim(client)
    assert t["guards"]["require_fba"] is False      # 下发给插件的也得是库里那个值
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "1.00",
        "delivery_raw": "Tomorrow", "is_fba": False,
    })
    assert r.json()["data"]["allow"] is True

    # 反方向:默认(true)那条路照旧拦得住 —— 免得这条测试是靠"闸整个没了"通过的
    conn.execute("UPDATE procure.tasks SET require_fba = true, status='ready', "
                 "claimed_by=NULL, claimed_at=NULL")
    t2 = _claim(client)
    assert t2["guards"]["require_fba"] is True
    r2 = client.post(f"/v1/tasks/{t2['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "1.00",
        "delivery_raw": "Tomorrow", "is_fba": False,
    })
    assert r2.json()["data"]["error_code"] == "NOT_FBA"


def test_guard_compares_goods_total_not_what_the_card_gets_charged(client, conn, seed):
    """礼品卡全额抵扣:实付 0.00 ≤ 限价 12.50,但货款 99.00 超了。

    修之前这一单会被放行,库里落 actual_total=0.00,运营台画绿点写「未超」。
    """
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "0.00",
        "gift_card": {"applied": True, "amount": "99.00"},
        "goods_total": "99.00",
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    d = r.json()["data"]
    assert d["allow"] is False and d["error_code"] == "PRICE_CAP_EXCEEDED"
    assert d["goods_total"] == "99.00"
    # 被拦下的单同样要能答出「当时护栏比的是哪个数」
    row = conn.execute("SELECT goods_total, gift_card_amount FROM procure.tasks WHERE id=%s",
                       (t["task_id"],)).fetchone()
    assert str(row["goods_total"]) == "99.00"
    assert str(row["gift_card_amount"]) == "99.00"


def test_gates_before_the_math_still_write_the_numbers_to_the_row(client, conn, seed):
    """FBA / 支付那两道闸排在算钱之前,库里那两列照样要落上。

    docs/01 §5.1 那句「不管放不放行」在这两档上曾经不成立:adjudicate 在算货款
    之前就 return 了,routes 无条件把两个 None 写回库 —— 三列全 NULL,
    运营台于是显示「还没有下单,也就没有实付金额 —— 这几格空着是对的」,
    而插件明明报了 10.79(它还留在 guard_block 事件的 payload 里)。
    「插件根本没报过金额」与「插件报了、闸在算货款之前就拦了」渲染成同一句话。
    """
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "10.79",
        "delivery_raw": "Tomorrow", "is_fba": False,          # ← 闸在算钱之前就返回
    })
    assert r.json()["data"]["error_code"] == "NOT_FBA"
    row = conn.execute("SELECT goods_total FROM procure.tasks WHERE id=%s",
                       (t["task_id"],)).fetchone()
    assert str(row["goods_total"]) == "10.79", "被拦下的单也要答得出当时比的是哪个数"


def test_a_verdict_that_cannot_compute_never_nulls_out_what_was_already_stored(
        client, conn, seed):
    """算不出货款的那一档**什么都不写**,不许拿 NULL 覆盖已经落库的数。

    一单可以过好几次 guard-check(结算页读了一遍又一遍)。上一次落了 10.00,
    这一次认出了礼品卡抵扣行却读不出金额 → 服务端返回 PLUGIN_INTERNAL,
    goods_total 是 None(那时 None 是实话:货款基数真的算不出来)。
    拿它覆盖的话,界面从「当时比的是 10.00」退回成「还没有下单,也就没有实付
    金额」—— 一个更旧、而且是假的结论。
    """
    _register(client)
    t = _claim(client)
    ok = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "10.00",
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    assert ok.json()["data"]["allow"] is True
    before = conn.execute("SELECT goods_total FROM procure.tasks WHERE id=%s",
                          (t["task_id"],)).fetchone()["goods_total"]
    assert str(before) == "10.00"

    bad = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "10.79",
        # 认出抵扣行、读不出金额 → 货款基数算不出来,服务端拒
        "gift_card": {"applied": True, "amount": None},
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    assert bad.json()["data"]["error_code"] == "PLUGIN_INTERNAL"
    after = conn.execute("SELECT goods_total FROM procure.tasks WHERE id=%s",
                         (t["task_id"],)).fetchone()["goods_total"]
    assert str(after) == "10.00", "算不出来的那一次把已经落库的数抹成了 NULL"


def test_server_recomputes_goods_total_and_ignores_the_plugin_number(client, conn, seed):
    """插件报了个假的货款,服务端不采信 —— 护栏裁决在服务端。

    插件说 goods_total=1.00(小于限价),服务端自己算 0.00 + 99.00 = 99.00 → 拦。
    """
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "0.00",
        "gift_card": {"applied": True, "amount": "99.00"},
        "goods_total": "1.00",                       # ← 插件报的,故意与事实不符
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    assert r.json()["data"]["error_code"] == "PRICE_CAP_EXCEEDED"
    assert r.json()["data"]["goods_total"] == "99.00"


def test_zero_total_no_longer_slips_through(client, seed):
    """实付 0.00、没有礼品卡 —— 这是「金额还在 shimmer」的样子,不许放行。"""
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "0.00",
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    d = r.json()["data"]
    assert d["allow"] is False and d["error_code"] == "PLUGIN_INTERNAL"


def test_expected_card_gate_is_off_until_the_env_has_one(client, conn, seed):
    _register(client)
    t = _claim(client)
    body = {"instance_uid": UID, "actual_total": "10.79", "payment_last4": "9021",
            "delivery_raw": "Tomorrow", "is_fba": True}
    assert client.post(f"/v1/tasks/{t['task_id']}/guard-check", json=body
                       ).json()["data"]["allow"] is True

    conn.execute("UPDATE procure.buyer_envs SET expected_card_last4 = '4417'")
    d = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json=body).json()["data"]
    assert d["allow"] is False and d["error_code"] == "PAYMENT_METHOD_UNEXPECTED"

    body["payment_last4"] = "4417"
    assert client.post(f"/v1/tasks/{t['task_id']}/guard-check", json=body
                       ).json()["data"]["allow"] is True


def test_claim_hands_the_plugin_the_expected_card_so_it_can_switch(client, conn, seed):
    """认领响应里要带上这个买家号的 expected_card_last4。

    所有者定稿①(2026-09-09):替买家号切换支付卡。**先切后验,验在服务端。**
    切是插件的动作,而插件不查库 —— 期望卡这一位必须随认领一起下发,
    否则 flow/amazon.ensurePaymentCard 无从知道该切成哪张,那条链整个是死的。

    留空的语义是「不校验也不切」,所以这一位下发 null 时插件一步都不做。
    这两种情形必须分得开:下发 null 的单插件什么也不干,下发 '4417' 的单
    插件会去点开支付选择页 —— 把「没配」渲染成一个空字符串或者干脆漏掉这一位,
    插件那边就只能靠猜。
    """
    _register(client)

    # 这个买家号没配 → 下发 null → 插件一步都不做(既不校验也不切)
    t = _claim(client)
    assert t["guards"]["expected_card_last4"] is None

    # 配上之后,同一条任务重新派出去时下发的就是库里那个值
    conn.execute("UPDATE procure.buyer_envs SET expected_card_last4 = '4417'")
    conn.execute("UPDATE procure.tasks SET status='ready', claimed_by=NULL, claimed_at=NULL")
    t2 = _claim(client)
    assert t2["guards"]["expected_card_last4"] == "4417"

    # **而服务端那道闸一个字没改。** 插件切没切成不算数:guard-check 拿插件
    # 重新读到的尾号自己判。这两条断言合起来才是「先切后验」——
    # 少了后面这一条,「插件负责切」就滑成了「插件说了算」。
    body = {"instance_uid": UID, "actual_total": "10.79", "payment_last4": "9021",
            "delivery_raw": "Tomorrow", "is_fba": True}
    d = client.post(f"/v1/tasks/{t2['task_id']}/guard-check", json=body).json()["data"]
    assert d["allow"] is False and d["error_code"] == "PAYMENT_METHOD_UNEXPECTED"


def test_claim_still_works_when_the_env_has_no_expected_card(client, conn, seed):
    """认领 SQL 现在跨接了 buyer_envs —— 别让它把「没配期望卡」的买家号派不出单。

    CLAIM_SQL 里 env 这个 CTE 从「只选 daily_cap」变成了「还要选
    expected_card_last4」,并且被加进了 UPDATE 的 FROM。写错的话最坏的形态不是
    报错,是**认领静默返回 None** —— 而那和「队列里没单」长得一模一样,
    插件继续每 10 秒问一次,运营台上那台机器显示「待命」,谁也看不出它领不到单。
    """
    _register(client)
    conn.execute("UPDATE procure.buyer_envs SET expected_card_last4 = NULL")
    t = _claim(client)
    assert t is not None and t["guards"]["expected_card_last4"] is None
    # 空字符串也是"没配"的一种写法(界面上清空那一格),同样要派得出去
    conn.execute("UPDATE procure.buyer_envs SET expected_card_last4 = ''")
    conn.execute("UPDATE procure.tasks SET status='ready', claimed_by=NULL, claimed_at=NULL")
    assert _claim(client) is not None


def test_expected_card_changed_mid_flight_still_blocks_the_order(client, conn, seed):
    """认领 → guard-check 之间改期望卡:这一单**必然被拦**,而且今天没人说得清为什么。

    CLAIM_SQL 里 env 那个 CTE 只保证一件事:daily_cap 与 expected_card_last4 是
    **同一瞬间**从库里读到的。它管不着这条真正的窗口 —— guard-check 是另一个请求、
    另一个事务,每次都重新查一遍 buyer_envs(server/routes/tasks.py)。

    所以下面这条链今天是开着的,而且切卡上线之后代价升了一级:
      认领下发 4417 → 运营在运营台上把这一格改成 9021(插件此刻正在支付选择页上
      照着 4417 点确认)→ 插件切完重读结算页得到 4417 → guard-check 上报 4417 →
      服务端重新读库拿到 9021 → PAYMENT_METHOD_UNEXPECTED。
    净结果:一单必然被拦,而且**这个买家号在 Amazon 上的默认支付卡已经被我们
    改成 4417 了** —— 事件流里没有任何一条说过「这次失败是因为期望卡在途中被改了」。

    这条断言不是在庆祝这个行为,是把它钉住:注释里不许再写「同一个 CTE 关掉了
    这条分叉」那句假话。真要关掉它得把期望卡快照进 tasks 行(走改表流程),
    那跨了这条线的文件边界,留给合并那一轮定夺。docs/01 §5.3 记了这一格。
    """
    _register(client)
    conn.execute("UPDATE procure.buyer_envs SET expected_card_last4 = '4417'")
    t = _claim(client)
    assert t["guards"]["expected_card_last4"] == "4417"

    # 在途改配置 —— 插件已经拿着 4417 上路了
    conn.execute("UPDATE procure.buyer_envs SET expected_card_last4 = '9021'")

    d = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "10.79", "payment_last4": "4417",
        "delivery_raw": "Tomorrow", "is_fba": True,
    }).json()["data"]
    assert d["allow"] is False and d["error_code"] == "PAYMENT_METHOD_UNEXPECTED"
    # 而理由里说的是「配的是 9021」—— 一句对着新配置说的话,
    # 看的人无从知道插件当时拿到的是 4417。
    assert "9021" in d["detail"] and "4417" in d["detail"]


def test_guard_check_event_carries_the_numbers_the_guard_actually_used(client, conn, seed):
    """事件流是「不拦但要留痕」那类信号的去处 —— 自洽记录写在这里。"""
    _register(client)
    t = _claim(client)
    client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "8.00",
        "gift_card": {"applied": True, "amount": "2.00"},
        "line_items": [{"asin": "B0FB3VS68J", "unit_price": "1.00", "quantity": 1}],
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    row = conn.execute(
        "SELECT kind, payload FROM procure.task_events WHERE task_id=%s ORDER BY id DESC LIMIT 1",
        (t["task_id"],),
    ).fetchone()
    assert row["kind"] == "step"
    assert row["payload"]["goods_total"] == "10.00"
    assert row["payload"]["gift_card_amount"] == "2.00"
    # Σ单价×数量 = 1.00 vs 货款 10.00,差 90% —— 远超默认阈值,该记一笔
    assert row["payload"]["consistency_note"]


def test_blocked_orders_carry_the_same_numbers_as_allowed_ones(client, conn, seed):
    """被拦下的单和放行的单,事件载荷里是同一组数 —— 尤其是插件报的那个。

    plugin_goods_total 当初只写进了放行那一支。于是「插件把货款算错了」与
    「这一单被护栏拦下了」同时发生时 —— 也就是最需要这条线索的时候 ——
    事件流里反而没有它:事后只知道「服务端算出 99.00 拦了」,不知道插件当时
    算的是 1.00,而这正是「解析层坏了」与「这单真超了」的分水岭。
    """
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "0.00",
        "gift_card": {"applied": True, "amount": "99.00"},
        "goods_total": "1.00",                       # ← 插件报的,与服务端算的不符
        "line_items": [{"asin": "B0FB3VS68J", "unit_price": "1.00", "quantity": 1}],
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    assert r.json()["data"]["error_code"] == "PRICE_CAP_EXCEEDED"
    ev = conn.execute(
        "SELECT kind, payload FROM procure.task_events WHERE task_id=%s ORDER BY id DESC LIMIT 1",
        (t["task_id"],),
    ).fetchone()
    assert ev["kind"] == "guard_block"
    assert ev["payload"]["goods_total"] == "99.00"        # 服务端自己算的
    assert ev["payload"]["plugin_goods_total"] == "1.00"  # 插件算的,两边不一致才非空
    assert ev["payload"]["gift_card_amount"] == "99.00"
    # 护栏正拿这个基数拦单,自洽记录必须跟着出来
    assert ev["payload"]["consistency_note"]


def test_plugin_goods_total_stays_out_of_the_payload_when_the_two_agree(client, conn, seed):
    """一致时不记 —— 一条每单都出现的记录等于没有记录。"""
    _register(client)
    t = _claim(client)
    client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "8.00",
        "gift_card": {"applied": True, "amount": "2.00"},
        "goods_total": "10.00",                      # ← 与服务端算的一致
        "delivery_raw": "Tomorrow", "is_fba": True,
    })
    row = conn.execute(
        "SELECT payload FROM procure.task_events WHERE task_id=%s ORDER BY id DESC LIMIT 1",
        (t["task_id"],),
    ).fetchone()
    assert row["payload"]["plugin_goods_total"] is None


# ── 拆分支付:第一张卡对上了不等于只刷了这一张 ────────────────────────────

def test_split_payment_is_refused_when_the_env_checks_its_card(client, conn, seed):
    """两个已选支付方式、第一个正是期望卡 —— 照旧放行的话第二张卡白刷。

    Amazon 允许把一单拆到多个已选支付方式上。payment_last4 只答得出第一个槽位:
    买家号后台被加了第二张卡时,第一个槽位读出 4417 对得上 → 放行 → 下单 →
    另一张卡也被扣了钱,而库里记的是 4417,运营看到的是一道「已核过支付卡」的绿灯。
    """
    _register(client)
    t = _claim(client)
    conn.execute("UPDATE procure.buyer_envs SET expected_card_last4 = '4417'")
    body = {"instance_uid": UID, "actual_total": "10.79", "payment_last4": "4417",
            "delivery_raw": "Tomorrow", "is_fba": True}

    # 一个槽位:正常单,放行
    assert client.post(f"/v1/tasks/{t['task_id']}/guard-check",
                       json={**body, "payment_slots": 1}).json()["data"]["allow"] is True

    # 两个槽位、没有礼品卡 = 拆到了两张卡上 → 拦
    d = client.post(f"/v1/tasks/{t['task_id']}/guard-check",
                    json={**body, "payment_slots": 2}).json()["data"]
    assert d["allow"] is False and d["error_code"] == "PAYMENT_METHOD_UNEXPECTED"

    # 老插件不报这一位 → 退化成只校验第一张卡,不许因此把正常单拦下
    assert client.post(f"/v1/tasks/{t['task_id']}/guard-check",
                       json=body).json()["data"]["allow"] is True


def test_gift_card_slot_does_not_count_as_a_second_card(client, conn, seed):
    """礼品卡余额自己也占一个槽位 —— 不扣掉它,每张用礼品卡的单都会被拦。

    夹具 checkout-giftcard.html 就是这个形态:两个槽位,第二个是 Gift Card Balance。
    一道把每一单都拦下的闸门等于没有闸门。
    """
    _register(client)
    t = _claim(client)
    conn.execute("UPDATE procure.buyer_envs SET expected_card_last4 = '4417'")
    body = {"instance_uid": UID, "actual_total": "8.79", "payment_last4": "4417",
            "gift_card": {"applied": True, "amount": "2.00"},
            "delivery_raw": "Tomorrow", "is_fba": True}

    assert client.post(f"/v1/tasks/{t['task_id']}/guard-check",
                       json={**body, "payment_slots": 2}).json()["data"]["allow"] is True
    # 卡 + 卡 + 礼品卡 = 还是拆分支付
    d = client.post(f"/v1/tasks/{t['task_id']}/guard-check",
                    json={**body, "payment_slots": 3}).json()["data"]
    assert d["allow"] is False and d["error_code"] == "PAYMENT_METHOD_UNEXPECTED"


def test_split_payment_gate_follows_the_expected_card_switch(client, conn, seed):
    """买家号没配期望卡 = 这个买家号整条支付判据都不看,槽位数也不看。

    与 require_fba / expected_card_last4 同一形态:闸是可关的,关了就全关,
    不要留下「卡不校验但槽位校验」这种半开的状态 —— 那种状态没人说得清它在防什么。
    """
    _register(client)
    t = _claim(client)
    d = client.post(f"/v1/tasks/{t['task_id']}/guard-check", json={
        "instance_uid": UID, "actual_total": "10.79", "payment_slots": 4,
        "delivery_raw": "Tomorrow", "is_fba": True}).json()["data"]
    assert d["allow"] is True


# ── 完成与断言 ──────────────────────────────────────────────────────────

def test_complete_backfills(client, conn, seed):
    """回填的交期用**相对词**,不用写死的月日。

    原来这里写的是 "August 27" —— 它落在哪一年取决于测试跑的那天,
    而且在 8 月 27 日之后的每一天,它都只能靠「向未来滚一年」蒙一个日期出来。
    那一列于是断言了一个凭空捏造的 2027 年日期不为 None。滚年现在有上界
    (services/delivery.MAX_FUTURE_DAYS),蒙不出来了,这条才露出来。
    """
    from datetime import timedelta

    from server.routes.tasks import _site_today

    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-2223334-4445556",
        "actual_total": "10.79", "payment_last4": "7883",
        "delivery_raw": "Arriving tomorrow by 10 PM", "observed_asins": ["B0FB3VS68J"],
    })
    assert r.status_code == 200, r.text
    row = conn.execute("SELECT status, amazon_order_no, delivery_date, delivery_raw "
                       "  FROM procure.tasks WHERE id=%s", (t["task_id"],)).fetchone()
    assert row["status"] == "purchased"
    assert row["amazon_order_no"] == "111-2223334-4445556"
    assert row["delivery_date"] == _site_today() + timedelta(days=1)


def test_complete_keeps_the_raw_when_the_date_is_unparseable(client, conn, seed):
    """读不懂的交期原文**照样入库**,只是 delivery_date 留空。

    「不确定就不写」说的是不写一个编出来的日期,不是把线索一起丢掉 ——
    delivery_raw 正是解析失败时唯一的线索。
    """
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-2223334-4445557",
        "delivery_raw": "Arriving after Christmas", "observed_asins": ["B0FB3VS68J"],
    })
    assert r.status_code == 200, r.text
    row = conn.execute("SELECT delivery_date, delivery_raw FROM procure.tasks WHERE id=%s",
                       (t["task_id"],)).fetchone()
    assert row["delivery_date"] is None
    assert row["delivery_raw"] == "Arriving after Christmas"


def test_complete_rejects_mismatched_asin(client, conn, seed):
    """订单卡 ASIN 与本单不符 → 不写库,转人工。"""
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-0000000-0000000",
        "observed_asins": ["B0DIFFERENT"],
    })
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "ORDER_NO_AMBIGUOUS"
    row = conn.execute("SELECT status, error_code, amazon_order_no FROM procure.tasks "
                       "WHERE id=%s", (t["task_id"],)).fetchone()
    assert row["status"] == "manual"
    assert row["error_code"] == "ORDER_NO_AMBIGUOUS"
    assert row["amazon_order_no"] is None, "断言失败时绝不能把单号写进去"


def test_complete_allows_empty_observed_asins(client, seed):
    """没采到 ASIN 不算断言失败 —— 断言是抓错配,不是制造噪音。"""
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-1111111-1111111",
        "observed_asins": [],
    })
    assert r.status_code == 200


# ── 失败与释放 ──────────────────────────────────────────────────────────

def test_fail_writes_structured_code(client, conn, seed):
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/fail", json={
        "instance_uid": UID, "error_code": "OUT_OF_STOCK", "cart_cleared": True,
    })
    assert r.json()["data"]["status"] == "exception"
    assert conn.execute("SELECT error_code FROM procure.tasks WHERE id=%s",
                        (t["task_id"],)).fetchone()["error_code"] == "OUT_OF_STOCK"


def test_fail_without_cart_cleared_leaves_warning(client, conn, seed):
    _register(client)
    t = _claim(client)
    client.post(f"/v1/tasks/{t['task_id']}/fail", json={
        "instance_uid": UID, "error_code": "OUT_OF_STOCK", "cart_cleared": False,
    })
    warns = conn.execute(
        "SELECT payload FROM procure.task_events WHERE task_id=%s AND kind='step'",
        (t["task_id"],),
    ).fetchall()
    assert any(w["payload"].get("warning") == "cart_not_cleared" for w in warns)


def test_release_returns_to_ready(client, conn, seed):
    _register(client)
    t = _claim(client)
    r = client.post(f"/v1/tasks/{t['task_id']}/release", json={"instance_uid": UID})
    assert r.json()["data"]["status"] == "ready"


def test_cannot_report_on_task_not_held(client, seed):
    _register(client)
    t = _claim(client)
    client.post(f"/v1/tasks/{t['task_id']}/release", json={"instance_uid": UID})
    r = client.post(f"/v1/tasks/{t['task_id']}/fail", json={
        "instance_uid": UID, "error_code": "OUT_OF_STOCK"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "TASK_NOT_HELD"


# ── 物流 ────────────────────────────────────────────────────────────────

def test_shipment_sync(client, conn, seed):
    _register(client)
    t = _claim(client)
    client.post(f"/v1/tasks/{t['task_id']}/complete", json={
        "instance_uid": UID, "amazon_order_no": "111-5555555-5555555",
        "observed_asins": ["B0FB3VS68J"]})
    r = client.post("/v1/shipments/sync", json={
        "instance_uid": UID, "task_id": t["task_id"], "carrier": "UPS",
        "tracking_no": "1Z999", "status": "in_transit",
        "events": [{"raw_day": "August 28, 2026", "raw_time": "8:42 AM",
                    "description": "Arrived at facility", "city": "Los Angeles",
                    "state_code": "CA"}],
    })
    assert r.json()["data"]["events"] == 1
    ev = conn.execute("SELECT description, seq FROM logistics.shipment_events").fetchall()
    assert ev == [{"description": "Arrived at facility", "seq": 0}]


def test_shipment_sync_replaces_events(client, conn, seed):
    """重复回传是全量快照,整批替换,不做增量合并(否则会产生重复行)。"""
    _register(client)
    t = _claim(client)
    body = {"instance_uid": UID, "task_id": t["task_id"],
            "events": [{"description": "A"}, {"description": "B"}]}
    client.post("/v1/shipments/sync", json=body)
    client.post("/v1/shipments/sync", json=body)
    n = conn.execute("SELECT count(*) AS n FROM logistics.shipment_events").fetchone()["n"]
    assert n == 2


def test_complete_writes_actual_unit_price(client, conn, seed):
    """task_products.actual_unit_price 之前被读了两处、写了零处。

    列在库里、文档写着「结算页实测,回传后填」、设计画布上还显示着「实付单价」——
    但从来没人填。这类「看起来有、其实是空的」字段最坏:
    对账的人拿它跟限价比,比出来永远是空,而他会以为是数据还没同步。
    """
    _env, _inst, tasks = seed
    r = client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"})
    tid = r.json()["data"]["task_id"]

    client.post(f"/v1/tasks/{tid}/complete", json={
        "instance_uid": "inst-A",
        "amazon_order_no": "111-0000021-0000021",
        "actual_total": "10.79",
        "observed_asins": ["B0FB3VS68J"],
        "line_items": [{"asin": "B0FB3VS68J", "unit_price": "9.99", "quantity": 1}],
    })

    row = conn.execute(
        "SELECT actual_unit_price FROM procure.task_products WHERE task_id = %s", (tid,)
    ).fetchone()
    assert str(row["actual_unit_price"]) == "9.99"


def test_complete_ignores_unit_prices_for_asins_not_in_the_task(client, conn, seed):
    """结算页多出一行商品意味着买错了东西。

    那种情况应该在购物车回读那一步就被 CART_MISMATCH 拦住,轮不到这里补救 ——
    所以这里只更新已存在的商品行,不新增。悄悄补一行进去,
    等于让一个本该失败的单看起来正常。
    """
    _env, _inst, tasks = seed
    r = client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"})
    tid = r.json()["data"]["task_id"]

    client.post(f"/v1/tasks/{tid}/complete", json={
        "instance_uid": "inst-A",
        "amazon_order_no": "111-0000022-0000022",
        "observed_asins": ["B0FB3VS68J"],
        "line_items": [{"asin": "B0FB3VS68J", "unit_price": "9.99", "quantity": 1},
                       {"asin": "B0NOTOURS1", "unit_price": "1.00", "quantity": 1}],
    })

    rows = conn.execute(
        "SELECT asin FROM procure.task_products WHERE task_id = %s", (tid,)).fetchall()
    assert [x["asin"] for x in rows] == ["B0FB3VS68J"]


def test_late_complete_keeps_the_order_number(client, conn, seed):
    """任务在插件背后被清扫成 manual 之后再回填,单号必须留痕。

    典型成因:这一单跑得久(多商品、页面慢),task_sweep 已经把它当超时转走了。
    此刻插件那边 Amazon 上很可能已经真下成了单 —— 把请求原样丢掉的话,
    那个真实单号就只剩在插件的内存里,库里、事件流里、日志里全都没有。
    运营看到的是一条「没回传」的任务,而钱已经花掉了。
    """
    _env, _inst, tasks = seed
    r = client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"})
    tid = r.json()["data"]["task_id"]

    # 背着插件把它清扫走
    conn.execute("""UPDATE procure.tasks SET status='manual', error_code='CLAIM_TIMEOUT',
                           claimed_by=NULL, claimed_at=NULL WHERE id=%s""", (tid,))
    conn.commit()

    resp = client.post(f"/v1/tasks/{tid}/complete", json={
        "instance_uid": "inst-A", "amazon_order_no": "111-0000031-0000031",
        "actual_total": "10.79", "observed_asins": ["B0FB3VS68J"]})
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "TASK_NOT_HELD"

    ev = conn.execute("""SELECT payload FROM procure.task_events
                          WHERE task_id=%s AND kind='assert_failed'
                          ORDER BY id DESC LIMIT 1""", (tid,)).fetchone()
    assert ev is not None, "拒绝之前必须先把单号留痕"
    assert ev["payload"]["amazon_order_no"] == "111-0000031-0000031"
    assert ev["payload"]["reason"] == "late_complete"


def test_duplicate_order_no_on_complete_does_not_500(client, conn, seed):
    """撞上 uq_tasks_amazon_order_no 不能靠数据库抛异常来兜。

    UniqueViolation 会让整个事务作废:连「这个单号是谁报上来的」都留不下,
    任务还会卡死在 claimed —— 因为那条 UPDATE 也被一起回滚了。
    所以写之前先查。
    """
    _env, _inst, tasks = seed
    conn.execute("""UPDATE procure.tasks SET status='purchased',
                           amazon_order_no='111-0000032-0000032' WHERE id=%s""", (tasks[2],))
    conn.commit()

    r = client.post("/v1/tasks/claim", json={"instance_uid": "inst-A"})
    tid = r.json()["data"]["task_id"]

    resp = client.post(f"/v1/tasks/{tid}/complete", json={
        "instance_uid": "inst-A", "amazon_order_no": "111-0000032-0000032",
        "observed_asins": ["B0FB3VS68J"]})
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ORDER_NO_TAKEN"

    row = conn.execute("SELECT status, error_code FROM procure.tasks WHERE id=%s",
                       (tid,)).fetchone()
    assert row["status"] == "manual"          # 没卡在 claimed
    assert row["error_code"] == "ORDER_NO_AMBIGUOUS"

    ev = conn.execute("""SELECT payload FROM procure.task_events
                          WHERE task_id=%s AND kind='assert_failed'
                          ORDER BY id DESC LIMIT 1""", (tid,)).fetchone()
    assert ev["payload"]["amazon_order_no"] == "111-0000032-0000032"
    assert ev["payload"]["held_by_task"] == tasks[2]
