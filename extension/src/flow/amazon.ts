/** 真实 Amazon 页面驱动 —— P3 的活,现在每一步都还是空的。
 *
 * `ready = false`,上层因此拒绝在 live 档认领任务:与其领了单再报
 * PLUGIN_INTERNAL 把它打进异常桶,不如根本不领。
 *
 * P3 落地时的参考在 docs 里:厂商插件每一步用的选择器、等待策略和它踩过的坑
 * 都记在 `AMZ-Purchase-Assistant/docs/插件功能深度分析.md` §4.2 / §4.3。
 * 那些选择器可以抄,那些坑不要抄 —— 尤其是:
 *   - 轮询里 resolve 后不 cleanup,setInterval 泄漏到标签页关闭(§4.3)
 *   - postalCodeInfo 为 null 时直接 .match(),异常冒泡中止整批(§4.3)
 *   - carrier 取页面文本 split(" ")[2] 盲取第 3 个词(§4.3)
 */

import { NotImplemented, type CheckoutReading, type OrderCard, type PageDriver, type ProductPage } from "./driver.js";
import type { Shipping } from "../core/types.js";

export class AmazonDriver implements PageDriver {
  readonly name = "amazon";
  readonly ready = false;

  async clearCart(): Promise<void> { throw new NotImplemented("清空购物车"); }
  async openProduct(_asin: string): Promise<ProductPage> { throw new NotImplemented("打开商品页"); }
  async addToCart(_asin: string, _quantity: number): Promise<void> { throw new NotImplemented("加购"); }
  async verifyCart(_expected: Array<{ asin: string; quantity: number }>): Promise<boolean> { throw new NotImplemented("回读购物车"); }
  async fillAddress(_shipping: Shipping): Promise<void> { throw new NotImplemented("填写收货地址"); }
  async readCheckout(): Promise<CheckoutReading> { throw new NotImplemented("读结算页"); }
  async placeOrder(): Promise<void> { throw new NotImplemented("下单"); }
  async readOrderCard(): Promise<OrderCard> { throw new NotImplemented("读订单卡"); }
}
