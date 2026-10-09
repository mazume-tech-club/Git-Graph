import type {
  BranchInfo,
  Commit,
  DiffSummary,
  FileDiff,
  RepoFingerprint,
  RepoInfo,
  Settings,
  WorktreeInfo,
} from "./types";

/**
 * Tauri と、ブラウザでの開発プレビューの両方から同じ形で呼べるようにした層。
 *
 * Tauri の WebView では `invoke` で Rust を呼ぶ。ブラウザ（`npm run dev` に
 * 直接アクセスした場合）では Vite の開発サーバが `git` を叩いて同じ JSON を返す。
 */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

async function fetchDev<T>(command: string, params: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`/__git/${command}${query ? `?${query}` : ""}`);
  const payload = await res.json();
  if (!res.ok) throw new Error(payload?.error ?? `${command} に失敗しました`);
  return payload as T;
}

export function isBrowserPreview(): boolean {
  return !isTauri;
}

export async function startupRepository(): Promise<string | null> {
  return isTauri
    ? invokeTauri<string | null>("startup_repository")
    : fetchDev<string | null>("startup_repository");
}

export async function openRepository(path: string): Promise<RepoInfo> {
  return isTauri
    ? invokeTauri<RepoInfo>("open_repository", { path })
    : fetchDev<RepoInfo>("open_repository", { path });
}

export async function listCommits(path: string, limit: number): Promise<Commit[]> {
  return isTauri
    ? invokeTauri<Commit[]>("list_commits", { path, limit })
    : fetchDev<Commit[]>("list_commits", { path, limit: String(limit) });
}

export async function listBranches(path: string): Promise<BranchInfo[]> {
  return isTauri
    ? invokeTauri<BranchInfo[]>("list_branches", { path })
    : fetchDev<BranchInfo[]>("list_branches", { path });
}

export async function listWorktrees(path: string): Promise<WorktreeInfo[]> {
  return isTauri
    ? invokeTauri<WorktreeInfo[]>("list_worktrees", { path })
    : fetchDev<WorktreeInfo[]>("list_worktrees", { path });
}

/**
 * 変更されたファイルの一覧。
 *
 * `to` を省略すると作業ツリーとの比較、`from` を省略すると `to` の第一親との比較。
 * 両方指定すれば任意の 2 コミット間を比較できる。
 */
export async function diffSummary(
  path: string,
  from: string | null,
  to: string | null,
): Promise<DiffSummary> {
  return isTauri
    ? invokeTauri<DiffSummary>("diff_summary", { path, from, to })
    : fetchDev<DiffSummary>("diff_summary", optional({ path, from, to }));
}

/** 1 ファイル分の差分。範囲の指定方法は diffSummary と同じ。 */
export async function fileDiff(
  path: string,
  from: string | null,
  to: string | null,
  file: string,
): Promise<FileDiff> {
  return isTauri
    ? invokeTauri<FileDiff>("file_diff", { path, from, to, file })
    : fetchDev<FileDiff>("file_diff", optional({ path, from, to, file }));
}

/**
 * ブランチの説明を設定する。null または空文字で設定を消す。
 *
 * ref は変わらないため自動更新の指紋では検知できない。
 * 呼び出し側で一覧を取り直すこと。
 */
export async function setBranchDescription(
  path: string,
  branch: string,
  description: string | null,
): Promise<void> {
  if (isTauri) {
    await invokeTauri<void>("set_branch_description", { path, branch, description });
    return;
  }
  await fetchDev<{ ok: boolean }>(
    "set_branch_description",
    optional({ path, branch, description: description ?? "" }),
  );
}

/** 変化の検知に使う軽い指紋。定期的に呼ぶ。 */
export async function repoFingerprint(path: string): Promise<RepoFingerprint> {
  return isTauri
    ? invokeTauri<RepoFingerprint>("repo_fingerprint", { path })
    : fetchDev<RepoFingerprint>("repo_fingerprint", { path });
}

/**
 * 作業ツリーで変更されているファイルの数（未追跡を含む）。
 * 差分の中身は計算しないので、定期的に呼んでも軽い。
 */
export async function worktreeChangeCount(path: string): Promise<number> {
  return isTauri
    ? invokeTauri<number>("worktree_change_count", { path })
    : fetchDev<number>("worktree_change_count", { path });
}

/** null のクエリパラメータは送らない（Rust 側の Option に合わせる） */
function optional(params: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== null && v !== ""),
  ) as Record<string, string>;
}

/** リポジトリを選ばせる。ブラウザではフォルダ選択が使えないのでパスを入力してもらう */
export async function pickRepository(current: string | null): Promise<string | null> {
  if (!isTauri) {
    return window.prompt("リポジトリのパスを入力してください", current ?? "") || null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    multiple: false,
    title: "リポジトリを選択",
    defaultPath: current ?? undefined,
  });
  return typeof selected === "string" ? selected : null;
}

/** 設定を読む。ファイルが無ければ既定値が返る。壊れていればエラー */
export async function loadSettings(): Promise<Settings> {
  return isTauri ? invokeTauri<Settings>("load_settings") : fetchDev<Settings>("load_settings");
}

/** 設定を書く。全体を渡して丸ごと置き換える */
export async function saveSettings(settings: Settings): Promise<void> {
  if (isTauri) {
    await invokeTauri<void>("save_settings", { settings });
    return;
  }
  await fetchDev<{ ok: boolean }>("save_settings", { json: JSON.stringify(settings) });
}
