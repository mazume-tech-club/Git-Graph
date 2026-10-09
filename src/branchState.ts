import type { BranchInfo, WorktreeChanges } from "./types";

/**
 * ブランチの主状態。1 本につき 1 つだけ付き、一覧のグループ分けに使う。
 *
 * - working … ワークツリーで開かれていて、そのワークツリーに未コミット変更がある
 * - unmerged … マージ基準に取り込まれていないコミットがある
 * - merged … 全コミットがマージ基準に取り込まれている（削除候補）
 *
 * 「作業中」を未コミット変更ありに限定しているのは、開いたまま放置したものと
 * 本当に手を動かしているものを区別するため。開いているだけのブランチは WT バッジで分かる。
 */
export type BranchState = "working" | "unmerged" | "merged";

export const STATE_ORDER: BranchState[] = ["working", "unmerged", "merged"];

export const STATE_LABEL: Record<BranchState, string> = {
  working: "作業中",
  unmerged: "未マージ",
  merged: "マージ済み",
};

/** ワークツリーのパス → 未コミット変更の件数 */
export function changesByPath(changes: WorktreeChanges[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of changes) {
    map.set(normalizePath(c.path), c.changes ?? 0);
  }
  return map;
}

export function branchState(branch: BranchInfo, dirty: Map<string, number>): BranchState {
  if (branch.worktreePath && (dirty.get(normalizePath(branch.worktreePath)) ?? 0) > 0) {
    return "working";
  }
  return branch.merged ? "merged" : "unmerged";
}

/** Windows の区切り文字や末尾の区切りの違いを吸収して比較する */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
