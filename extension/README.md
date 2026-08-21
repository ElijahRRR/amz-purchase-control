# extension —— Chrome MV3 插件

服务端派单，插件在**操作员自己的浏览器环境里**执行。这一层是 P2：
和服务端说话的时序全部跑通并可自检；真实页面动作（P3）还是空的。

## 现在能跑的 / 还不能跑的

| | 状态 |
|---|---|
| 注册 / 心跳 / 认领 / 事件上报 / 护栏裁决 / 回填 / 失败 / 释放 | ✅ 通了，六个场景实跑验过 |
| 执行时序（清车 → 加购 → 核对 → 填地址 → 读结算页 → 护栏 → 下单 → 回填断言） | ✅ 通了 |
| 面板（相位、任务卡、步骤、日志、点击复制） | ✅ |
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
npm run test:dom     # 33 条断言
```

夹具里塞满了干扰项——隐藏的同 id 副本、Saved for later、推荐位、`<template>` 模板节点、
支付文案里先出现的另一个 4 位数。选择器写松了会当场被抓住。实际抓到过两个：

- `#quantity` 在页面上有隐藏副本，`querySelector` 取第一个就可能取到只有 2 个选项的那个
- `.order-card__list` 被报告记作 `.js-order-card` 的退化选择器，但它其实是**列表容器**。
  一张订单都没有时，隐藏模板里的空容器会被当成一张卡，于是"没有订单"变成
  "有一张读不出号的订单"

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

**地址填完要验它真生效了。** 检查收货地址栏里确实含本单的邮编与城市，不符就报
`ADDRESS_NOT_APPLIED`。厂商只做了"地址文本含邮编"这一条子串判断，姓名/街道/城市/州
一概不校验。

## 目录

```
src/core/      types(契约) codes(19 个错误码) status(界面标签)
               api(HTTP 出口) client(端点) config store log
src/flow/      driver(页面动作接口) simulated(自检用) amazon(真实驱动) run(执行时序)
src/flow/dom/  wait(等待原语) frame(同源 iframe) selectors(选择器,标出处) parse(纯解析)
src/background/ loop(认领循环,不碰 chrome API) service-worker(MV3 后台)
src/content/   panel(注入面板) styles copy(点击复制)
tools/         smoke.mjs(自检) copy-static.mjs
```

`loop.ts` 与 `run.ts` 刻意不碰任何 chrome API —— 否则这套逻辑就只能靠手点扩展来验证。
