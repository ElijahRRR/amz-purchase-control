"""「下单前人工确认」这件事在**服务端这一侧**要成立的几样。

插件那边的弹窗、倒计时、两个按钮验不了(没有浏览器),它们由
`extension/test/unit.test.mjs` 与 `node tools/smoke.mjs --scenario confirm_*` 盯着。
这里盯的是那条链跨到服务端的三个接口面:

  1. 认领响应里要有 `upstream_order_no` —— 确认屏上那个**给人看的号**。
     没有它,操作员在屏幕上看到的只有 task_id(我们库里的自增数),
     去上游系统里搜不到,这一屏就退化成一个写着「确定?」的按钮。
  2. 三种结局写的那几个 `payload.state`,运营台要认得出来并且**渲染成三句
     不同的中文**。认不出来的键会原样铺开成 `state=confirm_timeout` ——
     一个英文枚举出现在一套只出中文的界面上;而取消与超时渲染成同一句话的话,
     一台没人守的机器会看起来像「一直有人在按取消」。
  3. 「先写事件流,再 /release」这条顺序是**硬要求**:release 之后任务不再归本
     实例持有,/events 会被 TASK_NOT_HELD 拒掉,那条 step 就永远写不进去 ——
     运营台上这一单看起来会是「领走了又回来了,什么也没说」。
"""

import re

import pytest

from registry import paths
from server import schemas

UID = "inst-confirm-A"


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


def _step(client, task_id, payload):
    return client.post(f"/v1/tasks/{task_id}/events",
                       json={"instance_uid": UID,
                             "events": [{"kind": "step", "payload": payload}]})


# ── 1. 确认屏上那个给人看的号 ──────────────────────────────────────────

def test_claim_hands_the_plugin_the_number_a_human_can_look_up(client, seed):
    """认领响应要带上游单号。

    确认屏要让操作员**独立**回答「这一单该不该现在买」,而不是「插件说没问题
    那就按吧」。task_id 是我们库里的自增数,上游那边搜不到它 ——
    屏幕上只有它的话,人能核对的东西就只剩「金额看起来不离谱」。
    """
    _register(client)
    task = _claim(client)
    assert task["upstream_order_no"] == "UP-0", task


def test_the_upstream_order_no_exists_in_both_halves_of_the_contract():
    """服务端下发的字段,插件那份契约类型里要有对应的一条。

    这两份是同一个契约的两个副本(`extension/src/core/types.ts` 的文件头写着
    「这里是唯一的一份」)。厂商那套「文档写 subTotal、插件发 subtotal」的字段
    错位就是靠多处副本产生的。

    **服务端这一半问的是对象,不是源码文本。** 原先它断言
    `"upstream_order_no: str" in schemas.py 全文` —— 而这个字面量在那个文件里
    出现三次(TaskOut / PendingShipmentOut / IntakeRow),盯的于是是「某处有」,
    不是「TaskOut 里有」:把 TaskOut 那一行删掉,这条自称守着契约的测试照样绿
    (实测只有上面那条行为测试会红)。一条守不住自己那半边的契约测试,
    比没有更危险 —— 它会让下一个人以为这里有人盯着。
    """
    field = schemas.TaskOut.model_fields.get("upstream_order_no")
    assert field is not None, "TaskOut 里没有 upstream_order_no,认领响应不会下发它"
    assert field.is_required(), (
        "这一项在服务端侧是必填的:可选意味着某些认领响应里没有它,"
        "而确认屏那一行会在**没人说得清是哪些单**的时候变成「服务端未下发」")
    types_ts = (paths.repo_root() / "extension" / "src" / "core" / "types.ts").read_text(
        encoding="utf-8")
    # 插件那半边只有源码可问(TS 类型不进运行时)。收窄到 `interface Task` 的类体上,
    # 免得将来别处多出一个同名字段就把这条断言喂饱了 —— 与上面服务端那半同一个道理。
    task_iface = re.search(r"export interface Task \{(.*?)\n\}", types_ts, re.S)
    assert task_iface, "types.ts 里找不到 interface Task"
    assert "upstream_order_no?: string" in task_iface.group(1), (
        "插件那份 Task 里没有这一项,确认屏上那一行会永远是「服务端未下发」")


