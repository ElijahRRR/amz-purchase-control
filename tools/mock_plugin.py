#!/usr/bin/env python3
"""模拟插件:不碰 Amazon,只跑 HTTP 闭环。

P1 的验收工具 —— 用它确认服务端的状态流转、护栏裁决、事件流都对,
再去写真插件。真插件的执行时序与这里一致,区别只是每一步换成真实 DOM 操作。

    python tools/mock_plugin.py --env env-172 --scenario happy
    python tools/mock_plugin.py --env env-172 --scenario over_cap
    python tools/mock_plugin.py --env env-172 --scenario oos
    python tools/mock_plugin.py --env env-172 --scenario wrong_asin
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from registry import settings  # noqa: E402

UID = "mock-plugin-001"


def call(base: str, path: str, body: dict) -> tuple[int, dict]:
    """输入:服务地址 + 路径 + 请求体 → 输出:(状态码, 响应 JSON)。"""
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def log(step: str, detail=""):
    print(f"  {step:<28} {detail}")


def run(base: str, env_code: str, scenario: str) -> int:
    print(f"\n=== 场景:{scenario} ===")

    status, r = call(base, "/v1/instances/register",
                     {"env_code": env_code, "instance_uid": UID, "plugin_version": "mock"})
    if not r.get("ok"):
        print(f"  ✗ 注册失败:{r.get('error')}")
        return 1
    log("注册", f"instance_id={r['data']['instance_id']}")

    call(base, "/v1/instances/heartbeat", {"instance_uid": UID})
    log("心跳", "ok")

    _, r = call(base, "/v1/tasks/claim", {"instance_uid": UID})
    task = r.get("data")
    if task is None:
        log("认领", "无可派任务")
        return 0
    tid = task["task_id"]
    log("认领", f"task_id={tid} asins={[p['asin'] for p in task['products']]} "
               f"限价={task['guards']['price_cap']}")

    call(base, f"/v1/tasks/{tid}/events", {
        "instance_uid": UID,
        "events": [{"kind": "step", "payload": {"step": "cart_cleared"}},
                   {"kind": "step", "payload": {"step": "added_to_cart"}}],
    })
    log("上报执行步骤", "清车 + 加购")

    if scenario == "oos":
        _, r = call(base, f"/v1/tasks/{tid}/fail", {
            "instance_uid": UID, "error_code": "OUT_OF_STOCK",
            "detail": "商品页显示 Currently unavailable", "cart_cleared": True})
        log("上报失败", f"OUT_OF_STOCK → {r['data']['status']}")
        return 0

    total = "99.00" if scenario == "over_cap" else "10.79"
    _, r = call(base, f"/v1/tasks/{tid}/guard-check", {
        "instance_uid": UID, "actual_total": total,
        "actual_tax": "0.80", "delivery_raw": "Thursday, August 27", "is_fba": True,
        "line_items": [{"asin": p["asin"], "unit_price": "9.99", "quantity": p["quantity"]}
                       for p in task["products"]],
    })
    v = r["data"]
    log("护栏裁决", f"实付={total} allow={v['allow']} "
                  f"{v.get('error_code') or ''} eta={v.get('delivery_date')}")

    if not v["allow"]:
        _, r = call(base, f"/v1/tasks/{tid}/fail", {
            "instance_uid": UID, "error_code": v["error_code"],
            "detail": v["detail"], "to_manual": True, "cart_cleared": True})
        log("被拦截 → 清车上报", f"{r['data']['status']}")
        return 0

    observed = ["B0WRONGASIN"] if scenario == "wrong_asin" \
        else [p["asin"] for p in task["products"]]
    status, r = call(base, f"/v1/tasks/{tid}/complete", {
        "instance_uid": UID, "amazon_order_no": f"111-{tid:07d}-0000001",
        "actual_total": total, "actual_tax": "0.80", "payment_last4": "7883",
        "delivery_raw": "Thursday, August 27", "observed_asins": observed,
    })
    if not r.get("ok"):
        log("回填被拒", f"{r['error']['code']}: {r['error']['message']}")
        return 0
    log("回填完成", f"status={r['data']['status']}")

    _, r = call(base, "/v1/shipments/sync", {
        "instance_uid": UID, "task_id": tid, "carrier": "UPS",
        "tracking_no": "1Z999AA10123456784", "status": "in_transit",
        "events": [{"raw_day": "August 28, 2026", "raw_time": "8:42 AM",
                    "description": "Arrived at carrier facility",
                    "city": "Los Angeles", "state_code": "CA"}],
    })
    log("物流回传", f"shipment_id={r['data']['shipment_id']} events={r['data']['events']}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="模拟插件(不碰 Amazon)")
    # 默认跟着 AMZ_SERVER_HOST / AMZ_SERVER_PORT 走,而不是写死 8781。
    #
    # 写死的后果不是「连不上」——那还好办,报个错就完了。是**连上了另一台**:
    # 同一机器上跑着演示库和排练库时,你以为在对排练库跑闭环,
    # 其实把演示库里的单拍掉了,而两边都不会有任何异常。
    ap.add_argument("--base",
                    default=f"http://{settings.server_host()}:{settings.server_port()}",
                    help="服务端地址(默认取 AMZ_SERVER_HOST/AMZ_SERVER_PORT)")
    ap.add_argument("--env", default="env-172")
    ap.add_argument("--scenario", default="happy",
                    choices=["happy", "over_cap", "oos", "wrong_asin"])
    args = ap.parse_args()
    return run(args.base, args.env, args.scenario)


if __name__ == "__main__":
    sys.exit(main())
