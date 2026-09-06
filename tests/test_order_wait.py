"""下单之后那一段等待,在服务端这一侧要成立的几件事。

插件那边的三段等待、露窗口、倒计时验不了(没有浏览器,也没有可登录的买家号),
但**它依赖服务端的三样东西**,这三样验得了:

  1. 认领响应里要有 claim_timeout_min —— 插件的等待硬顶按它反推。
     没有它的话插件只能自己拍一个上界,而 task_sweep 只看 claimed_at:
     等过了头,任务先被判成 CLAIM_TIMEOUT,之后操作员做完验证、订单真下成了,
     complete 却拿回 409 —— 钱花了、货发了,系统里是一条没有单号的待人工。
  2. 列表要看得出「这一单正卡在验证页上等人」,而不是与「拍单中」混成一片。
  3. 新错误码 PAYMENT_VERIFICATION_TIMEOUT 走得通 /fail,并且落在
     「必须转人工 + 可能已下单」那两组里(重置前要有人去买家号确认过)。
"""

import pytest

UID = "inst-wait-A"


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


# ── 1. 上界由服务端下发 ────────────────────────────────────────────────

def test_claim_hands_the_plugin_its_own_deadline(client, seed):
    """认领响应必须带 claim_timeout_min。

    这个字段不是给人看的,是给插件算硬顶用的。少了它,插件就只能自己拍一个数,
    而那个数与 sweep 的判定分叉的后果是本项目最坏的一种结局(见模块 docstring)。
    """
    _register(client)
    task = _claim(client)
    assert task["claim_timeout_min"] == 15, "默认值应与 registry.settings 一致"


def test_claim_timeout_is_read_from_config_not_hardcoded(client, seed, monkeypatch):
    """改配置就能改上界,不用发新插件版本。

    这是「护栏在服务端」那条判断在超时上的同一个形状:厂商把超时写死在插件里,
    改一次要全员升级。
    """
    monkeypatch.setenv("AMZ_CLAIM_TIMEOUT_MIN", "25")
    _register(client)
    task = _claim(client)
    assert task["claim_timeout_min"] == 25


# ── 2. 列表看得出「在等人」 ─────────────────────────────────────────────

def _step(client, task_id, payload):
    r = client.post(f"/v1/tasks/{task_id}/events",
                    json={"instance_uid": UID,
                          "events": [{"kind": "step", "payload": payload}]})
    assert r.status_code == 200, r.text


def _row(client, task_id):
    r = client.post("/v1/admin/tasks/search", json={"page_size": 50})
    assert r.status_code == 200, r.text
    return next(x for x in r.json()["data"]["items"] if x["id"] == task_id)


def test_list_marks_the_task_that_is_waiting_for_a_human(client, seed):
    """「拍单中」与「拍单中,正卡在发卡行验证页上等人」不能渲染成同一个东西。

    前者什么都不用做,后者要有人去催操作员 —— 而它再等几分钟就会转待人工。
    列表上分不出来的话,没人有理由去点开那一条。
    """
    _register(client)
    task = _claim(client)
    tid = task["task_id"]

    row = _row(client, tid)
    assert row["awaiting_manual_verification"] is False
    assert row["awaiting_since"] is None

    _step(client, tid, {"step": "点击下单按钮", "may_have_ordered": True})
    _step(client, tid, {"step": "等待人工完成支付验证",
                        "state": "manual_verification",
                        "deadline_ms": 1_700_000_000_000})

    row = _row(client, tid)
    assert row["awaiting_manual_verification"] is True
    assert row["awaiting_since"] is not None, "得说得出从什么时候开始等的"

    # 验证做完了就不再是「在等人」——**这一位必须会落回去**。
    # 只会亮不会灭的灯,人看两次就不看了。
    _step(client, tid, {"step": "人工支付验证已完成", "state": "manual_verification_done"})
    row = _row(client, tid)
    assert row["awaiting_manual_verification"] is False
    assert row["awaiting_since"] is None


def test_awaiting_flag_only_applies_to_claimed_tasks(client, seed):
    """任务已经落终态之后,那条 step 事件还在,但它不该再让列表说「在等人」。

    事件流是只追加的,所以「最后一条 step 是等验证」这件事永远为真;
    真正决定要不要催人的是「这一单现在还在跑吗」。
    """
    _register(client)
    task = _claim(client)
    tid = task["task_id"]
    _step(client, tid, {"step": "等待人工完成支付验证", "state": "manual_verification",
                        "deadline_ms": 1_700_000_000_000})
    r = client.post(f"/v1/tasks/{tid}/fail",
                    json={"instance_uid": UID, "error_code": "PAYMENT_VERIFICATION_TIMEOUT",
                          "detail": "等了 360 秒仍未完成", "to_manual": True,
                          "cart_cleared": False, "cart_clear_attempted": False})
    assert r.status_code == 200, r.text
    row = _row(client, tid)
    assert row["awaiting_manual_verification"] is False


# ── 3. 新错误码 ────────────────────────────────────────────────────────

