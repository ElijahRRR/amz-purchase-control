import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    // 开发期把 /v1 代到 FastAPI。走代理而不是开 CORS ——
    // 服务端不做鉴权、只监听 127.0.0.1,给它加一个宽松的跨域白名单是白送风险面。
    proxy: {
      "/v1": { target: "http://127.0.0.1:8781", changeOrigin: false },
      "/health": { target: "http://127.0.0.1:8781", changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
