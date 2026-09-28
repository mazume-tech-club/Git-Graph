import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error 開発サーバ専用のプレーン JS モジュール（型定義は持たせていない）
import { gitApiMiddleware } from "./scripts/dev-git-api.mjs";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [
    react(),
    {
      // ブラウザで直接開いたときに、Tauri コマンドと同じ JSON を返す開発用 API。
      // Tauri の WebView からは使われない（そちらは Rust 側を呼ぶ）。
      name: "git-graph-dev-api",
      apply: "serve",
      configureServer(server) {
        server.middlewares.use(gitApiMiddleware);
      },
    },
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
