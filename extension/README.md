# extension —— Chrome MV3 插件

服务端派单，插件在**操作员自己的浏览器环境里**执行。这一层是 P2：
和服务端说话的时序全部跑通并可自检；真实页面动作（P3）还是空的。

## 现在能跑的 / 还不能跑的

| | 状态 |
|---|---|
| 注册 / 心跳 / 认领 / 事件上报 / 护栏裁决 / 回填 / 失败 / 释放 | ✅ 通了，六个场景实跑验过 |
| 执行时序（清车 → 加购 → 核对 → 填地址 → 读结算页 → 护栏 → 下单 → 回填断言） | ✅ 通了 |
| 面板（相位、任务卡、步骤、日志、点击复制） | ✅ |
| 物流同步（订单详情页 → 跟踪页 → 回传轨迹） | ✅ 独立一条流，跑在 purchased 之后 |
| 真实 Amazon 页面动作（P3） | ⚠️ 写完了，解析层对着 DOM 夹具全绿；**但没在真实 Amazon 上跑过** |

## 三档运行模式

`mode` 决定这台机器干什么，默认 **off**：

- **off**（默认）：只注册与心跳，不认领。骨架阶段不该自己去动真单。
- **simulate**：认领并跑完整流程，但页面动作走 `SimulatedDriver`，返回固定值。
  用来自检"和服务端说话的时序"，**不会在 Amazon 上产生任何订单**。
- **live**：在真实页面上执行。`AmazonDriver` 已实现，但**从未在真实 Amazon 上跑过**
  —— 这里没有可登录的买家号。第一次开 live 之前请先在一个可弃的买家号上手动跑一单。

## 装进浏览器

```bash
npm install
npm run build          # → dist/{manifest.json,background.js,content.js}
```

Chrome → 扩展程序 → 开发者模式 → 加载已解压的扩展程序 → 选 `dist/`。
打开任意 amazon.com 页面，右侧出现面板。在面板底部填买家号（如 `env-172`）保存。

服务端要先起着：

```bash
python -m uvicorn server.app:app --host 127.0.0.1 --port 8781
```

## 解析层离线验证

真实 Amazon 页面拿不到，所以 DOM 解析对着 `test/fixtures/` 里按逆向报告造的页面跑：

```bash
npm run test:dom     # DOM 断言,跑完顺带把 test:unit 也跑了
npm run test:unit    # 纯 Node 断言:等待原语 / 单飞闸 / 串行闸 / 执行租约 / 认领循环
```

(这两处不写「一共几条」:那个数字每加一条断言就过期一次,而它写在文档里的
唯一用处是让人对着实跑结果核对 —— 跑一次就知道,不必先信文档。
与 `codes.ts` 不写「一共几个错误码」是同一条理由。)

`test:unit` 里那几条盯的是**没有 DOM 也照样会出事**的几件东西:
`waitFor` 在探针每轮抛错时必须按时超时(厂商 2.4.1 在这一场景下永远不 settle)、
`waitStable` 在探针抛错的那一轮必须把「连续 N 次」的计数**打断**
(否则序列 A、A、<抛错>、A 会被当成「连续三次稳定」,把一段读不到的空档跨过去)、
以及租约在「持有者过期了但正跑着单」时不许换手。
后来又补进去几件同型的:长单期间租约必须一直续得上(续租在闸外面)、
SW 那段「读租约 → 裁决 → 写租约」并发时只许一个标签页拿到租约、
硬顶从认领那一刻起算、看门狗掐掉的那一单等它也有界、
清车熔断的「连续」中间成功一单要清零。
它们跑的是 `build/` 里的**真实编译产物**,不是另抄一份逻辑。

这一套里有一节不是纯解析:**执行中掉线那条兜底**。它用 route 拦截给 `/ap/signin`
真发一顶 `X-Frame-Options: DENY` 的帽子,把 iframe 导过去,再让 `guardLogin` 去判 ——
那是这条兜底的头号场景,而它只有在真有一个 iframe 的浏览器页面里才走得到
(Node 里没有 document,`npm run smoke` 走的是模拟驱动)。

