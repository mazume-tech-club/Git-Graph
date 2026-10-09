# Git Graph

Git のコミットグラフを可視化するデスクトップアプリ。Tauri v2 + React + TypeScript。

## できること

- コミットグラフの表示（`git log --graph` と同じ列配置）
- ブランチ一覧。作業中（ワークツリーで開いていて未コミット変更がある）/ 未マージ /
  マージ済み（削除候補）に分けて出すので、並行して進めている作業と放置されたブランチが
  見分けやすい。未 push のブランチにはバッジが付く
- 「取り込み済み」の判定相手（マージ基準）は main / master / develop を自動で探す。
  一覧の「基準」から変えられ、リポジトリごとに記憶する
- ブランチを選ぶと、マージ基準に無い変更（共通祖先からの差分）をファイル単位で見られる。
  メモが無くても「このブランチで何を作っていたか」が分かる
- ワークツリー一覧。どのパスでどのブランチを開いているか、ロックや prune 対象かが分かる
- ブランチ / ワークツリーの用途を行内に表示・編集。一覧から直接メモを書ける。
  メモが無いブランチには最後のコミットメッセージを出す
- 差分表示（ユニファイド）。コミットの変更内容、未コミットの変更、
  任意の 2 コミット間を比較できる
- ref の変化を 5 秒ごとに見て自動で読み直す（手動の再読み込みは不要）
- 新しいバージョンが出ていると起動時に通知し、その場で更新できる
- ウィンドウを × で閉じるとタスクトレイに格納される。トレイアイコンの左クリックで
  復帰、右クリックのメニューから終了できる
- テーマはツールバー右端の ⚙ から変えられる。ライト / ダーク / OS に従う のほか、
  基調色を 1 色選ぶと他の色をそこから決めるカスタムがある

読み取り専用で、チェックアウトやコミットなどの操作は行わない。

## 必要なもの

Docker があれば、ホストに Rust / Node を入れなくてもビルドできる。

- Docker（Compose v2 以降）