# ── 2. 三种结局在运营台上是三句不同的中文 ──────────────────────────────

#: 「下单前确认」那一格的四个 `payload.state`。**这里只列状态名,不抄一份中文**
#: —— 抄一份的话,运营台上那几句话改了而这里没改,这个列表就是一份写下来就
#: 不成立的注释(项目把这类注释列为「比不写更危险」)。中文长什么样由下面
#: 那两条断言按规则判,不按字面量对。
CONFIRM_STATES = (
    "awaiting_confirm",
    "confirm_approved",
    "confirm_cancelled",
    "confirm_timeout",
)


def _payload_state_labels() -> dict[str, str]:
    """读运营台那张渲染表 → {state: 中文标签}。"""
    detail_tsx = (paths.repo_root() / "web" / "src" / "components" / "TaskDetail.tsx").read_text(
        encoding="utf-8")
    labels = {}
    for state in CONFIRM_STATES:
        line = next(ln for ln in detail_tsx.splitlines() if ln.strip().startswith(state + ":"))
        labels[state] = line.split(":", 1)[1].strip().rstrip(",").strip('"')
    return labels


@pytest.mark.parametrize("state", sorted(CONFIRM_STATES))
def test_the_plugin_writes_the_state_the_console_renders(state):
    """插件写的 `payload.state` 与运营台那张渲染表是**跨文件的字面量**。

    任何一边改了字面量,事件流里那一行就会退回成 `state=confirm_timeout` ——
    一个英文枚举出现在一套只出中文的界面上(CLAUDE.md:界面只出中文)。
    """
    run_ts = (paths.repo_root() / "extension" / "src" / "flow" / "run.ts").read_text(
        encoding="utf-8")
    detail_tsx = (paths.repo_root() / "web" / "src" / "components" / "TaskDetail.tsx").read_text(
        encoding="utf-8")
    assert f'state: "{state}"' in run_ts, f"插件不再上报 {state}"
    assert f"{state}:" in detail_tsx, f"运营台认不出 {state},会原样铺开成英文"


def test_cancelled_and_timed_out_do_not_render_as_the_same_thing():
    """取消与超时**不许渲染成同一句话**。

    两条路的结局一样(清车 + 退回队列,一分钱没花),但它们说的事完全相反:
    一个是「有人看了一眼,决定不买」,一个是「**没有人在看这台机器**」。
    合成一句的话,一台没人守的机器会一直产出「有人按了取消」,
    看的人会以为有人在把关 —— 这正是本项目反复记的那种假象。
    """
    labels = _payload_state_labels()
    assert labels["confirm_cancelled"] != labels["confirm_timeout"], labels


def test_the_state_label_is_not_a_second_copy_of_the_step_text():
    """`state` 那句中文**不许与同一条事件的 `step` 文案逐字相同**。

    运营台把一条事件铺成「step · 其余键」,state 就在其余键里(TaskDetail.eventLine)。
    两边一字不差的话,同一行会把同一句中文说两遍
    (「人按了下单,继续 · 人按了下单,继续」),读的人第一反应是界面出了 bug。
    分工是:step 说**发生了什么**,state 说**这一格是什么**。

    判法:那句标签不许在 run.ts 里原样出现(step 文案都是 run.ts 里的字面量)。
    **说清这条盯不住什么**:超时那条 step 是模板串
    (`等人确认超时 ${waitedS} 秒,退回队列`),标签若只与它的某一段相同,
    这里判不出来 —— 那一段由人眼和上面那条「取消 ≠ 超时」兜着。
    """
    run_ts = (paths.repo_root() / "extension" / "src" / "flow" / "run.ts").read_text(
        encoding="utf-8")
    for state, label in _payload_state_labels().items():
        assert label not in run_ts, (
            f"{state} 的标签「{label}」与插件写的 step 文案逐字相同,"
            f"运营台会把同一句话说两遍")