### 夹具清单

每一张夹具的文件头里都写着：页面是什么、事实出处（报告 §x.x 或厂商 v2.5.3 的行号）、
以及**它刻意摆了哪些干扰项、写松了会怎样**。新增夹具时照这个格式写。

| 夹具 | 页面 | 主要盯的东西 |
|---|---|---|
| `nav-signed-in.html` / `nav-signed-out.html` | 导航栏 | 登录态三档；隐藏的反向模板 |
| `product.html` / `product-oos.html` | 商品页 | 数量下拉、优惠券、库存；**disabled 的加购按钮副本** |
| `cart.html` / `cart-empty.html` | 购物车 | 只数 Active Items；「空车」「没渲染」「读不懂这一页」三者分开；**只靠 CSS 类隐藏的空车提示模板 / 行模板** |
| `cart-icon-delete.html` | 购物车 | **删除控件的三种图标形态**（厂商 v2.5.3:687-703） |
| `checkout.html` | 结算页 | 金额、卡尾号、下单按钮、地址面板；折叠地址簿干扰项 |
| `checkout-apex-price.html` | 结算页 | 划线原价与实付价挂同一个类名 |
| `checkout-thirdparty.html` | 结算页 | FBA 看的是谁发货，不是谁卖 |
| `checkout-interstitial.html` | 中间页 | 会骗人的 `#submitOrderButtonId` |
| `address-select.html` | 地址选择页 | **这一页没有姓名框**；同 id 入口三份，三种隐藏机制 |
| `address-form-async.html` | 异步地址表单 | 预填着**别人地址**的隐藏模板副本；保存后三种结果 |
| `order-history.html` / `-empty.html` | 订单历史 | 订单号形态校验；空列表不算一张卡 |
| `order-details*.html` | 订单详情 | 取消的**两种渲染形态**、卡尾号两种形态、跟踪链接三种入口 |
| `tracking*.html` | 跟踪页 | 运单号三种形态、承运商、轨迹分组、「暂时给不了」 |

夹具里塞满了干扰项——隐藏的同 id 副本、Saved for later、推荐位、`<template>` 模板节点、
支付文案里先出现的另一个 4 位数。选择器写松了会当场被抓住。实际抓到过两个：

- `#quantity` 在页面上有隐藏副本，`querySelector` 取第一个就可能取到只有 2 个选项的那个
- `.order-card__list` 被报告记作 `.js-order-card` 的退化选择器，但它其实是**列表容器**。
  一张订单都没有时，隐藏模板里的空容器会被当成一张卡，于是"没有订单"变成
  "有一张读不出号的订单"
- **FBA 判定看错了对象**：原来的正则把 `Sold by` 也收进判据，遇到
  「Sold by Amazon.com / Ships from ThirdParty Seller」这种排版会把第三方单判成 FBA。
  FBA 的定义是由 Amazon **履约**，看的是谁发货
- **地址那一整节曾经是 0 条断言**（`grep -i address` 零命中）。地址是整条链路上唯一
  「填错了会把货寄给别人」的环节，而 `fillAddress` 的逻辑全塞在 `amazon.ts` 的时序里，
  纯函数够不着。补上夹具之后当场抓到一个真的：结算页上**折叠着的地址簿**会让
  「地址区加载」在页面还没跳走的那一刻就成立 —— 于是我们在结算页上点了一个不可见的
  「新建地址」，然后等一个永远不会出现的表单。只要买家号有历史地址（常态），
  每一单都 `ADDRESS_FORM_TIMEOUT`

