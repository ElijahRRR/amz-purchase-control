# 画布自检工具

`render.mjs` 把一块 `.dc.html` 渲染成静态 HTML:跑一遍 `renderVals()`,把 `{{holes}}` /
`sc-for` / `sc-if` 展开,去掉 `onClick`。只为了**截图核对布局**,不是 Claude Design 运行时的替代品。

```
node design/tools/render.mjs design/Main.dc.html /tmp/Main.html
node design/tools/render.mjs design/Main.dc.html /tmp/Main.html '{"density":"compact","sel":"UP-20828"}'
```

第三个参数是 JSON,覆盖组件初始 state —— 用来渲染某个具体的交互状态(某档密度、弹窗打开)。

配合 playwright 截图就能量到真实尺寸:

```js
const p = await b.newPage({ viewport: { width: 1920, height: 1280 } })
await p.goto('file:///tmp/Main.html')
await p.evaluate(() => [...document.querySelectorAll('tr.rd')]
  .map(r => Math.round(r.getBoundingClientRect().height)))   // → 行高
await p.screenshot({ path: '/tmp/Main.png' })
```

## 为什么要有这个

画布上「显示不全」有两种完全不同的原因:内容被容器裁掉,和内容根本没放进去。
靠读代码分不出来,靠猜会改错地方。渲染出来量一次就知道 ——
本次「订单信息显示不完全」量出来是画板没裁(scrollHeight == 视口高),
是行高 40px 单行装不下 8 组字段,于是加了「详细」记录行这一档。
