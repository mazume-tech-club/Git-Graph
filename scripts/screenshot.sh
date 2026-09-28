#!/usr/bin/env bash
# 仮想ディスプレイ（Xvfb）上でアプリを起動し、スクリーンショットを撮る。
# GUI の無いコンテナで表示を確認するためのもの。
#
#   docker compose run --rm dev scripts/screenshot.sh [開くリポジトリ] [出力先 png]
#
set -euo pipefail

REPO="${1:-/app}"
OUT="${2:-/app/screenshot.png}"
DISPLAY_NUM="${DISPLAY_NUM:-:99}"
WAIT_SECONDS="${WAIT_SECONDS:-12}"

cd /app

echo "==> フロントエンドをビルド"
npm run build

echo "==> アプリをビルド"
cargo build --manifest-path src-tauri/Cargo.toml

echo "==> Xvfb を起動 (${DISPLAY_NUM})"
Xvfb "${DISPLAY_NUM}" -screen 0 1400x900x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY="${DISPLAY_NUM}"

# WebKitGTK は GPU の無い環境ではソフトウェア描画に落とす必要がある
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1

cleanup() {
  [ -n "${APP_PID:-}" ] && kill "${APP_PID}" 2>/dev/null || true
  [ -n "${VITE_PID:-}" ] && kill "${VITE_PID}" 2>/dev/null || true
  kill "${XVFB_PID}" 2>/dev/null || true
}
trap cleanup EXIT

# デバッグビルドは tauri.conf.json の devUrl を見るので、vite を立てておく
echo "==> vite dev サーバを起動"
npm run dev >/tmp/vite.log 2>&1 &
VITE_PID=$!
for _ in $(seq 1 30); do
  if grep -q "ready in" /tmp/vite.log 2>/dev/null; then break; fi
  sleep 1
done

echo "==> アプリを起動 (repo=${REPO})"
dbus-run-session -- ./src-tauri/target/debug/git-graph "${REPO}" >/tmp/app.log 2>&1 &
APP_PID=$!

sleep "${WAIT_SECONDS}"

if ! kill -0 "${APP_PID}" 2>/dev/null; then
  echo "!! アプリが終了しています。ログ:" >&2
  cat /tmp/app.log >&2
  exit 1
fi

echo "==> スクリーンショットを保存: ${OUT}"
import -window root "${OUT}"
echo "==> 完了"
