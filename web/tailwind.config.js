/** 逐值对齐 design/DesignSystem.dc.html。
 *  中性色本来就是 Tailwind 的 zinc,所以大部分直接用原生类;
 *  这里只补那些设计里有名字、而 Tailwind 没有的东西。 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "Noto Sans SC", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      fontSize: {
        // 设计里用到的几个非标准字号
        "2xs": ["10px", { lineHeight: "1.4" }],
        "xs+": ["11px", { lineHeight: "1.5" }],
        "sm-": ["12.5px", { lineHeight: "1.6" }],
      },
      height: {
        chead: "44px",   // 卡片头
        row: "40px",     // 舒适行
        rowc: "32px",    // 紧凑行
        th: "36px",
      },
      boxShadow: {
        // 选中行左侧那道竖线
        rowsel: "inset 2px 0 0 #18181b",
      },
    },
  },
  plugins: [],
};
