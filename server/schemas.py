"""插件 ↔ 服务端契约的**唯一**定义处。

任何字段增删只改这里,不在路由里另写一份 —— 厂商那套「文档写 subTotal、
插件发 subtotal」的字段错位就是靠多处副本产生的。
"""

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


class ShipmentSyncReq(BaseModel):
    instance_uid: str
    task_id: int
    carrier: str | None = None
    tracking_no: str | None = None
    tracking_url: str | None = None
    status: Literal["not_shipped", "in_transit", "delivered", "cancelled"] | None = None
    events: list[ShipmentEventIn] = Field(default_factory=list)
