# Git-Graph 仕様・開発メモ

Git のコミットグラフを可視化する Windows デスクトップアプリ。
Tauri v2 + React + TypeScript、バックエンドは Rust の libgit2（git2 クレート）。

利用者向けの説明とセットアップ手順は `README.md` にある。
ここには**仕様の詳細**と、作業するうえで踏みやすい落とし穴をまとめる。

## 基本方針

- **読み取り専用**。唯一の例外はブランチのメモ（`branch.<name>.description`）で、
  これもリポジトリ配下の `.git/config` に書くだけで履歴には触れない。
- **仕様の正は Rust 側**。ブラウザプレビュー用の開発 API（`scripts/dev-git-api.mjs`）は
  `git` コマンドを呼ぶ簡易版で、並び順など細部が異なる。食い違ったら Rust を信じる。
- **UI の文言・コメントは日本語**。コミットメッセージも日本語。

## 開発コマンド

Rust も Node もコンテナに入っている。ホストで `cargo` を叩いても失敗する。

```bash
docker compose run --rm dev npm run build         # 型チェック + ビルド
docker compose run --rm dev npm run rust:check    # コンパイルチェック
docker compose run --rm dev npm run rust:clippy   # lint（-D warnings）
docker compose run --rm dev npm run rust:fmt      # 書式チェック
docker compose run --rm dev npm run rust:test     # Rust テスト
docker compose run --rm dev npm run check:lanes   # レーン配置の不変条件検査
```

**Windows 用 exe だけはホストでビルドする**（コンテナは Linux のため）。

```powershell
npx tauri build --bundles nsis
```

### 表示確認

GUI はコンテナの仮想ディスプレイ上で確認する。Windows 側で画面キャプチャしてはいけない
（`SetForegroundWindow` が前面化を拒否され、別ウィンドウを撮ってしまう）。

```bash
# Tauri アプリを起動して撮る
docker compose run --rm dev bash -c 'bash scripts/demo-repo.sh /tmp/demo && bash scripts/screenshot.sh /tmp/demo /app/screenshot.png'

# ブラウザプレビューを撮る
docker compose run --rm dev bash -c 'bash scripts/demo-repo.sh /tmp/demo && bash scripts/screenshot-browser.sh /tmp/demo'
```

クリック操作を伴う確認は `xdotool`（イメージに同梱）を使う。日本語の入力はできないので
入力を伴うテストは ASCII で行う。

## アーキテクチャ

```
src/api.ts ──┬─ Tauri あり → invoke() → src-tauri/src/lib.rs → src-tauri/src/git.rs（libgit2）
             └─ Tauri なし → fetch()  → scripts/dev-git-api.mjs（vite ミドルウェア、git コマンド）
```

`window.__TAURI_INTERNALS__` の有無で切り替える。ブラウザ時はツールバーに
「ブラウザプレビュー」と表示される。

| パス | 役割 |
|------|------|
| `src-tauri/src/git.rs` | libgit2 でのリポジトリ読み取り。全ロジックとテストがここ |
| `src-tauri/src/lib.rs` | Tauri コマンドの登録、トレイ、ウィンドウイベント |
| `src/api.ts` | Tauri / ブラウザの呼び分け |
| `src/graph/lanes.ts` | コミット列 → レーン配置 |
| `src/components/GraphCell.tsx` | 1 コミット分のグラフを SVG で描画 |
| `scripts/dev-git-api.mjs` | ブラウザプレビュー用の開発 API |
| `scripts/check-lanes.mjs` | レーン配置の不変条件検査 |
| `scripts/demo-repo.sh` | 確認用デモリポジトリの生成 |

## Tauri コマンド一覧

