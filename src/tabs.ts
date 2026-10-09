import { normalizePath } from "./branchState";

/**
 * タブ。1 つのタブは 1 つのビューを持つ。
 *
 * - home … 登録リポジトリの一覧。先頭に固定で閉じられない
 * - worktree … ワークツリービュー。そのワークツリーの HEAD と未コミット変更を基準に見る
 * - branch … ブランチビュー。そのブランチから辿れるコミットだけに絞る
 */
/** タブの中身の指定。id を持たない形で、開くときに渡す */
export type TabSpec =
  | { kind: "home" }
  | { kind: "worktree"; path: string }
  | { kind: "branch"; path: string; branch: string };

export type Tab = TabSpec & { id: string };

export type RepoTab = Exclude<Tab, { kind: "home" }>;
export type RepoTabSpec = Exclude<TabSpec, { kind: "home" }>;

export const HOME_TAB: Tab = { id: "home", kind: "home" };

/** 開いているタブの控え。再起動時に復元する（軽い UI 状態なので localStorage） */
const TABS_KEY = "git-graph:tabs";

type Stored = { tabs: RepoTabSpec[]; active: number };

let counter = 0;
export function newTabId(): string {
  counter += 1;
  return `tab-${Date.now().toString(36)}-${counter}`;
}

/** 同じビューを指すタブか（同じワークツリー、または同じリポジトリの同じブランチ） */
export function sameView(a: Tab, b: Tab): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "home" || b.kind === "home") return true;
  if (normalizePath(a.path) !== normalizePath(b.path)) return false;
  return a.kind === "branch" && b.kind === "branch" ? a.branch === b.branch : true;
}

export function tabLabel(tab: Tab): string {
  if (tab.kind === "home") return "ホーム";
  const name = tab.path.split(/[\\/]/).filter(Boolean).pop() ?? tab.path;
  return tab.kind === "branch" ? `${name} › ${tab.branch}` : name;
}

export function tabTitle(tab: Tab): string {
  if (tab.kind === "home") return "登録リポジトリの一覧";
  return tab.kind === "branch" ? `${tab.path} のブランチ ${tab.branch}` : tab.path;
}

export function loadStoredTabs(): { tabs: Tab[]; activeId: string } {
  const fallback = { tabs: [HOME_TAB], activeId: HOME_TAB.id };
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return fallback;
    const stored = JSON.parse(raw) as Stored;
    if (!Array.isArray(stored.tabs)) return fallback;
    const tabs: Tab[] = [HOME_TAB];
    for (const t of stored.tabs) {
      if (t.kind === "worktree" && typeof t.path === "string") {
        tabs.push({ id: newTabId(), kind: "worktree", path: t.path });
      } else if (t.kind === "branch" && typeof t.path === "string" && typeof t.branch === "string") {
        tabs.push({ id: newTabId(), kind: "branch", path: t.path, branch: t.branch });
      }
    }
    const active = tabs[Number(stored.active)] ?? HOME_TAB;
    return { tabs, activeId: active.id };
  } catch {
    return fallback;
  }
}

export function storeTabs(tabs: Tab[], activeId: string): void {
  const stored: Stored = {
    tabs: tabs
      .filter((t): t is RepoTab => t.kind !== "home")
      .map((t) => (t.kind === "branch" ? { kind: t.kind, path: t.path, branch: t.branch } : { kind: t.kind, path: t.path })),
    active: Math.max(0, tabs.findIndex((t) => t.id === activeId)),
  };
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(stored));
  } catch {
    // 保存できなくても動作には影響しない
  }
}
