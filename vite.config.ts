import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error 開発サーバ専用のプレーン JS モジュール（型定義は持たせていない）
import { gitApiMiddleware } from "./scripts/dev-git-api.mjs";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { existsSync, readFileSync } from "node:fs";
import pkg from "./package.json";
const host = process.env.TAURI_DEV_HOST;

/**
 * ヘルプに出すリリース一覧の URL。社内の値は Git に入れていない
 * src-tauri/tauri.windows.conf.json の更新の配信元から作る。無ければ null（リンクを出さない）
 */
function releasesUrl(): string | null {
  const path = "src-tauri/tauri.windows.conf.json";
  if (!existsSync(path)) return null;
  const endpoint: string | undefined = JSON.parse(readFileSync(path, "utf8")).plugins?.updater
    ?.endpoints?.[0];
  return endpoint ? endpoint.replace(/\/raw\/branch\/[^/]+\/latest\.json$/, "/releases") : null;
}

// https://vite.dev/config/
export default defineConfig(() => ({
  // ブラウザプレビューでヘルプに出すバージョン。Tauri では実行ファイルの版を使う
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __RELEASES_URL__: JSON.stringify(releasesUrl()),
  },

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
