#!/usr/bin/env bash
# GitHub へ、社内の値を取り除いた履歴を送る。
#
#   bash scripts/publish-github.sh            # 通常（早送りで送れるときだけ送る）
#   bash scripts/publish-github.sh --force    # 置き換え方を変えたときなど、上書きして送る
#   bash scripts/publish-github.sh --dry-run  # 作って検査するだけで送らない
#
# Gitea の main を一時フォルダへ複製し、git filter-repo で全履歴の社内の値を置き換え、
# latest.json を取り除き、作成者メールを差し替えてから送る。置き換え方が同じなら毎回
# 同じコミットになるので、2 回目以降は通常の push で済む。
#
# 置き換えの対応表は社内の値そのものなので、リポジトリには入れず次の場所に置く
# （GIT_GRAPH_PUBLISH_DIR で変えられる）。
#   replacements.txt  filter-repo の --replace-text 形式（本文とコミットメッセージに使う）
#   mailmap           作成者・コミッターのメールの差し替え
#   forbidden.txt     送る前に全履歴から探す語（1 行 1 語。見つかったら送らない）
#
# 実行には git-filter-repo が要る（python -m pip install --user git-filter-repo）。
set -euo pipefail

CONF_DIR="${GIT_GRAPH_PUBLISH_DIR:-$HOME/.config/git-graph-publish}"
GITHUB_URL="${GIT_GRAPH_GITHUB_URL:-git@github.com:mazume-tech-club/Git-Graph.git}"

FORCE=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE="--force" ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "不明な引数: $arg" >&2; exit 2 ;;
  esac
done

for f in replacements.txt mailmap forbidden.txt; do
  [ -s "$CONF_DIR/$f" ] || { echo "$CONF_DIR/$f がありません" >&2; exit 1; }
done

if git filter-repo --version >/dev/null 2>&1; then
  filter_repo() { git filter-repo "$@"; }
elif python -m git_filter_repo --version >/dev/null 2>&1; then
  filter_repo() { python -m git_filter_repo "$@"; }
else
  echo "git-filter-repo がありません（python -m pip install --user git-filter-repo）" >&2
  exit 1
fi

ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> main とタグを一時フォルダへ複製"
git clone --quiet --no-local --single-branch --branch main "$ROOT" "$WORK/repo"
cd "$WORK/repo"
git remote remove origin

echo "==> 社内の値を置き換える"
filter_repo --force --quiet \
  --replace-text "$CONF_DIR/replacements.txt" \
  --replace-message "$CONF_DIR/replacements.txt" \
  --mailmap "$CONF_DIR/mailmap" \
  --path latest.json --invert-paths

echo "==> 全履歴に社内の値が残っていないか確かめる"
leaks="$(
  {
    git log --all --text -p --format='%an <%ae>%n%cn <%ce>%n%B'
    git for-each-ref refs/tags --format='%(taggername) %(taggeremail)%n%(contents)'
    git ls-tree -r --name-only HEAD
  } | grep -i -n -F -f "$CONF_DIR/forbidden.txt" || true
)"
if [ -n "$leaks" ]; then
  echo "!! 社内の値が残っているので送りません（$(printf '%s\n' "$leaks" | wc -l) 行）" >&2
  exit 1
fi
echo "    残っていない（$(git rev-list --count main) コミット、$(git tag | wc -l) タグ）"

if [ "$DRY_RUN" = 1 ]; then
  echo "==> --dry-run なので送らない（main: $(git rev-parse --short main)）"
  exit 0
fi

echo "==> GitHub へ送る"
git push $FORCE "$GITHUB_URL" main
git push $FORCE "$GITHUB_URL" --tags
echo "==> 完了（main: $(git rev-parse --short main)）"
