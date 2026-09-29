import { useMemo, useState } from "react";

import { formatAge, isStale } from "../format";
import type { BranchInfo } from "../types";

type Props = {
  branches: BranchInfo[];
  selectedTarget: string | null;
  onSelect: (commitId: string) => void;
};

/**
 * ブランチ一覧。放置されているブランチ（未マージ・最終コミットが古い）が
 * 目に留まるようにしている。
 */
export function BranchList({ branches, selectedTarget, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [unmergedOnly, setUnmergedOnly] = useState(false);
  const [localOnly, setLocalOnly] = useState(true);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return branches
      .filter((b) => (localOnly ? b.kind !== "remoteBranch" : true))
      .filter((b) => (unmergedOnly ? !b.merged : true))
      .filter((b) => needle === "" || b.name.toLowerCase().includes(needle))
      .sort((a, b) => b.lastCommitTime - a.lastCommitTime);
  }, [branches, query, unmergedOnly, localOnly]);

  const unmergedCount = branches.filter((b) => !b.merged && b.kind !== "remoteBranch").length;

  return (
    <div className="panel">
      <div className="panel-filters">
        <input
          type="search"
          value={query}
          placeholder="ブランチ名で絞り込み"
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={unmergedOnly}
            onChange={(e) => setUnmergedOnly(e.currentTarget.checked)}
          />
          未マージのみ ({unmergedCount})
        </label>
        <label>
          <input
            type="checkbox"
            checked={localOnly}
            onChange={(e) => setLocalOnly(e.currentTarget.checked)}
          />
          ローカルのみ
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="panel-empty">該当するブランチがありません。</p>
      ) : (
        <ul className="panel-list">
          {shown.map((b) => (
            <li key={`${b.kind}:${b.name}`}>
              <button
                type="button"
                className={`branch-row${b.target === selectedTarget ? " selected" : ""}`}
                onClick={() => onSelect(b.target)}
                title={b.worktreePath ? `ワークツリー: ${b.worktreePath}` : b.lastCommitSummary}
              >
                <span className="branch-name">
                  {b.isHead && <span className="branch-head-mark">●</span>}
                  <span className={b.kind === "remoteBranch" ? "remote" : ""}>{b.name}</span>
                  {b.worktreePath && !b.isHead && <span className="branch-wt">WT</span>}
                </span>

                <span className="branch-meta">
                  {b.ahead > 0 && <span className="ahead">↑{b.ahead}</span>}
                  {b.behind > 0 && <span className="behind">↓{b.behind}</span>}
                  {!b.merged && <span className="badge-unmerged">未マージ</span>}
                  <span className={isStale(b.lastCommitTime) ? "age stale" : "age"}>
                    {formatAge(b.lastCommitTime)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