| コマンド | 引数 | 返り値 |
|---------|------|--------|
| `open_repository` | `path` | `RepoInfo` |
| `list_commits` | `path`, `limit`(既定 500) | `CommitInfo[]` |
| `list_branches` | `path` | `BranchInfo[]` |
| `list_worktrees` | `path` | `WorktreeInfo[]` |
| `diff_summary` | `path`, `from?`, `to?` | `DiffSummary` |
| `file_diff` | `path`, `from?`, `to?`, `file` | `FileDiff` |
| `set_branch_description` | `path`, `branch`, `description?` | `()` |
| `repo_fingerprint` | `path` | `RepoFingerprint` |
| `worktree_change_count` | `path` | `usize` |
| `load_settings` | なし | `Settings` |
| `save_settings` | `settings` | `()` |
| `startup_repository` | なし | `String?` |

型は `src-tauri/src/git.rs`・`src-tauri/src/settings.rs` と `src/types.ts` が 1 対 1 で
対応する（serde の camelCase）。

## 仕様の詳細

### コミットの取得

全 ref（`refs/heads` / `refs/remotes` / `refs/tags` / HEAD）から到達できるコミットを
`Sort::TOPOLOGICAL | Sort::TIME` で辿る。既定 500 件まで。

### レーン配置（`src/graph/lanes.ts`）

各レーンは「次にそのレーンへ現れるべきコミット ID」を保持する。1 コミットごとに、

1. そのコミットを待っていたレーンを探してノードを置く（最左。無ければ空きレーン）
2. 待っていたレーンをすべて解放する（合流 = `mergeIn`）
3. 親を待つレーンとして再確保する（分岐 = `forkOut`）。第一親は同じレーンを引き継ぐ
4. 第一親が既に右のレーンで待たれている場合は左へ詰め替える（`relocations`）

4 があるため幹が右へ流れず、`git log --graph` と同じ列配置になる。
描画は行ごとに独立した SVG で、行の上半分（合流）と下半分（分岐）を描く。

`scripts/check-lanes.mjs` が 7 つの不変条件を検査する。レーン周りを触ったら必ず流す。

### 差分の比較基準

`from` / `to` の組み合わせで表す。

| 指定 | 比較内容 |
|------|---------|
| `to` 省略 | 作業ツリー vs `from`（省略時 HEAD）。未追跡ファイルも含む |
| `from` 省略 | `to` の第一親 vs `to`（= そのコミットの変更内容） |
| 両方指定 | 任意の 2 コミット間 |

- マージコミットは第一親と比較し、`againstFirstParent` を立てて UI に注記する
- ルートコミットは空ツリーとの比較になる
- バイナリは行数を数えず `isBinary` を立てる
- 1 ファイル 4000 行（`MAX_DIFF_LINES`）で打ち切り `truncated` を返す
- 差分行の末尾は改行だけを落とす。行末の空白自体に意味があるため `trim_end` は使わない

### 自動更新

`repo_fingerprint`（全 ref のダイジェスト + ワークツリー数）を 5 秒ごとに比べ、
変わったときだけ読み直す。選択中のコミットは維持する。
`document.visibilityState` が `hidden` の間は止める。

**指紋に作業ツリーの状態は含めない。** `statuses()` 相当の走査は大きいリポジトリで重く、
数秒ごとに回すには向かないため。未コミットの変更の件数だけ 15 秒間隔で別に取り直す。
件数は `worktree_change_count`（status の件数だけ。増減行数は計算しない）で取る。
`diff_summary` を定期的に呼ぶと変更ファイルごとに差分を計算してしまい重い。

指紋の `refs` ダイジェストにワークツリー数は混ぜない。ワークツリーの増減だけなら
コミットは変わらないので、フロントはブランチとワークツリーの一覧だけ取り直す。

### パフォーマンス上の決まり

- **ahead/behind はプロセス内でキャッシュする**（`git.rs` の `ahead_behind`）。
  キーは (ブランチ先端, 基準) の Oid ペア。ブランチが多いリポジトリでは
  1 本ごとの履歴走査が一覧取得で一番重く、自動更新のたびに同じ計算をしていた
- **コミット一覧は仮想スクロール**（`CommitList.tsx`）。行の高さが `ROW_HEIGHT` 固定で
  あることに依存している。行の高さを可変にするなら仮想化も作り直す。
  特定の行へ飛ぶときは DOM を探さず `CommitListHandle.scrollToCommit` を使う
  （描いていない行は DOM に無い）