**判据落空时要能一眼分出「选择器坏了」和「页面慢」。** 前者要改代码、后者重试就好，
而它们今天都渲染成同一个可重试错误码。`parse.diagnoseMiss` 把这两种分开写进错误 detail：
一个节点都没匹配到 = Amazon 改版；匹配到了但没渲染出来 = 页面还没画完。
⚠ 这条区分**只给人看**：错误码仍然是 `ADDRESS_FORM_TIMEOUT`（属于 `RETRYABLE`），
自动重试开关一开，系统照样会把这类单再拍几次。所以 detail 的文案只描述页面上看到了
什么，不写「重试无用」这种系统不会兑现的话。要让机器也用上它，得给这一档单开一个归
`TO_MANUAL` 的错误码 —— 错误码是封闭集，开口子是跨线的决定。

**驱动级演练。** 有几件事纯函数够不着：清车用哪种方式取「空车」证据、地址保存的
那段循环有没有在每一轮动作之后真的等状态变化。这两处让 `AmazonDriver` 对着夹具
真跑一遍（`clearCart` 自己开 iframe；`fillAddress` 自己填字、点保存、等结果），
断言的是**行为**，不是某个纯函数的返回值。

这不能替代真实页面验证——Amazon 的真实 DOM 一定和夹具有出入。它能保证的是：
**报告里记着的那些选择器，我们的解析器确实按它们的语义在读。**

## 自检（不碰 Amazon）

```bash
npm run smoke                                   # happy
node tools/smoke.mjs --scenario over_cap        # 护栏拦截
node tools/smoke.mjs --scenario oos             # 商品无货
node tools/smoke.mjs --scenario not_fba         # 非 Amazon 配送
node tools/smoke.mjs --scenario wrong_asin      # 订单卡 ASIN 不符
node tools/smoke.mjs --scenario confirm_timeout # 点了下单但没见确认页
node tools/smoke.mjs --scenario late_delivery   # 交期超限
node tools/smoke.mjs --scenario cart_mismatch   # 购物车回读与本单不符
node tools/smoke.mjs --scenario login_lost      # 跑到一半被登出:退回队列,不记异常
node tools/smoke.mjs --scenario manual_verify   # 转到发卡行验证页,人做完了 → 照常回填
node tools/smoke.mjs --scenario manual_verify_timeout   # 人没做完 → 支付验证超时,转待人工

# 物流同步是独立一条流,加 --ship 顺带跑一轮
node tools/smoke.mjs --scenario happy --ship in_transit
node tools/smoke.mjs --scenario happy --ship delivered
```

跑的是 `src/` 里将来真装进浏览器的那份 `Loop` 与 `runTask`，只把页面动作换成假的。
和 `tools/mock_plugin.py` 的分工：那个是手写 HTTP 序列，验服务端；这个验插件。

六个场景实跑后库里应该是：

| 上游单号 | 状态 | 错误码 |
|---|---|---|
| happy | `purchased` | — （单号已回填） |
| over_cap | `manual` | `PRICE_CAP_EXCEEDED` |
| oos | `exception` | `OUT_OF_STOCK` |
| not_fba | `exception` | `NOT_FBA` |
| wrong_asin | `manual` | `ORDER_NO_AMBIGUOUS`（**单号未写入**） |
| confirm_timeout | `manual` | `ORDER_CONFIRM_TIMEOUT` |
| login_lost | `ready`(**退回队列**) | — （单子没毛病，是这台机器被登出了；事件流里有一条「登录态失效，退回队列」） |
| manual_verify | `purchased` | — （事件流里有「等待人工完成支付验证」「人工支付验证已完成」两条） |
| manual_verify_timeout | `manual` | `PAYMENT_VERIFICATION_TIMEOUT`（**可能已下单**，重置前要有人去买家号里看一眼） |

## 写在代码里的几条规矩

**不申请 `cookies` 权限。** 登录态留在浏览器 profile 里，不读也不上传。
这不是"暂缓"，是架构选择：服务端因此无法脱离操作员的浏览器独立下单，
这正是不想具备的能力。`manifest.json` 里权限只有 `storage` 和 `alarms`。

**点下单那一刻起，禁止退回队列。** `runTask` 里的 `mayHaveOrdered` 在
`placeOrder()` **之前**置位 —— 如果在点击过程中崩了，我们同样不知道单下没下成。
一旦置位，任何失败都 `to_manual`；退回队列等于让下一个实例把同一单再买一遍。

