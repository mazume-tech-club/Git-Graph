/// <reference types="vite/client" />

/** package.json の version。vite.config.ts の define で埋め込む */
declare const __APP_VERSION__: string;
/** リリース一覧の URL。社内の設定が無いビルドでは null */
declare const __RELEASES_URL__: string | null;
