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

#: 买家号浏览器里的 Amazon 登录态(procure.plugin_instances.login_state)。
#:
#: 「登录态存疑」这个词沿用 docs/03 §5 那一行 —— 它本来就是照厂商面板的说法记的。
#: **unknown 与 ok 必须是两个词**:读不到导航栏和读到了「已登录」是两件事,
#: 前者该让人去看一眼,后者不该。渲染成同一个词就是这个项目反复栽的那种缺陷。
LOGIN_STATE_LABELS: dict[str, str] = {
    "ok": "已登录",
    "signed_out": "已登出",
    "unknown": "登录态存疑",
}

#: 已登出用红:它是**真的坏了**,不重新登录就一单也派不出去,与「暂停」
#: (人主动停的,石板灰)和「存疑」(还没定论,虚线)都不是一回事。
LOGIN_STATE_TONE: dict[str, str] = {
    "ok": "solid-emerald",
    "signed_out": "solid-red",
    "unknown": "dashed-zinc",
}

#: 这一单是谁买的(procure.tasks.purchase_source)。
#:
#: 三种来源的处置完全不同,所以它们必须是三个词:
#:   · 插件下单 —— 走过我们全部护栏的那一批
#:   · 外部下单 —— 上游自己在别处买的,只把 AMZ 单号填进了那张表。**没有护栏结论**,
#:     `price_cap` 是个占位的 0;界面上那一档写「外部下单,不适用」,
#:     不许写「未超」(那是一句护栏从没做过的判断)
#:   · 人工回填 —— 有人在运营台按了「强制回填」,断言是被跳过的
PURCHASE_SOURCE_LABELS: dict[str, str] = {
    "plugin": "插件下单",
    "external": "外部下单",
    "manual_backfill": "人工回填",
}

#: 插件下单是常态,用最淡的一档(石板灰虚线),别让每一行都挂一个抢眼的标签 ——
#: 一个每行都出现的标签等于没有标签。另外两种是「这一单没走我们那条流」,
#: 各给一个看得见的颜色:外部单是上游的动作(天蓝,与「还在流转中」同族),
#: 人工回填是有人动过手(紫,与 admin 事件同色)。
PURCHASE_SOURCE_TONE: dict[str, str] = {
    "plugin": "dashed-zinc",
    "external": "dashed-sky",
    "manual_backfill": "solid-violet",
}

#: 这台机器登着的 Amazon 账号跟这个买家号对不对得上
#: (services/task_queue.account_state 现算出来的,**不是库里的一列**;
#:  services/instance 只是调用方 —— 照这条路标去 instance.py 找定义的人找不到函数,
#:  最可能的处置是在那边另写一份判据,而这一格已经因为「界面自己算一遍、
#:  算法跟真闸不一样」出过一次事,account_state 的 docstring 自己写着那次事故)。
#:
#: 与 LOGIN_STATE 是两条独立的轴:登录态答的是「还登着吗」,这一条答的是
#: 「登着的是不是**这个号**」。两台机器登错号是真会发生的事,而在此之前
#: 它在买家号页上渲染成满格绿色的「在线 · 可派」—— 与登录态那一列当初的毛病一模一样。
ACCOUNT_STATE_LABELS: dict[str, str] = {
    "ok": "买家号对得上",
    "mismatch": "登错号",
    # **「还没报过账号」与「还没比对过」是两档,拦不拦单完全不同。**
    #
    # unverified:买家号那一列**已经有值**,而这台机器从没报过它登着谁。
    # 派单被拦着(它是最容易登错号的那一刻 —— 新装 / 新 profile / 换了机器),
    # 但它不是「有问题」,而是「等它自己报一次」,所以这句话里必须有个「等」字。
    "unverified": "等账号报上来",
    # unknown:买家号那一列**也还是空的** —— 我们从来不知道这个号该登谁,
    # 没有任何东西可比。不拦单,也不是问题。
    "unknown": "还没比对过",
}

#: 登错号用红:它跟「已登出」是同一类 —— 不去处理就一单也派不出去,
#: 而且**处置方式不同**(那个是去重新登录,这个是去确认这台机器该登谁),
#: 所以不能跟它共用一句话。
ACCOUNT_STATE_TONE: dict[str, str] = {
    "ok": "solid-emerald",
    "mismatch": "solid-red",
    # 拦着单的那一档必须看得出来,但**不能跟「登错号」共用红色** ——
    # 两者的处置不同:那个要人去那台机器上换回正确的账号,这个通常什么都不用做,
    # 等插件下一轮登录探测把号报上来就自己好了。
    # 虚线琥珀正好说这件事(设计系统:中间态用虚线、终态用实心;琥珀 = 它此刻
    # 拦着这个买家号的全部派单)。给灰的话就跟不拦单的 unknown 长得一样了。
    "unverified": "dashed-amber",
    "unknown": "dashed-zinc",
}

#: 买家号那条事件流(procure.env_events.kind)的中文标签。封闭集在
#: services/instance.ENV_EVENT_KINDS —— 与 task_events 那一套分开,
#: 因为它们挂在不同的东西上,混进 EVENT_LABELS 会让任务时间线上冒出
#: 一种永远不会出现在那儿的事件类型。
ENV_EVENT_LABELS: dict[str, str] = {
    "customer_id_seen": "认出买家号ID",
    "customer_id_mismatch": "登错号",
    "customer_id_override": "人工改为准",
}

#: 运维体检那几个计数,界面上那一格叫什么。
#:
#: 与 EVENT_LABELS 分开而不是复用:时间线上那个点只有 76px 一列,标签必须短;
#: 而卡片标题得自己把话说完(「断言没采到」单独摆在错误码分布页上,
#: 没人知道是哪一步的哪道断言)。同一件事两处不同长度不是分叉 ——
#: 分叉是两处**各写一份**,这里两份都在这个文件里,改一处会看见另一处。
#:
#: 不进 `/v1/admin/meta`:只有错误码分布页那一处用它,随
#: `GET /v1/admin/error-stats` 的那个数一起下发就够了 ——
#: 单独塞进 meta 等于让每个前端页面都存一份没人用的表。
OPS_METRIC_LABELS: dict[str, str] = {
    "assert_skipped": "回填时 ASIN 断言没采到",
}

EVENT_LABELS: dict[str, str] = {
    "claimed": "认领",
    "step": "执行步骤",
    "guard_block": "护栏拦截",
    "error": "失败",
    "purchased": "下单成功",
    "released": "退回队列",
    "assert_failed": "断言不通过",
    "assert_skipped": "断言没采到",
    "admin": "人工操作",
    "auto_retry": "自动重试",
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
    # 与 assert_failed 同族的琥珀,但用实心:那一条是「结局不确定」,
    # 这一条是「已经确定地什么都没比到」—— 不确定的用空心,确定的用实心。
    "assert_skipped": "amber",
    "admin": "violet",
    # 紫色在这套界面里表示「有人动了手 / 需要人裁决」。自动重试是机器干的,
    # 用天蓝(与「还在流转中」同一族),免得运营在时间线上把它读成有人来过。
    "auto_retry": "sky",
    "shipment": "sky",
}