**失败必上报、必清车。** 每条终止路径都走 `finish()`，它保证先清车再上报，
不存在"只写本地日志"的出口。（厂商插件有 30+ 条只写日志的失败路径，且多数不清车，
一次失败连带废掉下一单。）

**护栏裁决在服务端。** 插件只把结算页读到的数报上去，不自己比。
把闸门交给被管的一方，闸门就不成其为闸门。

**"没说上话" ≠ "没有单"。** `ApiResult` 用 `kind` 把 transport 与 business 分开，
调用方必须分别处理。厂商插件正是在这里把网络失败记成"没有需要同步的订单"，
运维看日志会以为系统正常。

**写操作不重试。** `complete` / `fail` / `release` / `guard-check` 都是非幂等的；
只有注册和心跳走 `postIdempotent`，且只在"没说上话"时重试一次。

**每个请求都有超时。** 厂商插件全文件 `AbortController` 命中 0 次，服务端 hang 住
则整个循环无限阻塞、UI 无提示、无法取消。

**所有等待只有一个出口形状：要么拿到值，要么抛 `WaitTimeout`。** 厂商插件在等待上
踩了四个会让整条流水线永久挂起的坑（轮询 resolve 后不 clearInterval、超时分支写成裸
`return`、`if (iframe && iframe.contentWindow)` 没有 else、操作员关掉弹层后 end 回调
只打日志）——四个都是同一个形状：某条路径没让 Promise 落地。`dom/wait.ts` 的定时器在
`finally` 里清，不看成败。

**下单成功只认 thankyou 页。** 厂商把"被退回购物车"也判成功——而那恰恰是下单失败的
典型表现（库存被抢、支付被拒、地址被拒）。判错的后果是给一个没下成的任务回填上一单的号。

**登录态只看页面，不看 Cookie。** 插件没申请 `cookies` 权限，所以「这个买家号还登着吗」
只能从导航栏上看出来：`#nav-item-signout` 在不在、`#nav-link-accountList` 的 href 指向哪、
问候语写什么。三条判据按可信度排，**结构判据优先，文案只做辅助且只能把结论推向"已登出"**
——按英文问候语断定"已登录"是最脆的一条，而它失灵的方向恰好是最坏的那个。

读不出来是 `unknown`，**不许兜底成 `ok`**：判不出来时放行，这道闸就等于不存在，
而运营台上还会写着「已登录」。什么时候读:服务端在心跳里说「有单在等、且该复检了」时，
**认领之前**开一张购物车页读一次（本地再压一层 10 分钟缓存，别每轮都开页面）。

**执行中落到 `/ap/signin` 是"退回队列"，不是"拍单异常"。** 单子本身没毛病——没缺货、
没超限价、地址也没问题，是这台机器的浏览器被登出了。记成 `exception` 会把一堆好单堆进
异常桶，让人挨个看一遍才发现原因都一样。所以驱动抛的是 `LoginLostError`（**刻意没有
错误码**，理由见 `flow/driver.ts` 里那段注释），`run.ts` 收到之后写一条事件流 step
「登录态失效，退回队列」→ 清车 → `/release`，并把登录态标成 `signed_out` 上报。
**已经越过下单点的除外**：那时"可能已经花了钱"比"被登出了"更要紧，仍走转人工那条路。

**点了下单之后的等待:有界、分段、可见、上报,四件缺一不可。**
美国站的真单会遇到发卡行验证(3DS):Amazon 把结算 iframe 导到一个**跨域**页面,
要操作员去手机上收短信再回来输验证码。原先这里只有一个 60 秒的 `waitFor`,
到点 `dispose()` 把 iframe 删掉 —— 凡是触发验证的订单 100% 失败,
而且没有一条日志说过「有个验证页在等你」。把 60 秒改成 60 分钟不解决问题:
那个 iframe 在 `left:-10000px; pointer-events:none` 的宿主里,他看不见也点不到。
现在 `placeOrder` 是三段有界循环(`normal` / `manual_verify` / `post_verify`,
预算全在 `core/config.ts` 的 `timeouts` 里),进入 `manual_verify` 就
`frame.reveal()` 把窗口推到屏幕中间并上报一条 step;`manual_verify` 段到期抛
`PAYMENT_VERIFICATION_TIMEOUT`,其余段抛 `ORDER_CONFIRM_TIMEOUT`。
**仍然不给关闭按钮** —— 放弃的方式是让上界到期,不是给一个能让 Promise 永挂的 ×。

