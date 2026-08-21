# extension —— Chrome MV3 插件

服务端派单，插件在**操作员自己的浏览器环境里**执行。这一层是 P2：
和服务端说话的时序全部跑通并可自检；真实页面动作（P3）还是空的。

## 现在能跑的 / 还不能跑的

| | 状态 |
|---|---|
| 注册 / 心跳 / 认领 / 事件上报 / 护栏裁决 / 回填 / 失败 / 释放 | ✅ 通了，六个场景实跑验过 |
| 执行时序（清车 → 加购 → 核对 → 填地址 → 读结算页 → 护栏 → 下单 → 回填断言） | ✅ 通了 |
| 面板（相位、任务卡、步骤、日志、点击复制） | ✅ |
| 真实 Amazon 页面动作 | ❌ P3。`AmazonDriver.ready = false`，因此 **live 档不会认领任何任务** |

## 三档运行模式

`mode` 决定这台机器干什么，默认 **off**：

- **off**（默认）：只注册与心跳，不认领。骨架阶段不该自己去动真单。
- **simulate**：认领并跑完整流程，但页面动作走 `SimulatedDriver`，返回固定值。
  用来自检"和服务端说话的时序"，**不会在 Amazon 上产生任何订单**。
- **live**：在真实页面上执行。`AmazonDriver` 未实现，这一档目前会被拒绝
  —— 与其领了单再报 `PLUGIN_INTERNAL` 把它打进异常桶，不如根本不领。

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

## 目录

```
src/core/      types(契约) codes(18 个错误码) status(界面标签)
               api(HTTP 出口) client(端点) config store log
src/flow/      driver(页面动作接口) simulated(自检用) amazon(P3,空的) run(执行时序)
src/background/ loop(认领循环,不碰 chrome API) service-worker(MV3 后台)
src/content/   panel(注入面板) styles copy(点击复制)
tools/         smoke.mjs(自检) copy-static.mjs
```

`loop.ts` 与 `run.ts` 刻意不碰任何 chrome API —— 否则这套逻辑就只能靠手点扩展来验证。
