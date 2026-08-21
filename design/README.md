# 前端设计画布

四块画板,视觉词汇整套沿用所有者已有的设计系统(zinc 中性色 + Inter / JetBrains Mono +
中间态虚线 / 终态实心 + 危险动作先预览),没有另起一套。

| 文件 | 是什么 | 可点 |
| --- | --- | --- |
| `Main.dc.html` | 后台运营台 · 任务队列 | 是 — 状态桶 / 时间维度 / 买家号 / 批量单号,选行,右抽屉,危险动作预览 |
| `Plugin.dc.html` | 插件注入在亚马逊页面上的面板 | 是 — 顶上六个相位,走一单从待命到下单/被拦下 |
| `DesignSystem.dc.html` | 7 个任务状态 + 状态机 + 18 个错误码 | 否 |
| `Instances.dc.html` | 买家号与插件实例 | 否 |

`canvas.json` 是画板在画布上的排布(两页:交互原型 / 设计系统与运行域)。

运营台的筛选区与列结构是照厂商面板的字段级观察做的取舍,逐条对照见
[`docs/03-运营台字段对照.md`](../docs/03-运营台字段对照.md)。

## 画布上的东西必须是库里真有的

状态取值对着 `docs/db_schema.md` 的 `procure.tasks.status`(7 个),错误码对着
`services/` 里实际会写进 `task_events` 的那一组。库里没有的状态,画布上也不许有;
反过来画布上画了的,`refdata/schema.sql` 里就得有对应的落点。改库先改文档,再改画布。

## 三条在画布上被固化下来的判断

1. **下单永远有预览步。** 花钱这一步是红实心 + ⚡,前面必须站一屏「要发生什么」。
   面板上再没有第二个红按钮 —— 红色一旦廉价,它就不再是刹车。
2. **护栏拦截是紫的,不是红的。** 紫 = 需要人来判断,红 = 坏了。
   `PRICE_CAP_EXCEEDED` 是护栏正常工作的样子,不是故障;把它画成红的,
   运营就会去「重试」一个重试一百遍也还是这个结果的东西。
3. **结局不确定用琥珀空心点。** 断言没过、领走了没回传,这类「不知道到底成没成」
   跟已经落定的实心点必须一眼分得开 —— 因为这两种处置方式相反。

## 重新生成

```
node <claude-design-skill>/seed-canvas.mjs \
  --template <skill>/payload.template.html \
  --out amz-purchase-console-design.html \
  --title "AMZ 采购控制台设计稿" \
  --artboard Main.dc.html --artboard Plugin.dc.html \
  --artboard DesignSystem.dc.html --artboard Instances.dc.html \
  --canvas canvas.json
```
