import { normalizePath } from "../branchState";
import { formatAge } from "../format";
import type { WorktreeInfo } from "../types";

type Props = {
  worktrees: WorktreeInfo[];
  /** ワークツリーのパス → 未コミット変更の件数 */
  dirty: Map<string, number>;
  onSelect: (commitId: string) => void;
  /** ワークツリービューを新しいタブで開く */
  onOpenTab: (path: string) => void;
};

/** ワークツリー一覧。どのパスでどのブランチを開いていて、手を付けているかを一覧にする。 */
export function WorktreeList({ worktrees, dirty, onSelect, onOpenTab }: Props) {
  if (worktrees.length === 0) {
    return <p className="panel-empty">ワークツリーがありません。</p>;
  }

  return (
    <div className="panel">
      <ul className="panel-list">
        {worktrees.map((wt) => {
          const changes = dirty.get(normalizePath(wt.path)) ?? 0;
          return (
            <li key={wt.path}>
              <button
                type="button"
                className="worktree-row"
                onClick={() => wt.head && onSelect(wt.head)}
                title={wt.path}
              >
                <span className="worktree-head-line">
                  <span className="worktree-branch">
                    {wt.isDetached ? "detached HEAD" : (wt.branch ?? "-")}
                  </span>
                  {wt.isMain && <span className="badge-main">メイン</span>}
                  {changes > 0 && (
                    <span className="badge-working" title={`未コミットの変更 ${changes} ファイル`}>
                      作業中 {changes}
                    </span>
                  )}
                  {wt.isLocked && (
                    <span className="badge-locked" title={wt.lockReason ?? undefined}>
                      ロック
                    </span>
                  )}
                  {wt.isPrunable && <span className="badge-prunable">要 prune</span>}
                  {wt.head && <span className="worktree-hash mono">{wt.head.slice(0, 7)}</span>}
                  <span
                    role="button"
                    tabIndex={0}
                    className="row-open-tab"
                    title="このワークツリーをタブで開く"
                    aria-label="タブで開く"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenTab(wt.path);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        onOpenTab(wt.path);
                      }
                    }}
                  >
                    ⧉
                  </span>
                </span>
                <span className="worktree-path">
                  <bdi>{wt.path}</bdi>
                </span>

                {/* 何をしているワークツリーか分かるよう、説明か HEAD のコミットを出す */}
                {wt.description ? (
                  <span className="row-note described">{wt.description}</span>
                ) : (
                  wt.headSummary && (
                    <span className="row-note">
                      {wt.headSummary}
                      {wt.headTime !== null && (
                        <span className="worktree-age">（{formatAge(wt.headTime)}）</span>
                      )}
                    </span>
                  )
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
