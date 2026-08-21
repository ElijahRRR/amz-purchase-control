import { defineConfig } from "vite";

/** 两个入口分别打:内容脚本不能是 ES module,必须是自包含的 iife。 */
const TARGETS: Record<string, { entry: string; name: string; out: string }> = {
  background: { entry: "src/background/service-worker.ts", name: "amzSw", out: "background" },
  content: { entry: "src/content/panel.ts", name: "amzPanel", out: "content" },
  /** 只给测试用:把纯解析函数暴露成 window.amzdom,好在 Playwright 页面里直接调。 */
  domkit: { entry: "src/flow/dom/kit.ts", name: "amzdom", out: "domkit" },
};

export default defineConfig(({ mode }) => {
  const t = TARGETS[mode] ?? TARGETS.background;
  return {
    build: {
      outDir: "dist",
      emptyOutDir: mode === "background",
      target: "chrome114",
      minify: false,
      lib: {
        entry: t.entry,
        name: t.name,
        formats: ["iife"],
        fileName: () => `${t.out}.js`,
      },
    },
  };
});