- ブランチのメモは `config_snapshot` で 1 回だけ設定を開いて読む。ブランチごとに
  `repo.config()` を開き直さない

ブランチのメモを変更しても ref は変わらないので指紋では検知できない。
保存後にフロント側で明示的に一覧を取り直している。

### ブランチのメモ

実体は git 標準の `branch.<name>.description`。

- 書き込み先は `ConfigLevel::Local`（リポジトリ配下の `.git/config`）に限定
- キーは `branch.<name>.description` に固定。任意の設定は書けない
- ローカルブランチの存在を確認してから書く（リモート追跡ブランチは弾く）
- 空文字・空白だけの値は「未設定」として削除する

### 設定ファイル

`src-tauri/src/settings.rs`。保存先は Tauri の `app_config_dir()`
（Windows では `%APPDATA%\jp.asuzacgroup.gitgraph\settings.json`）。

- 「消えると困る」設定（テーマ、今後の登録リポジトリ・マージ基準）はここに入れる。
  サイドバー幅や前回のリポジトリのような軽い UI 状態は localStorage のまま
- 項目は必ず `#[serde(default)]` で足す。古い版のファイルにも、新しい版のファイルにも
  耐えるため。知らない項目は読み飛ばす
- 壊れたファイルはエラーにする。既定値で黙って上書きしない（利用者の編集を消さない）
- 一時ファイルに書いてから rename で置き換える
- ブラウザプレビューでは OS の一時フォルダの `git-graph-dev-settings.json` に書く

### テーマ

配色は `src/App.css` 先頭の CSS 変数で、`<html data-theme="light|dark|custom">` で
切り替える。`src/theme.ts` の `applyTheme` が設定から属性を決める。

- 「OS に従う」は JS が `prefers-color-scheme` を見て light / dark に解決し、変更も監視する。
  CSS の `@media` は属性が無い（設定を読む前の）ときだけの保険
- カスタムは基調色 1 色から `derivePalette` で派生させ、インラインの CSS 変数で上書きする。
  文字色は基調色とコントラストが高い方（白系 / 黒系）、アクセント色は固定の青で、
  背景とのコントラストが 3 を切るときだけ文字色側へ寄せる
- 解決した結果を localStorage（`git-graph:theme-resolved`）に控え、`index.html` の
  先頭スクリプトが React より先に当てる。設定ファイルを待つ間のちらつき防止。
  キー名を変えるときは両方直す
- レーン色やバッジ色（緑・赤・橙・紫）はテーマで変えない。意味を持つ色なので
  全テーマで同じにしてある

### タスクトレイ

× ではアプリを終了せずウィンドウを隠す。復帰はトレイアイコンの左クリック、
終了はトレイメニューから。

トレイを作れない環境（Linux でトレイホストが無い等）では作成失敗を致命的にせず、
その場合は `tray_by_id("main")` が `None` になるので × で通常どおり終了する。
閉じられなくなるのを避けるため。

### インストール先

NSIS の `installMode` は `perMachine`（v1.3.0 から）。`C:\Program Files\Git Graph` に入り、
インストールと自動更新のたびに UAC が出る。利用者は管理者権限を持っている前提。

v1.2.x 以前は既定の `currentUser`（`%LOCALAPPDATA%\Git Graph`）に入っていた。
モードが違うとインストーラは旧版を消さず、2 つ並ぶ。移行は利用者に旧版を手で
アンインストールしてもらう方針で、リリース本文で案内している。
`installMode` を変えるとまた同じ問題が起きるので、安易に戻さないこと。

### アイコン

元データは `src-tauri/icons/source.svg`（コミットグラフの図柄、レーン色）。
直すときは SVG を編集して `npx tauri icon src-tauri/icons/source.svg` で一式を作り直す。
`android/`・`ios/`・`64x64.png` も生成されるが使わないので消す。
ファビコン `public/favicon.svg` は同じ SVG のコピーなので合わせて更新する。