**等待的上界由服务端反推,不由插件自己拍。** 认领响应带 `claim_timeout_min`,
硬顶 = `min(timeouts.orderHardCap, claim_timeout_min×60s − orderServerMargin)`。
因为 `task_sweep` 只看 `claimed_at`:等过了头,任务先被判成 `CLAIM_TIMEOUT`,
之后操作员做完验证、订单真下成了、单号也读到了,`complete` 却拿回 409 ——
**钱花了、货发了,系统里是一条没有单号的待人工**。

**读不到 URL 要说清是哪一种读不到。** `frame.urlState()` 分四态:
`ok` / `cross_origin`(人正在验证页上)/ `detached`(iframe 没了)/ `unreadable`。
原先 `url()` 把后三种渲染成同一个空字符串,运营台上三种完全不同的现场
长成同一句「当前 URL:」。`url()` 语义不变,要区分的地方改用 `urlState()`。

**单飞闸挂在 Runner 上,不挂在 Loop 上。** 配置里的服务端地址一变,
`setConfig` 会重建 Loop —— 闸跟着归零,正在跑的那一单还没结束就又领一单进来,
两条 `runTask` 动同一个购物车(第二单的 `clearCart` 会把第一单加好的东西删光)。
现在配置替换要**等在跑的那一单结束**才生效,`core/singleflight.ts` 里那道闸的
检查与置位之间一个 `await` 都没有。

**跨标签页的执行租约存在 `chrome.storage.session` 里,TTL 5 分钟,持有者忙不让位。**
MV3 的 service worker 空闲约 30 秒被回收,模块级变量随之归零 ——
原先那句 `leaseTabId === null` 在 SW 每次重启后对任何标签页都成立;而 45 秒的 TTL
短于后台标签页的定时器节流周期(约 60 秒),正跑着单的标签页只要被切到后台
就会把租约丢掉。裁决规则在 `core/lease.ts`(纯函数,Node 里验得了),
「持有者的标签页还在不在」由 SW 问 `chrome.tabs`。
SW 里那段「读租约 → 裁决 → 写租约」整段跑在 `core/serial.ts` 的串行闸里 ——
读和写都是 await,不串起来的话两条前后脚到达的请求会读到同一个旧值、双双拿到租约。
持有者一直不来续租也有界:宽限期过完照样换手 —— 不然一个死掉的内容脚本
能让这个买家号永远拍不了单。
**续租发生在单飞闸外面**:一单能跑好几分钟(光发卡行验证那一段就有 6 分钟预算),
把续租关进闸里的话,整单期间一次都续不上,TTL 一到租约就被另一个标签页接管 ——
这道闸要堵的洞会被闸自己捅开。

**被看门狗掐掉的那一单没落地之前不认领,而这一等也有界。** 相位是 `stuck`
(「上一单未收尾」),不是灰色的「待命」——「没单可跑」和「有单也不领」
渲染成同一个样子的话,一台从此再也不拍单的机器看起来一切正常。
再等一个 `taskHardCapMs` 还没落地就不等了,日志里写清楚不等的后果。

**清车连着失败要熔断。** `clearCart` 是每一单的第一步,它失败通常意味着
Amazon 改了购物车页的结构 —— 而 `tickOnce` 每 10 秒来一次,一个夜里能把队列里
几百单一单一单全打进「拍单异常」桶。连续 3 单清不动就暂停认领 10 分钟,
并且这件事在运营台的买家号那一页上有一格(那一位以前是只写不读的)。
**「连续」的意思是中间只要有一单清成功过就清零**(包括拍成的那一单 ——
清车是它的第一步),否则「失败、失败、成功、失败」也会熔断,
而它报出来的原因(「Amazon 改了购物车页的结构」)是假的。

