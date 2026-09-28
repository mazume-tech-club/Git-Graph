#!/usr/bin/env bash
# 表示確認用のデモリポジトリを作る。ブランチ・マージ・タグ・リモート追跡ブランチを
# 一通り含むので、グラフ描画と ref バッジをまとめて確認できる。
#
#   docker compose run --rm dev bash scripts/demo-repo.sh [出力先]
#
set -euo pipefail

DEST="${1:-/tmp/demo}"
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

git init -q -b main
git config user.name "Demo User"
git config user.email demo@example.com

n=0
c() {
  n=$((n + 1))
  local d
  d="2026-$(printf %02d $((1 + n / 10)))-$(printf %02d $((1 + n % 28)))T10:00:00+09:00"
  GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" git commit -q --allow-empty -m "$1"
}

c "初期コミット"
c "README を追加"
c "CI の設定を追加"

git checkout -q -b feature/graph
c "レーン割り当てを実装"
c "SVG 描画を追加"

git checkout -q main
c "依存を更新"
git merge -q --no-ff feature/graph -m "Merge branch 'feature/graph'"

git checkout -q -b fix/date-format main~1
c "日付のタイムゾーンを修正"

git checkout -q main
c "README を整理"
git merge -q --no-ff fix/date-format -m "Merge branch 'fix/date-format'"
git tag -a v0.1.0 -m "最初のリリース"

git checkout -q -b feature/detail main
c "詳細ペインを追加"
c "ref バッジを追加"

git checkout -q -b feature/filter main
c "検索ボックスを追加"

git checkout -q main
git merge -q --no-ff feature/detail -m "Merge branch 'feature/detail'"
c "スタイルを調整"
git merge -q --no-ff feature/filter -m "Merge branch 'feature/filter'"
c "バージョンを 0.2.0 に"
git tag v0.2.0

# リモート追跡ブランチのバッジも確認したいので、実体だけ作っておく
git update-ref refs/remotes/origin/main main~2

echo "作成しました: $DEST"
git log --graph --oneline --all --topo-order