### 自動更新（アプリ本体）

`tauri-plugin-updater` を使い、Gitea のリリースから新しい版を取得する。

- 更新情報は main ブランチの `latest.json`。raw URL で配信するのでタグに依存しない
  （`http://gitea.asuzacfoods.jp/asuzacfoods/Git-Graph/raw/branch/main/latest.json`）
- 署名検証は必須。公開鍵は `tauri.conf.json` の `plugins.updater.pubkey`
- **秘密鍵は `~/.tauri/git-graph-updater.key`。リポジトリには入っていない**。
  失うと以降の更新を配信できなくなるのでバックアップすること
- 起動時に確認し、見つかったら通知バナーを出す。適用は利用者が押したときだけ。
  作業中に勝手に再起動させないため
- 更新サーバに届かない場合は黙って無視する（使えなくなる方が困るため）
- **`dangerousInsecureTransportProtocol` を有効にしている。** Gitea が HTTP のため。
  この指定が無いと updater は起動時に panic する（ビルドは通るので気付きにくい）。
  インストーラは署名検証されるため任意コードの注入はできないが、経路上の攻撃者は
  更新の阻止と古い版への誘導ができる。Gitea を HTTPS 化したらこの指定は外すこと。
- 組織 `asuzacfoods` を public にしたことで匿名取得できる。internal のままだと
  認証が必要になり、トークンをアプリに埋め込む羽目になるので戻してはいけない

## 落とし穴

- **PowerShell に `\` 行継続のコマンドを渡さない。** 利用者は PowerShell を使う。
  `\` は引数として渡り、docker では tini が `\` を実行しようとして落ちる。
  コマンド例は 1 行で書く。
- **Git Bash から `/app` などの絶対パスを渡すときは `MSYS_NO_PATHCONV=1`。**
  付けないと `C:/Program Files/Git/app` に変換される。
- **ファイルを書くときは改行を LF に保つ。** CRLF になると Linux コンテナの bash が
  `set -o pipefail` を解釈できず「pipefail: invalid option name」で落ちる。
- **`git log ... | head` を `set -o pipefail` 下で使わない。** SIGPIPE で
  スクリプト全体が失敗する。`-n` を使う。
- **git2 0.21 の戻り値に注意。** `Reference::shorthand()` と `Reference::name()` は
  `Result`、`Commit::summary()` と `Branch::name()` は `Result<Option<&str>>`、
  `StringArray::iter()` は `Result<Option<&str>>` を返す（flatten が 2 段必要）。

## リリース手順

Gitea（`gitea` リモート）に公開している。自動更新のため組織ごと public にしてあり、
匿名でリリース資産を取得できる。GitHub（`origin`）にも同じソースがある。

```powershell
# 1. バージョンを更新（package.json / package-lock.json / Cargo.toml / tauri.conf.json）

# 2. 署名付きでビルド。鍵を渡さないと .sig が出ず、自動更新が配信できない
$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\git-graph-updater.key"
npx tauri build --bundles nsis

# 3. タグを作って push
git tag -a v1.2.0 -F <メッセージファイル>
git push gitea main; git push gitea v1.2.0

# 4. リリース作成（tea CLI）
tea releases create --login asuzac --repo asuzacfoods/Git-Graph --tag v1.2.0 --title "..." --note-file <本文> --asset "src-tauri/target/release/bundle/nsis/Git Graph_1.2.0_x64-setup.exe"

# 5. 更新情報を作って push。これをしないと既存の利用者に更新が届かない
node scripts/make-latest-json.mjs 1.2.0 <本文>
git add latest.json; git commit -m "latest.json を v1.2.0 に更新"; git push gitea main
```

`latest.json` は main ブランチにある必要がある。手順 5 を忘れるとリリースはできても
自動更新だけ動かない状態になる。

MSI は現在ビルドできない。`bundle/msi/` の古いファイルがロックされており、
上書き・削除がアクセス拒否になる。再起動して削除すれば復旧する見込み。