**地址填完要验它真生效了。** 检查收货地址栏里确实含本单的邮编与城市，不符就报
`ADDRESS_NOT_APPLIED`。厂商只做了"地址文本含邮编"这一条子串判断，姓名/街道/城市/州
一概不校验。

## 可调参数(插件这一侧)

**服务端的配置表在仓库根 README 里,插件的在这里** —— 两处不是一回事:
那边是环境变量,这边存在浏览器的 `chrome.storage` 里,由 `core/config.ts` 统一读。
任何地方出现硬编码的地址或超时数字都是违规(与主项目 `registry/settings.py` 同一条规矩)。

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8781` | 服务端地址 |
| `envCode` | 空 | 买家号。没配就不注册 —— 猜一个会把单派错账号 |
| `mode` | `off` | 三档运行模式,见上 |
| `heartbeatMs` | `20000` | 心跳间隔 |
| `claimPollMs` | `10000` | 认领轮询间隔,也是执行租约的续租节奏 |
| `shipmentPollMs` | `900000` | 物流同步轮询 |
| `requestTimeoutMs` | `15000` | 单个 HTTP 请求的超时 |
| `taskHardCapMs` | `1200000` | 一单最多跑多久。看门狗用的**最后一道网**,正常永远不该触发。实际生效的还要与服务端 `claim_timeout_min` 取更紧的那个 |
| `cartFailStreakMax` | `3` | 连着几单清不动购物车就暂停认领 |
| `cartBlockMs` | `600000` | 熔断之后暂停认领多久 |
| `leaseTtlMs` | `300000` | 跨标签页执行租约的有效期。**别调到 60 秒以下** —— 后台标签页的定时器节流周期就是那个量级,短了会把租约从一个正跑着单的标签页手里丢掉 |
| `leaseBusyGraceMs` | `600000` | 持有者报着「我在跑单」却不再续租时的宽限。到点照样换手 —— 死掉的内容脚本不该让这个买家号永远拍不了单 |
| `timeouts.frameLoad` | `30000` | iframe 加载 |
| `timeouts.loginProbe` | `20000` | 判登录态时等导航栏渲染 |
| `timeouts.addToCart` | `30000` | 加购后等跳转到购物车 |
| `timeouts.checkoutNav` | `45000` | 等结算页(含中间页) |
| `timeouts.addressForm` / `addressSave` | `30000` | 地址表单 / 保存后等地址栏 |
| `timeouts.orderConfirm` | `60000` | 点了下单之后等确认页(页面还读得到的那一段) |
| `timeouts.manualVerify` | `360000` | **留给操作员完成发卡行验证的时间**。按买家号/发卡行现场调:短信到达速度差异很大 |
| `timeouts.postVerify` | `60000` | 验证结束之后等确认页。独立且短 |
| `timeouts.orderHardCap` | `600000` | 整个 placeOrder 的硬顶 |
| `timeouts.orderServerMargin` | `180000` | 硬顶要给服务端认领超时留的余量。**别调小** —— 它拦的是「订单下成了却报不上去」 |
| `timeouts.orderCards` | `20000` | 订单历史页等卡片 |
| `timeouts.orderPoll` | `500` | 下单之后那一段的轮询间隔 |

超时值只接受**有限的正数**,填坏了(0、负数、字符串)一律退回默认值:
一个存成 0 的 `manualVerify` 会让「等操作员完成验证」变成不等,
而它长得跟配好了一模一样。

`manualVerify` 与 `orderHardCap` 调大之前先看服务端的 `AMZ_CLAIM_TIMEOUT_MIN`:
真正的钳制来自认领响应里的 `claim_timeout_min`,插件只会取两者更紧的那个。
把插件这边调到 20 分钟而服务端还是 15 分钟的话,实际生效的仍是 12 分钟。
**而且这本账从认领那一刻起算**:清车/加购/填地址已经花掉的时间要从里面扣,
`taskHardCapMs` 同样被钳进这个窗口 —— 它比认领超时还长的话,看门狗触发时
任务在服务端早就不是「拍单中」了,它那条留痕会被拒掉。

## 目录

```
src/core/      types(契约) codes(错误码封闭集) status(界面标签)
               api(HTTP 出口) client(端点) config(可调参数唯一来源,含超时表) store log
               singleflight(单飞闸:第二件事挡掉) serial(串行闸:第二件事排队)
               lease(执行租约的裁决规则,纯函数)