def test_payment_verification_timeout_goes_to_manual_and_needs_ack(client, seed):
    """发卡行验证超时:转待人工,而且重置前必须有人去买家号里确认过。

    这一格的现场是「订单已经提交给 Amazon、正卡在发卡行验证」——
    钱很可能已经扣了。直接重置就是让下一个实例把同一单再买一遍。
    """
    from services import error_codes

    assert "PAYMENT_VERIFICATION_TIMEOUT" in error_codes.TO_MANUAL
    assert "PAYMENT_VERIFICATION_TIMEOUT" in error_codes.POSSIBLY_ORDERED
    assert "PAYMENT_VERIFICATION_TIMEOUT" not in error_codes.RETRYABLE

    _register(client)
    task = _claim(client)
    tid = task["task_id"]
    r = client.post(f"/v1/tasks/{tid}/fail",
                    json={"instance_uid": UID, "error_code": "PAYMENT_VERIFICATION_TIMEOUT",
                          "detail": "点了下单,页面转到发卡行验证页,等了 360 秒仍未完成",
                          "to_manual": True, "cart_cleared": False,
                          "cart_clear_attempted": False})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["status"] == "manual"

    # 那道二次确认闸要认它:不带 acknowledged 的重置必须被拒。
    r = client.post(f"/v1/admin/tasks/{tid}/reset", json={"operator": "tester"})
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "NEEDS_ACK"

    r = client.post(f"/v1/admin/tasks/{tid}/reset",
                    json={"operator": "tester", "acknowledged": True})
    assert r.status_code == 200, r.text


# ── 4. 「没清车」与「清不动车」是两件事 ─────────────────────────────────

def test_not_touching_the_cart_after_the_order_point_is_not_a_cart_failure(client, seed):
    """越过下单点之后按规矩不动购物车 —— 那是规矩被遵守了,不是一次清车失败。

    两者写成同一条 warning 的话,运营台上「清不动车」那一格会被每一单
    「可能已下单」刷满,而真正清不动车的那台机器淹在里面 ——
    「看起来有护栏、实际防不住」的又一个形状。
    """
    _register(client)
    tid = _claim(client)["task_id"]
    client.post(f"/v1/tasks/{tid}/fail",
                json={"instance_uid": UID, "error_code": "ORDER_CONFIRM_TIMEOUT",
                      "detail": "点了下单但没等到确认页", "to_manual": True,
                      "cart_cleared": False, "cart_clear_attempted": False})

    r = client.get(f"/v1/admin/tasks/{tid}")
    events = r.json()["data"]["events"]
    warns = [e for e in events if e["payload"].get("warning") == "cart_not_cleared"]
    assert not warns, "没试过清车不该记成清车失败"
    marks = [e for e in events
             if e["payload"].get("cart") == "not_touched_after_order_point"]
    assert len(marks) == 1, "但这件事本身要留痕 —— 不能什么都不说"


def test_a_real_cart_failure_shows_up_on_the_buyer_env_row(client, seed):
    """真的清不动车要能在运营台的买家号那一页上看见。

    这一位以前是**只写不读**的:/fail 记一条 warning,全项目没有任何地方读它。
    而清车是每一单的第一步,它失败通常意味着 Amazon 改了购物车页的结构 ——
    队列里的单会被一单一单打进「拍单异常」桶,而那台机器在界面上是
    满格绿色的「在线 · 可派」。
    """
    _register(client)
    tid = _claim(client)["task_id"]

    rows = client.get("/v1/admin/instances").json()["data"]["items"]
    assert [r for r in rows if r["env_code"] == "env-172"][0]["cart_fail_24h"] == 0

    client.post(f"/v1/tasks/{tid}/fail",
                json={"instance_uid": UID, "error_code": "PLUGIN_INTERNAL",
                      "detail": "购物车里还有 2 件,但找不到删除控件", "to_manual": False,
                      "cart_cleared": False, "cart_clear_attempted": True})

    rows = client.get("/v1/admin/instances").json()["data"]["items"]
    row = [r for r in rows if r["env_code"] == "env-172"][0]
    assert row["cart_fail_24h"] == 1


# ── 5. 契约:插件与服务端对同一段 payload 的写法 ────────────────────────

def test_the_step_payload_shape_the_plugin_sends_is_the_one_the_list_reads():
    """插件发的那两条 step 事件的形状,与列表 SQL 读的那把钥匙必须是同一个。

    这条测试盯的是**跨文件的字面量**:run.ts 里写 `state: "manual_verification"`,
    task_query.py 里读 `payload->>'state' = 'manual_verification'`。
    两处任何一边改了字面量,列表上那个徽标就会安静地永远不亮 ——
    而「没有单在等人」与「有单在等人但我们不知道」长得一模一样。
    """
    from registry import paths

    run_ts = (paths.repo_root() / "extension" / "src" / "flow" / "run.ts").read_text(
        encoding="utf-8")
    sql = (paths.repo_root() / "services" / "task_query.py").read_text(encoding="utf-8")

    for literal in ('state: "manual_verification"', 'state: "manual_verification_done"'):
        assert literal in run_ts, f"插件不再上报 {literal},列表那个徽标会永远不亮"
    assert "'manual_verification'" in sql
    assert "awaiting_manual_verification" in sql


@pytest.mark.parametrize("field", ["claim_timeout_min"])
def test_taskout_fields_exist_in_the_plugin_contract(field):
    """服务端加的字段,插件那份契约类型里要有对应的一条。

    这两份是同一个契约的两个副本(extension/src/core/types.ts 的文件头写着
    「这里是唯一的一份」)。厂商那套「文档写 subTotal、插件发 subtotal」
    就是没人盯的下场。
    """
    from registry import paths

    types_ts = (paths.repo_root() / "extension" / "src" / "core" / "types.ts").read_text(
        encoding="utf-8")
    assert field in types_ts
