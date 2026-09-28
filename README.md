# Git Graph

Git のコミットグラフを可視化するデスクトップアプリ。Tauri v2 + React + TypeScript。

## 必要なもの

Docker があれば、ホストに Rust / Node を入れなくてもビルドできる。

- Docker（Compose v2 以降）

ホストで直接ビルドする場合のみ、Node.js 20 以降と Rust ツールチェーン
（[rustup](https://rustup.rs/)）が必要。Windows では MSVC ビルドツール
（"Desktop development with C++"）も要る。

## 開発（Docker）

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
docker compose run --rm dev bash -c   'bash scripts/demo-repo.sh /tmp/demo && bash scripts/screenshot.sh /tmp/demo /app/screenshot.png'

# 手元のリポジトリを見たいとき（ホストのパスをマウントする）
docker compose run --rm -v C:/path/to/repo:/repos/target:ro dev   bash scripts/screenshot.sh /repos/target /app/screenshot.png
```

バインドマウント経由のリポジトリは読み込みに時間がかかる。撮影前の待ち時間は
`WAIT_SECONDS`（既定 12 秒）で延ばせる。

アプリは第 1 引数にリポジトリのパスを取る（`git-graph <path>`）。
指定が無ければ前回開いたリポジトリを復元する。

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

## 構成

| パス | 役割 |
|------|------|
| `src-tauri/src/git.rs` | libgit2 でリポジトリを読み、コミット・ref を取得する |
| `src-tauri/src/lib.rs` | Tauri コマンド（`open_repository` / `list_commits`）の定義 |
| `src/graph/lanes.ts` | コミット列からレーン（縦の列）配置を組み立てる |
| `src/components/GraphCell.tsx` | 1 コミット分のグラフを SVG で描画する |
| `src/components/CommitList.tsx` | グラフ + コミット一覧の行 |
| `src/components/CommitDetail.tsx` | 選択したコミットの詳細 |
| `scripts/check-lanes.mjs` | レーン配置の検証スクリプト |
| `scripts/screenshot.sh` | 仮想ディスプレイ上で起動してスクリーンショットを撮る |
| `scripts/demo-repo.sh` | 表示確認用のデモリポジトリを作る |
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

## 現状の制限

- 読み取り専用。チェックアウトやコミットなどの操作は未実装
- 表示は最新 500 件まで（`src/App.tsx` の `COMMIT_LIMIT`）
- 差分表示は未実装
