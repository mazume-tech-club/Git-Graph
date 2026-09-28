#!/usr/bin/env bash
# ブラウザプレビュー（Vite 開発サーバ）を仮想ディスプレイ上の WebKit で開き、
# スクリーンショットを撮る。Tauri を経由しない表示の確認に使う。
#
#   docker compose run --rm dev bash scripts/screenshot-browser.sh [開くリポジトリ] [出力先 png]
#
set -euo pipefail

REPO="${1:-/tmp/demo}"
OUT="${2:-/app/screenshot-browser.png}"
PORT="${PORT:-1420}"
WAIT_SECONDS="${WAIT_SECONDS:-15}"
MINI_BROWSER=$(find /usr/lib -maxdepth 3 -name MiniBrowser -type f 2>/dev/null | head -1)

cd /app
[ -n "$MINI_BROWSER" ] || { echo "MiniBrowser が見つかりません" >&2; exit 1; }

export DISPLAY="${DISPLAY_NUM:-:98}"
export GIT_GRAPH_REPO="$REPO"
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1

cleanup() {
  [ -n "${BROWSER_PID:-}" ] && kill "${BROWSER_PID}" 2>/dev/null || true
  [ -n "${VITE_PID:-}" ] && kill "${VITE_PID}" 2>/dev/null || true
  [ -n "${XVFB_PID:-}" ] && kill "${XVFB_PID}" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Xvfb を起動 (${DISPLAY})"
Xvfb "${DISPLAY}" -screen 0 1400x900x24 -nolisten tcp >/dev/null 2>&1 &
XVFB_PID=$!

echo "==> vite dev サーバを起動 (repo=${REPO})"
npx vite --port "${PORT}" >/tmp/vite.log 2>&1 &
VITE_PID=$!
for _ in $(seq 1 30); do
  grep -q "ready in" /tmp/vite.log 2>/dev/null && break
  sleep 1
done

echo "==> WebKit で開く"
dbus-run-session -- "${MINI_BROWSER}" --geometry=1300x820 "http://localhost:${PORT}/" \
  >/tmp/minibrowser.log 2>&1 &
BROWSER_PID=$!

sleep "${WAIT_SECONDS}"

echo "==> スクリーンショットを保存: ${OUT}"
import -window root "${OUT}"
echo "==> 完了"
