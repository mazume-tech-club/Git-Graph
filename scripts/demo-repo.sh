#!/usr/bin/env bash
# 表示確認用のデモリポジトリを作る。ブランチ・マージ・タグ・リモート追跡ブランチ・
# ワークツリー・放置ブランチ・未コミットの変更を一通り含むので、
# グラフ描画から差分表示までまとめて確認できる。
#
#   docker compose run --rm dev bash scripts/demo-repo.sh [出力先]
#
set -euo pipefail

DEST="${1:-/tmp/demo}"
rm -rf "$DEST" "${DEST}-wt"
mkdir -p "$DEST"
cd "$DEST"

git init -q -b main
git config user.name "Demo User"
git config user.email demo@example.com

n=0
# コミットごとに固有のファイルを作る。マージで衝突させないため共有ファイルは触らない
c() {
  n=$((n + 1))
  local d
  d="2026-$(printf %02d $((1 + n / 10)))-$(printf %02d $((1 + n % 28)))T10:00:00+09:00"
  mkdir -p src
  printf 'const NAME = "step%d";\n// %s\nexport default NAME;\n' "$n" "$1" > "src/step${n}.ts"
  git add -A
  GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" git commit -q -m "$1"
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

# 変更とリネームを含むコミット。差分表示の確認用
sed -i 's/step1/renamed-step1/' src/step1.ts
git mv src/step2.ts src/renamed.ts
git add -A
GIT_AUTHOR_DATE="2026-03-01T10:00:00+09:00" GIT_COMMITTER_DATE="2026-03-01T10:00:00+09:00" \
  git commit -q -m "step1 を書き換え、step2 をリネーム"

c "バージョンを 0.2.0 に"
git tag v0.2.0

# リモート追跡ブランチのバッジも確認したいので、実体だけ作っておく
git update-ref refs/remotes/origin/main main~2

# 放置されたブランチ。未マージかつ最終コミットが古い状態にする
git checkout -q -b feature/abandoned main~5
GIT_AUTHOR_DATE="2025-03-04T10:00:00+09:00" GIT_COMMITTER_DATE="2025-03-04T10:00:00+09:00" \
  git commit -q --allow-empty -m "途中で止まった実装"
git checkout -q -b fix/forgotten main~3
GIT_AUTHOR_DATE="2025-11-20T10:00:00+09:00" GIT_COMMITTER_DATE="2025-11-20T10:00:00+09:00" \
  git commit -q --allow-empty -m "レビュー待ちのまま残った修正"
git checkout -q main

# ブランチの説明（git branch --edit-description と同じもの）
git config branch.feature/detail.description "詳細ペインの作業用。ワークツリーで進行中"
git config branch.feature/abandoned.description "方針変更で中断。消してよい"
git config branch.fix/forgotten.description "レビュー待ちのまま止まっている"

# 別ワークツリーで feature/detail を開いている状態を作る
git worktree add -q "${DEST}-wt" feature/detail 2>/dev/null || true

# 未コミットの変更（変更 1 件 + 未追跡 1 件）
sed -i 's/step3/MODIFIED-step3/' src/step3.ts
printf 'まだ追跡されていないファイル\n' > untracked.txt

echo "作成しました: $DEST"
git log --graph --oneline --all --topo-order -n 12
git status --short