ホストで直接ビルドする場合のみ、Node.js 20 以降と Rust ツールチェーン
（[rustup](https://rustup.rs/)）が必要。Windows では MSVC ビルドツール
（"Desktop development with C++"）も要る。

## 開発（Docker）

コマンドは 1 行で書いてある。PowerShell では `\` が行継続にならないので、
改行して貼り付けるとそのまま失敗する（継続したいときはバッククォートを使う）。

```bash
docker compose build                            # イメージの作成（初回のみ）
docker compose run --rm dev npm ci              # 依存の取得（初回のみ）
docker compose run --rm dev npm run build       # フロントエンドの型チェック + ビルド
docker compose run --rm dev npm run rust:check  # Rust のコンパイルチェック
docker compose run --rm dev npm run rust:clippy # Rust の lint
docker compose run --rm dev bash                # コンテナ内のシェル
```

`node_modules` と `src-tauri/target` はコンテナ専用の名前付きボリュームに置いている。
ホスト側の `node_modules`（Windows 向けバイナリ）と混ざらないので、
ホストとコンテナを併用しても壊れない。

### GUI の表示確認

コンテナには GUI が無いが、仮想ディスプレイ（Xvfb）上で起動してスクリーンショットを
撮れる。ホストに Rust を入れなくても表示を確認できる。

```bash
# 確認用のデモリポジトリ（ブランチ・マージ・タグ入り）を作ってから撮る
docker compose run --rm dev bash -c 'bash scripts/demo-repo.sh /tmp/demo && bash scripts/screenshot.sh /tmp/demo /app/screenshot.png'

# 手元のリポジトリを見たいとき（ホストのパスをマウントする）
docker compose run --rm -v C:/path/to/repo:/repos/target:ro dev bash scripts/screenshot.sh /repos/target /app/screenshot.png
```

バインドマウント経由のリポジトリは読み込みに時間がかかる。撮影前の待ち時間は
`WAIT_SECONDS`（既定 12 秒）で延ばせる。

アプリは第 1 引数にリポジトリのパスを取る（`git-graph <path>`）。
指定が無ければ前回開いたリポジトリを復元する。

### ブラウザでの表示確認

Tauri を起動しなくても、ブラウザだけで UI を確認できる。Vite の開発サーバに
Tauri コマンドと同じ JSON を返す API（`scripts/dev-git-api.mjs`）を組み込んであり、
`src/api.ts` が Tauri と自動で切り替える。ホットリロードが効くので UI の調整が速い。

```bash
# コンテナで開発サーバを起動する。ホスト側の http://localhost:1430 を開く
# （コンテナ内は 1420。止めるときは Ctrl+C）
docker compose run --rm --service-ports -e GIT_GRAPH_REPO=/tmp/demo dev bash -c 'bash scripts/demo-repo.sh /tmp/demo && npm run dev:browser'

# ブラウザも用意できないときは、コンテナ内の WebKit で開いて撮る
docker compose run --rm dev bash -c 'bash scripts/demo-repo.sh /tmp/demo && bash scripts/screenshot-browser.sh /tmp/demo'
```

ホストで直接動かす場合は `GIT_GRAPH_REPO=C:/path/to/repo npm run dev` で
http://localhost:1420 を開く。開くリポジトリは環境変数 `GIT_GRAPH_REPO` か、
画面の「リポジトリを開く」（ブラウザではパス入力）で指定する。

ブラウザプレビューの Git 読み取りは `git` コマンドを呼ぶ簡易版で、コミットの
並び順が Tauri 版（libgit2）と細かく異なる。**仕様の正は Rust 側**にあるので、
表示が食い違ったら Rust 側の結果を信じること。

### 制限

コンテナは Linux なので、**Windows 向けの実行ファイルは作れない**。
`docker compose run --rm dev npx tauri build` で作れるのは Linux 版（deb / AppImage）。
Windows の `.exe` / インストーラが要るときは、ホストに Rust を入れて
`npm run tauri build` を実行する。

## 開発（ホスト）

```bash
npm install
npm run tauri dev     # アプリを起動（GUI が要るのでホストで実行する）
npm run build         # フロントエンドの型チェック + ビルド
npm run check:lanes   # レーン配置の検証（引数にリポジトリのパスを渡す）
npm run tauri build   # 配布用ビルド
```

`check:lanes` は実際の Git 履歴を読み込んでレーン配置の不変条件を検査する。
`SHOW_GRAPH=1` を付けると ASCII のグラフも出力するので、
`git log --graph --oneline --all --topo-order` と見比べられる。

```bash
SHOW_GRAPH=1 node scripts/check-lanes.mjs ../some-repo
```

## Windows 用 exe を作る

コンテナは Linux なので exe は作れない。ホストに Rust と MSVC ビルドツールを入れる。
WebView2 ランタイムは Windows 11 に同梱されているので追加導入は不要。

### 1. ツールチェーンを入れる（初回のみ）

```powershell
winget install --id Rustlang.Rustup -e
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621 --includeRecommended"
```

入れ終わったらターミナルを開き直す（PATH を反映させるため）。
`rustup --version` と `cargo --version` が通れば準備完了。

### 2. ビルドする

```powershell
npm install
npm run tauri build
```

`npm install` はホスト側の `node_modules` を作る（コンテナ側とは別物なので両方必要）。

### 3. 出力

| パス | 内容 |
|------|------|
| `src-tauri/target/release/git-graph.exe` | 単体の実行ファイル |
| `src-tauri/target/release/bundle/nsis/*.exe` | インストーラ |
| `src-tauri/target/release/bundle/msi/*.msi` | MSI パッケージ |

単体 exe は WebView2 ランタイムがある環境ならコピーするだけで動く。
MSI のビルドで失敗する場合は NSIS だけに絞れる。

```powershell
npm run tauri build -- --bundles nsis
```

初回ビルドは Rust の依存を全てコンパイルするので 10 分前後かかる。
2 回目以降はインクリメンタルで数十秒になる。

なお、リリースプロファイル（LTO・`panic = "abort"`）でのコンパイルと
`tauri build` のパイプラインは Linux コンテナで検証済み。ホストで失敗する場合は
ツールチェーン側の問題を疑うとよい。

## 仕様・開発メモ

コマンドの一覧、レーン配置の考え方、差分の比較基準、自動更新の仕組みなど、
実装の詳細は [`CLAUDE.md`](CLAUDE.md) にまとめてある。

## 構成

| パス | 役割 |
|------|------|
| `src-tauri/src/git.rs` | libgit2 でリポジトリを読み、コミット・ref を取得する |
| `src-tauri/src/lib.rs` | Tauri コマンド（`open_repository` / `list_commits`）の定義 |
| `src/graph/lanes.ts` | コミット列からレーン（縦の列）配置を組み立てる |
| `src/components/GraphCell.tsx` | 1 コミット分のグラフを SVG で描画する |
| `src/components/CommitList.tsx` | グラフ + コミット一覧の行 |
| `src/components/CommitDetail.tsx` | 選択したコミットの詳細と差分 |
| `src/components/Sidebar.tsx` | 右サイドバーのタブ切り替え |
| `src/components/BranchList.tsx` | ブランチ一覧（未マージ・放置の表示） |
| `src/components/WorktreeList.tsx` | ワークツリー一覧 |
| `src/components/DiffPane.tsx` | 変更ファイル一覧とユニファイド差分 |
| `scripts/check-lanes.mjs` | レーン配置の検証スクリプト |
| `scripts/screenshot.sh` | 仮想ディスプレイ上で起動してスクリーンショットを撮る |
| `scripts/screenshot-browser.sh` | ブラウザプレビューを WebKit で開いて撮る |
| `scripts/demo-repo.sh` | 表示確認用のデモリポジトリを作る |
| `scripts/dev-git-api.mjs` | ブラウザプレビュー用の開発 API（`git` を呼ぶ簡易版） |
| `src/api.ts` | Tauri とブラウザプレビューの呼び分け |
| `docker/Dockerfile` | Rust + Node + Tauri の依存を入れた開発用イメージ |
| `compose.yml` | 開発コンテナの定義 |

### レーン配置の考え方

各レーンは「次にそのレーンへ現れるべきコミット ID」を保持する。
コミットを 1 件処理するたびに、

1. そのコミットを待っていたレーンを探してノードを置く（最左のレーン。無ければ空きレーン）
2. 待っていたレーンをすべて解放する（= 合流、`mergeIn`）
3. 親コミットを待つレーンとして再確保する（= 分岐、`forkOut`）。第一親は同じレーンを引き継ぐ
4. 第一親が既に右のレーンで待たれている場合は左へ詰め替える（`relocations`）

を行う。4 があるため、幹のレーンが右へ流れていかず `git log --graph` と同じ列配置になる。
描画は行ごとに独立した SVG を持たせ、行の上半分（合流）と下半分（分岐）を描く。

### ブランチのメモ

ブランチが増えて用途が分からなくなったとき用に、1 行のメモを付けられる。
一覧の行にマウスを乗せると出る `✎` を押すとその場で入力できる。
Enter で保存、Esc で取り消し、空にして保存すると削除。

実体は git 標準の `branch.<name>.description` なので、コマンドからも読み書きできる。

```bash
git config branch.feature/foo.description "詳細ペインの作業用"
git branch --edit-description feature/foo   # エディタが開く
```

メモが無いブランチには最後のコミットメッセージを出すので、付けていなくても
手がかりにはなる。メモ付きの行は色と `✎` で区別している。
ワークツリーには、そこで開いているブランチのメモが付く。

書き込むのはリポジトリ配下の `.git/config` だけで、履歴には触れない。
キーは `branch.<name>.description` に固定しており、任意の設定は書けない。

### 自動更新の仕組み

`repo_fingerprint` が返す「全 ref のダイジェスト + ワークツリー数」を 5 秒ごとに
比べ、変わったときだけ読み直す。選択中のコミットは維持される
（消えていた場合は先頭に戻る）。画面が隠れている間はポーリングを止める。

ツールバーの「確認 HH:MM:SS」は最後に変化を確認できた時刻で、変化の有無に
関わらず 5 秒ごとに進む。止まっていればポーリングが動いていないと分かる。

指紋に**作業ツリーの状態は含めない**。`git status` 相当の走査は大きいリポジトリで
重く、数秒ごとに回すには向かないため。未コミットの変更の件数だけ 15 秒間隔で
別に取り直している。

## 現状の制限

- ブランチのメモ以外は読み取り専用。チェックアウトやコミットなどの操作は未実装
- 表示は最新 500 件まで（`src/App.tsx` の `COMMIT_LIMIT`）
- 差分は 1 ファイル 4000 行で打ち切る（`src-tauri/src/git.rs` の `MAX_DIFF_LINES`）
- 差分はユニファイド表示のみ。サイドバイサイドは未実装
- タスクトレイを作れない環境（Linux でトレイホストが無い等）では、
  × で閉じられなくなるのを避けるため通常どおり終了する
