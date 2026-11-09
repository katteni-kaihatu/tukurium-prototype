import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = process.env.TUKURIUM_SERVER ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": server,
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { target: "es2022", sourcemap: true },
  // 型を確かめる Worker で初めて読む TypeScript（ADR 0058）を、開発サーバーの起動時に取り込んでおく。
  // 取り込んでいないと、初めて型を確かめたときに Vite が取り込み直してページを読み込み直す
  optimizeDeps: { include: ["typescript6", "sucrase"] },
});
