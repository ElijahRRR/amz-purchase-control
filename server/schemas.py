"""插件 ↔ 服务端契约的**唯一**定义处。

任何字段增删只改这里,不在路由里另写一份 —— 厂商那套「文档写 subTotal、
插件发 subtotal」的字段错位就是靠多处副本产生的。
"""

from datetime import date
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field

# ── 通用信封 ────────────────────────────────────────────────────────────


class ErrorBody(BaseModel):
    code: str
    message: str


class Envelope(BaseModel):
    ok: bool
    data: Any | None = None
    error: ErrorBody | None = None


# ── 实例 ────────────────────────────────────────────────────────────────


class RegisterReq(BaseModel):
    env_code: str = Field(..., description="买家号环境名,如 env-172")
    instance_uid: str = Field(..., description="插件首次启动生成并持久化")
    plugin_version: str | None = None


class HeartbeatReq(BaseModel):
    instance_uid: str


# ── 认领 ────────────────────────────────────────────────────────────────


class ClaimReq(BaseModel):
    instance_uid: str


class ProductOut(BaseModel):
    asin: str
    quantity: int


class ShippingOut(BaseModel):
    name: str
    phone: str
    line1: str
    city: str
    state: str
    postcode: str
    country: str


class GuardsOut(BaseModel):
    price_cap: Decimal
    max_delivery_days: int
    require_fba: bool = True


class TaskOut(BaseModel):
    task_id: int
    marketplace: str
    shipping: ShippingOut
    products: list[ProductOut]
    guards: GuardsOut


# ── 执行期上报 ──────────────────────────────────────────────────────────


class EventIn(BaseModel):
    kind: Literal["step", "guard_block", "error", "assert_failed"]
    code: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class EventsReq(BaseModel):
    instance_uid: str
    events: list[EventIn]


class LineItemIn(BaseModel):
    asin: str
    unit_price: Decimal
    quantity: int


class GuardCheckReq(BaseModel):
    instance_uid: str
    actual_total: Decimal
    actual_shipping: Decimal | None = None
    actual_tax: Decimal | None = None
    line_items: list[LineItemIn] = Field(default_factory=list)
    delivery_raw: str | None = None
    #: 结算页每个商品面板各有一条交期文案。全都报上来,由服务端解析并取最晚的一条
    #: —— 挑哪条算数是护栏的一部分,不该让插件自己决定。
    delivery_raws: list[str] = Field(default_factory=list)
    is_fba: bool | None = None


class GuardCheckOut(BaseModel):
    allow: bool
    error_code: str | None = None
    detail: str | None = None
    delivery_date: str | None = None
    #: 服务端最终采信的那条原文。插件回填时原样带回,别自己另挑一条。
    delivery_raw_used: str | None = None


class CompleteReq(BaseModel):
    instance_uid: str
    amazon_order_no: str
    actual_total: Decimal | None = None
    actual_shipping: Decimal | None = None
    actual_tax: Decimal | None = None
    payment_last4: str | None = None
    delivery_raw: str | None = None
    # 订单历史卡片上解析出的 ASIN。插件本来就要解析商品链接,顺手带上做断言,
    # 不多一次页面加载。与本单 ASIN 不符则拒绝回填并转人工。
    observed_asins: list[str] = Field(default_factory=list)
    # 结算页读到的实测单价。落进 task_products.actual_unit_price ——
    # 「上游给的限价」与「实际每件多少钱」是两个数,后者才是对账要看的。
    line_items: list[LineItemIn] = Field(default_factory=list)


class FailReq(BaseModel):
    instance_uid: str
    error_code: str
    detail: str | None = None
    to_manual: bool = False
    cart_cleared: bool = Field(
        False, description="是否已清空购物车。失败必清车,否则残留商品会污染下一单"
    )


class ReleaseReq(BaseModel):
    instance_uid: str


# ── 物流 ────────────────────────────────────────────────────────────────


