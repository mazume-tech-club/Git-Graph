import { useMemo, useRef, useState } from "react";

import { formatAge, isStale } from "../format";
import type { BranchInfo } from "../types";

type Props = {
  branches: BranchInfo[];
  selectedTarget: string | null;
  onSelect: (commitId: string) => void;
  /** メモを保存する。null を渡すと設定を消す */
  onEditDescription: (branch: string, description: string | null) => void;
};

/**
 * ブランチ一覧。放置されているブランチ（未マージ・最終コミットが古い）が
 * 目に留まるようにし、用途をメモできるようにしている。
 */
export function BranchList({ branches, selectedTarget, onSelect, onEditDescription }: Props) {
  const [query, setQuery] = useState("");
  const [unmergedOnly, setUnmergedOnly] = useState(false);
  const [localOnly, setLocalOnly] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Esc で抜けたときに onBlur で保存されないようにする
  const cancelled = useRef(false);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return branches
      .filter((b) => (localOnly ? b.kind !== "remoteBranch" : true))
      .filter((b) => (unmergedOnly ? !b.merged : true))
      .filter(
        (b) =>
          needle === "" ||
          b.name.toLowerCase().includes(needle) ||
          (b.description ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => b.lastCommitTime - a.lastCommitTime);
  }, [branches, query, unmergedOnly, localOnly]);

  const unmergedCount = branches.filter((b) => !b.merged && b.kind !== "remoteBranch").length;

  const startEdit = (branch: BranchInfo) => {
    cancelled.current = false;
    setDraft(branch.description ?? "");
    setEditing(branch.name);
  };

  const commit = (name: string) => {
    setEditing(null);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const text = draft.trim();
    onEditDescription(name, text === "" ? null : text);
  };

  return (
    <div className="panel">
      <div className="panel-filters">
        <input
          type="search"
          value={query}
          placeholder="ブランチ名・メモで絞り込み"
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
              <div
                role="button"
                tabIndex={0}
                className={`branch-row${b.target === selectedTarget ? " selected" : ""}`}
                onClick={() => onSelect(b.target)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(b.target);
                  }
                }}
                title={b.worktreePath ? `ワークツリー: ${b.worktreePath}` : undefined}
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

                <span className="branch-note-line">
                {editing === b.name ? (
                  <input
                    className="note-input"
                    value={draft}
                    autoFocus
                    placeholder="用途をメモ（空にすると削除）"
                    onChange={(e) => setDraft(e.currentTarget.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commit(b.name)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commit(b.name);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelled.current = true;
                        setEditing(null);
                      }
                    }}
                  />
                ) : (
                  <>
                    {/* メモがあればそれを、無ければ最後のコミットを手がかりに出す */}
                    {b.description ? (
                      <span className="row-note described">{b.description}</span>
                    ) : (
                      <span className="row-note">{b.lastCommitSummary || "(メッセージなし)"}</span>
                    )}
                    {b.kind !== "remoteBranch" && (
                      <button
                        type="button"
                        className="note-edit"
                        title={b.description ? "メモを編集" : "メモを付ける"}
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit(b);
                        }}
                      >
                        ✎
                      </button>
                    )}
                  </>
                )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