src/flow/      driver(页面动作接口) simulated(自检用) amazon(真实驱动) run(执行时序)
               shipment(物流同步,独立一条流)
src/flow/dom/  wait(等待原语) frame(同源 iframe) selectors(选择器,标出处) parse(纯解析,含登录态判定)
               kit(只给测试:打成 window.amzdom 在 Playwright 页面里调)
src/background/ loop(认领循环,不碰 chrome API) service-worker(配置/注册/心跳/租约)
src/content/   runner(执行器,真正跑单的地方) panel(注入面板) styles copy(点击复制)
tools/         smoke.mjs(自检) copy-static.mjs
test/          dom.test.mjs(对着夹具跑解析层) unit.test.mjs(等待原语/单飞闸/租约,纯 Node)
```

`loop.ts` 与 `run.ts` 刻意不碰任何 chrome API —— 否则这套逻辑就只能靠手点扩展来验证。

## 为什么执行器在内容脚本里,不在 service worker 里

MV3 的后台是 service worker,**没有 `document`**。而 `AmazonDriver` 靠同源 iframe
操作页面(`document.createElement("iframe")`),在 SW 里第一步就是 ReferenceError。

所以分工是:

| | |
|---|---|
| service worker | 存配置、注册、心跳、发**执行租约** |
| 内容脚本(`content/runner.ts`) | 认领、跑单、物流同步 —— 所有要动页面的活 |

代价与厂商那套一样:整个流程绑死在「操作员得开着一个 Amazon 页面」上。
这是同源 iframe 方案换来的,不是疏漏。

**租约解决的是多标签页问题。** 同一浏览器里可能开着好几个 amazon.com,
每个都注入了内容脚本。不发租约的话两个标签页会各领一单,
在同一个买家号上并行拍两单 —— 而整套服务端设计的前提正是「这不会发生」。
租约 45 秒 TTL,每轮认领前现要;拿着租约的标签页被关掉时立刻释放。

## 物流同步

跑在任务已经 `purchased` 之后,**不改任务状态**,只往 logistics 域写。
所以它失败了不会把一单已完成的采购掀翻 —— 这是刻意的。

```
POST /v1/shipments/pending  → 我这个买家号下哪些单该同步了
  ↓ 每单
订单详情页 /gp/your-account/order-details?orderID=...
  ↓ 先判订单本身的状态(报告 §4.3 第 3 步),再抓
  ok → 找跟踪链接 → 跟踪页 → 运单号 / 承运商 / 主状态 / 轨迹事件
  cancelled / not_found → 直接回传,不再往下走
  ↓
POST /v1/shipments/sync
```

三条写进代码的判断:

**订单本身的状态盖过轨迹状态。** 页面说 cancelled,轨迹上写什么都不算数。

**`not_found` 只记不改。** 订单详情页打不开,说明我们回填的那个号可能根本不属于
这个买家号 —— 但一次打不开也可能是页面抽风。自动把 `purchased` 打回待人工,
会在 Amazon 抽风的那天把一整批已完成的单全掀翻。所以服务端只记一条 `shipment` 事件。

**单条失败不拖垮整批。** 厂商那边 `postalCodeInfo` 为 null 时抛的 TypeError 会一路
冒泡到 `handleOrderSync` 的 catch,**整批同步就此中止**,后面的订单全部不再处理
(报告 §4.3)。这里每单一个 try。