class ShipmentEventIn(BaseModel):
    raw_day: str | None = None
    raw_time: str | None = None
    description: str | None = None
    city: str | None = None
    state_code: str | None = None


class ShipmentPendingReq(BaseModel):
    instance_uid: str
    limit: int | None = None


class PendingShipmentOut(BaseModel):
    task_id: int
    amazon_order_no: str
    upstream_order_no: str
    tracking_url: str | None = None


class ShipmentSyncReq(BaseModel):
    instance_uid: str
    task_id: int
    #: 订单详情页看到的订单本身的状态(报告 §4.3 第 3 步):
    #:   ok        正常
    #:   cancelled 页面提示 cancelled / refund
    #:   not_found 页面提示 unable to load your order details ——
    #:             这说明我们回填的那个单号可能根本不属于这个买家号
    order_state: Literal["ok", "cancelled", "not_found"] = "ok"
    carrier: str | None = None
    tracking_no: str | None = None
    tracking_url: str | None = None
    status: Literal["not_shipped", "in_transit", "delivered", "cancelled"] | None = None
    events: list[ShipmentEventIn] = Field(default_factory=list)


# ── 后台(运营台)────────────────────────────────────────────────────────
#
# 后台与插件用同一套契约定义。不做鉴权(所有者定稿),服务默认只监听本机。


class TaskSearchReq(BaseModel):
    status: str | None = None
    env_code: str | None = None
    #: created = 创建时间(单子什么时候下发到我们这儿);purchased = 采购时间(什么时候真买的)
    date_field: Literal["created", "purchased"] = "created"
    date_from: date | None = None
    date_to: date | None = None
    #: 粘一沓单号进来,每行一个。上游号与 AMZ 号可以混着粘,服务端自动分流。
    #: 一旦非空就**盖过**状态桶与时间范围 —— 按号找单的人是来找特定几张单的。
    order_numbers: list[str] = Field(default_factory=list)
    asin: str | None = None
    page: int = 1
    page_size: int = 50


class ResetReq(BaseModel):
    #: 错误码属于「可能已经真下了单」那一类时必须为 True ——
    #: 它是「我已经去买家号里确认过没有这一单」的回执。
    acknowledged: bool = False
    operator: str | None = None


class ForceBackfillReq(BaseModel):
    amazon_order_no: str
    #: 必填。事后追责时「当时为什么敢写」必须留在库里。
    note: str
    operator: str | None = None


class AddressReq(BaseModel):
    ship_name: str | None = None
    ship_phone: str | None = None
    ship_line1: str | None = None
    ship_city: str | None = None
    ship_state: str | None = None
    ship_postcode: str | None = None
    operator: str | None = None


class BatchResetReq(BaseModel):
    """批量重置。**故意没有 acknowledged 字段** ——

    单条那道 NEEDS_ACK 闸拦的是「这一单可能已经真下成了」,回执的含义是
    有人去那个买家号的订单页看过了。一批 30 单给一个总的「已确认」,
    那句话就是假的。真让它接受,这个按钮就从「省点击」变成「一键重复下单 30 次」。
    """

    task_ids: list[int] = Field(min_length=1, max_length=200)
    operator: str | None = None


class AsinReq(BaseModel):
    old_asin: str
    new_asin: str
    operator: str | None = None


class IntakeProduct(BaseModel):
    asin: str
    quantity: int
    image_url: str | None = None


class IntakeRow(BaseModel):
    upstream_order_no: str
    buyer_env_code: str
    marketplace: str = "US"
    ship_name: str
    ship_phone: str
    ship_line1: str
    ship_city: str
    ship_state: str
    ship_postcode: str
    ship_country: str = "US"
    #: 上游 ERP 算好下发,本系统只取用不计算
    price_cap: Decimal
    max_delivery_days: int = 7
    products: list[IntakeProduct]


class IntakeReq(BaseModel):
    rows: list[IntakeRow]
    #: True = 直接落成 ready(可被认领);默认落成 pending(等放行)
    release: bool = False