def test_every_machine_value_the_plugin_writes_gets_translated():
    """确认那几条事件里的**机器值键**,运营台的 fmtPayload 都要认得。

    认不出的键会落到最后那行 `${k}=${String(v)}`,在一套只出中文的界面上铺成
    `waited_ms=142731` —— 一个英文键加一串毫秒。fmtPayload 存在的全部理由就是
    不让这种东西上界面,而它漏掉一个新键的时候没有任何地方会喊。

    键从 run.ts 的确认那一段里**扫出来**,不是在这里手抄一份:手抄的话,
    插件下次多写一个键,这条测试不会知道(那正是它要防的那件事)。
    约定:载荷键一律 snake_case,TS 里的局部变量是 camelCase,所以按下划线筛。
    """
    run_ts = (paths.repo_root() / "extension" / "src" / "flow" / "run.ts").read_text(
        encoding="utf-8")
    start = run_ts.index("if (deps.confirmBeforeOrder === true && deps.askConfirm) {")
    end = run_ts.index("// **先说,再点", start)
    section = re.sub(r"//[^\n]*", "", run_ts[start:end])      # 注释里的键名不算数
    keys = sorted(set(re.findall(r"\b([a-z]+(?:_[a-z]+)+)\s*:", section)))
    assert keys, "确认那一段里一个载荷键都没扫到,这条测试自己坏了"

    detail_tsx = (paths.repo_root() / "web" / "src" / "components" / "TaskDetail.tsx").read_text(
        encoding="utf-8")
    fmt = detail_tsx[detail_tsx.index("function fmtPayload("):]
    for key in keys:
        assert f'k === "{key}"' in fmt, (
            f"运营台的 fmtPayload 不认得 {key},事件流里会原样铺成 {key}=<机器值>")


# ── 3. 先写事件流,再 /release ─────────────────────────────────────────

def test_the_confirm_steps_go_through_and_release_puts_it_back(client, seed):
    """三条确认相关的 step 走得通 /events,release 之后这一单回到 ready。

    落到库里的顺序就是插件里写的那个顺序:先写留痕,再退回队列。
    """
    _register(client)
    task = _claim(client)
    tid = task["task_id"]
    assert _step(client, tid, {"step": "等待人工确认下单", "state": "awaiting_confirm",
                               "deadline_ms": 1_757_183_940_000, "wait_ms": 180_000,
                               "capped_by": "confirm_wait"}).status_code == 200
    assert _step(client, tid, {"step": "等人确认超时 180 秒,退回队列",
                               "state": "confirm_timeout", "wait_ms": 180_000,
                               "capped_by": "confirm_wait"}).status_code == 200
    r = client.post(f"/v1/tasks/{tid}/release", json={"instance_uid": UID})
    assert r.status_code == 200, r.text

    detail = client.get(f"/v1/admin/tasks/{tid}").json()["data"]
    assert detail["status"] == "ready", "一分钱没花,这一单该回到队列里"
    states = [e["payload"].get("state") for e in detail["events"]]
    assert "confirm_timeout" in states
    # 这一单**没有**越过下单点:那道闸不该被这条路点亮。
    assert detail["may_have_ordered"] is False


def test_writing_the_step_after_release_is_too_late(client, seed):
    """release 之后再写那条 step 就写不进去了 —— 所以插件里的顺序是硬要求。

    顺序反过来的话,运营台上这一单看起来会是「领走了又回来了,什么也没说」:
    「有人按了取消」与「没人来按」这两件事一条都留不下来。
    """
    _register(client)
    task = _claim(client)
    tid = task["task_id"]
    assert client.post(f"/v1/tasks/{tid}/release",
                       json={"instance_uid": UID}).status_code == 200
    late = _step(client, tid, {"step": "人按了取消,退回队列", "state": "confirm_cancelled"})
    assert late.status_code != 200, "release 之后还写得进去的话,上面那条顺序就不是硬要求了"
    assert late.json()["error"]["code"] == "TASK_NOT_HELD", late.text
