/**
 * 自動更新用の latest.json を作る。
 *
 *   node scripts/make-latest-json.mjs <バージョン> [リリースノートのファイル]
 *
 * 署名付きでビルドした後に実行すること。インストーラの隣にある .sig を読み、
 * Gitea のリリース資産を指す JSON をリポジトリ直下に書き出す。
 * これを main へ push すると、アプリが raw URL 経由で拾う。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_URL = "http://gitea.asuzacfoods.jp/asuzacfoods/Git-Graph";
const BUNDLE_DIR = "src-tauri/target/release/bundle/nsis";
/** Tauri が Windows x64 のターゲットとして使う名前 */
const TARGET = "windows-x86_64";

const [version, notesPath] = process.argv.slice(2);
if (!version) {
  console.error("使い方: node scripts/make-latest-json.mjs <バージョン> [ノートのファイル]");
  process.exit(1);
}

const installer = `Git Graph_${version}_x64-setup.exe`;
const sigPath = join(BUNDLE_DIR, `${installer}.sig`);

if (!existsSync(sigPath)) {
  console.error(`署名ファイルがありません: ${sigPath}`);
  console.error("TAURI_SIGNING_PRIVATE_KEY を設定してビルドし直してください。");
  process.exit(1);
}

const notes = notesPath && existsSync(notesPath) ? readFileSync(notesPath, "utf8").trim() : "";

const latest = {
  version,
  notes,
  // 時刻は RFC3339。ビルド時刻ではなく生成時刻で構わない
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    [TARGET]: {
      signature: readFileSync(sigPath, "utf8").trim(),
      url: `${REPO_URL}/releases/download/v${version}/${encodeURIComponent(installer)}`,
    },
  },
};

writeFileSync("latest.json", `${JSON.stringify(latest, null, 2)}\n`, "utf8");
console.log(`latest.json を書き出しました (v${version})`);
console.log(`  url: ${latest.platforms[TARGET].url}`);
