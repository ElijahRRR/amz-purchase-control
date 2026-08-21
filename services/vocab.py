"""界面词汇的唯一来源:任务状态、物流状态、事件类型的中文标签。

错误码的标签在 services/error_codes.py(那张表的可执行镜像)。这里只补它没有的。

**为什么要有这个模块**:标签之前有两份副本(docs/01 §4 的表、插件的 core/codes.ts),
再给前端抄第三份,就是在等它们分叉 —— 这个项目已经因为「两份副本」栽过两次
(厂商的 subTotal/subtotal;我们自己的 docs/01 目录树)。
现在服务端把封闭集连标签一起吐给前端(`GET /v1/admin/meta`),前端不存副本。

插件那一份留着,因为它必须离线可用(断网时面板还要显示状态),
但它的值必须与这里一致 —— 有测试盯着。

**这句话曾经是假的。** 2026-08-21 之前,那条测试只比对码名、TO_MANUAL、
RETRYABLE 三样,`ERROR_LABEL` 一个字都没比 —— 而 19 个标签里已经悄悄分叉了 10 个
(「结算页跳转超时」/「结算页超时」、「无法确定哪个单号属于本单」/「单号对不上」……)。
运营在插件面板和运营台上看到的是两套说法,同一个错误看着像两件事。

**一条注释声称有测试盯着,而实际没有,比根本不写这句话更危险** ——
后来的人会照着这句话放心地在一边改。现在标签也进了那条测试。
"""

#: 任务状态。词沿用厂商面板的说法,便于运营迁移(docs/03 §3.9)。
STATUS_LABELS: dict[str, str] = {
    "pending": "待放行",
    "ready": "待拍单",
    "claimed": "拍单中",
    "purchased": "已拍单",
    "exception": "拍单异常",
    "manual": "待人工",
    "cancelled": "已取消",
}

#: 中间态用虚线边框,终态用实心底色 —— 一眼分出「还在动」与「已经定了」。
STATUS_TONE: dict[str, str] = {
    "pending": "dashed-zinc",
    "ready": "dashed-sky",
    "claimed": "dashed-amber",
    "purchased": "solid-emerald",
    "exception": "solid-red",
    "manual": "solid-violet",
    "cancelled": "solid-zinc",
}

SHIPMENT_LABELS: dict[str, str] = {
    "not_shipped": "未发货",
    "in_transit": "运输中",
    "delivered": "已签收",
    "cancelled": "已取消",
}

#: 在途是天蓝,不是红。厂商面板把「运输中」渲染成红标签 ——
#: 红色一旦用来表示正常在途,真出事时就没有颜色可用了。
SHIPMENT_TONE: dict[str, str] = {
    "not_shipped": "dashed-zinc",
    "in_transit": "dashed-sky",
    "delivered": "solid-emerald",
    "cancelled": "solid-zinc",
}

EVENT_LABELS: dict[str, str] = {
    "claimed": "认领",
    "step": "执行步骤",
    "guard_block": "护栏拦截",
    "error": "失败",
    "purchased": "下单成功",
    "released": "退回队列",
    "assert_failed": "断言不通过",
    "admin": "人工操作",
    "shipment": "物流同步",
}

#: 事件时间线上那个点的颜色。
#: 「结局不确定」用琥珀空心(assert_failed),与已经落定的实心点区分开 ——
#: 这两种的处置方式相反。
EVENT_TONE: dict[str, str] = {
    "claimed": "sky",
    "step": "zinc",
    "guard_block": "violet",
    "error": "red",
    "purchased": "emerald",
    "released": "zinc",
    "assert_failed": "amber-hollow",
    "admin": "violet",
    "shipment": "sky",
}
