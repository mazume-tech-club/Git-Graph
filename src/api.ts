import type { BranchInfo, Commit, RepoInfo, WorktreeInfo } from "./types";

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
