import { BranchList } from "./BranchList";
import { CommitDetail } from "./CommitDetail";
import { WorktreeList } from "./WorktreeList";
import type { BranchInfo, Commit, WorktreeInfo } from "../types";

export type SidebarTab = "branches" | "worktrees" | "detail";

type Props = {
  tab: SidebarTab;
  onChangeTab: (tab: SidebarTab) => void;
  branches: BranchInfo[];
  worktrees: WorktreeInfo[];
  commit: Commit | null;
  onSelectCommit: (commitId: string) => void;
  onSelectParent: (commitId: string) => void;
};

const TABS: { id: SidebarTab; label: string }[] = [
  { id: "branches", label: "ブランチ" },
  { id: "worktrees", label: "ワークツリー" },
  { id: "detail", label: "詳細" },
];

export function Sidebar({
  tab,
  onChangeTab,
  branches,
  worktrees,
  commit,
  onSelectCommit,
  onSelectParent,
}: Props) {
  const count = (id: SidebarTab) =>
    id === "branches" ? branches.length : id === "worktrees" ? worktrees.length : null;

  return (
    <aside className="sidebar">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? " active" : ""}`}
            onClick={() => onChangeTab(t.id)}
          >
            {t.label}
            {count(t.id) !== null && <span className="tab-count">{count(t.id)}</span>}
          </button>
        ))}
      </div>

      <div className="tab-body">
        {tab === "branches" && (
          <BranchList
            branches={branches}
            selectedTarget={commit?.id ?? null}
            onSelect={onSelectCommit}
          />
        )}
        {tab === "worktrees" && (
          <WorktreeList worktrees={worktrees} onSelect={onSelectCommit} />
        )}
        {tab === "detail" && (
          <CommitDetail commit={commit} onSelectParent={onSelectParent} />
        )}
      </div>
    </aside>
  );
}
