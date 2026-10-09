import { useMemo, useRef, useState } from "react";

import { branchState, STATE_LABEL, STATE_ORDER, type BranchState } from "../branchState";
import { formatAge, isStale } from "../format";
import type { BranchInfo, MergeBaseInfo } from "../types";

type Props = {
  branches: BranchInfo[];
  /** ワークツリーのパス → 未コミット変更の件数。主状態「作業中」の判定に使う */
  dirty: Map<string, number>;
  mergeBase: MergeBaseInfo | null;
  selectedName: string | null;
  onSelect: (branch: BranchInfo) => void;
  /** マージ基準を変える。null で自動検出に戻す */
  onChangeMergeBase: (name: string | null) => void;
  /** メモを保存する。null を渡すと設定を消す */
  onEditDescription: (branch: string, description: string | null) => void;
  /** ブランチビューを新しいタブで開く */
  onOpenTab: (branch: string) => void;
};

/**
 * ブランチ一覧。主状態（作業中 / 未マージ / マージ済み）でグループ分けし、
 * 放置されているブランチが目に留まるようにする。用途のメモもここで書ける。
 */
export function BranchList({
  branches,
  dirty,
  mergeBase,
  selectedName,
  onSelect,
  onChangeMergeBase,
  onEditDescription,
  onOpenTab,
}: Props) {
  const [query, setQuery] = useState("");
  const [localOnly, setLocalOnly] = useState(true);
  // マージ済みは削除候補の置き場なので、既定では畳んでおく
  const [collapsed, setCollapsed] = useState<Record<BranchState, boolean>>({
    working: false,
    unmerged: false,
    merged: true,
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Esc で抜けたときに onBlur で保存されないようにする
  const cancelled = useRef(false);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return branches
      .filter((b) => (localOnly ? b.kind !== "remoteBranch" : true))
      .filter(
        (b) =>
          needle === "" ||
          b.name.toLowerCase().includes(needle) ||
          (b.description ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => b.lastCommitTime - a.lastCommitTime);
  }, [branches, query, localOnly]);

  // マージ基準そのものはグループに入れず、先頭に固定して出す
  const baseBranch = shown.find((b) => b.isMergeBase) ?? null;
  const groups = useMemo(() => {
    const map: Record<BranchState, BranchInfo[]> = { working: [], unmerged: [], merged: [] };
    for (const b of shown) {
      if (b.isMergeBase) continue;
      map[branchState(b, dirty)].push(b);
    }
    return map;
  }, [shown, dirty]);

  const localNames = useMemo(
    () => branches.filter((b) => b.kind !== "remoteBranch").map((b) => b.name),
    [branches],
  );

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

  const renderRow = (b: BranchInfo) => (
    <li key={`${b.kind}:${b.name}`}>
      <div
        role="button"
        tabIndex={0}
        className={`branch-row${b.name === selectedName ? " selected" : ""}`}
        onClick={() => onSelect(b)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(b);
          }
        }}
        title={b.worktreePath ? `ワークツリー: ${b.worktreePath}` : undefined}
      >
        <span className="branch-name">
          {b.isHead && <span className="branch-head-mark">●</span>}
          <span className={b.kind === "remoteBranch" ? "remote" : ""}>{b.name}</span>
          {b.isMergeBase && <span className="badge-base">基準</span>}
          {b.worktreePath && !b.isHead && <span className="branch-wt">WT</span>}
        </span>

        <span className="branch-meta">
          {!b.isMergeBase && (b.ahead > 0 || b.behind > 0) && (
            <span
              className="ahead-behind"
              title={`マージ基準 ${mergeBase?.name ?? "HEAD"} に無いコミット ${b.ahead} 件 / 基準にあってこのブランチに無いコミット ${b.behind} 件`}
            >
              {b.ahead > 0 && <span className="ahead">↑{b.ahead}</span>}
              {b.behind > 0 && <span className="behind">↓{b.behind}</span>}
            </span>
          )}
          {b.unpushed && (
            <span
              className="badge-unpushed"
              title={b.upstream ? `上流 ${b.upstream} に無いコミットがあります` : "上流がありません"}
            >
              未 push
            </span>
          )}
          <span className={isStale(b.lastCommitTime) ? "age stale" : "age"}>
            {formatAge(b.lastCommitTime)}
          </span>
          <button
            type="button"
            className="row-open-tab"
            title="このブランチから辿れるコミットだけをタブで開く"
            aria-label="タブで開く"
            onClick={(e) => {
              e.stopPropagation();
              onOpenTab(b.name);
            }}
          >
            ⧉
          </button>
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
  );

  return (
    <div className="panel">
      <div className="panel-filters">
        <input
          type="search"
          value={query}
          placeholder="ブランチ名・メモで絞り込み"
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <label className="merge-base-picker">
          基準
          <select
            value={mergeBase?.source === "setting" ? (mergeBase.name ?? "") : ""}
            onChange={(e) => onChangeMergeBase(e.currentTarget.value || null)}
            title="「取り込み済み」を判定する相手のブランチ。リポジトリごとに記憶します"
          >
            <option value="">
              自動（{mergeBase?.name ?? "HEAD"}）
            </option>
            {localNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={localOnly}
            onChange={(e) => setLocalOnly(e.currentTarget.checked)}
          />
          ローカルのみ
        </label>
        {mergeBase?.settingMissing && (
          <span className="panel-warning">
            設定されたマージ基準が見つからないため自動検出しています
          </span>
        )}
        {mergeBase?.source === "head" && (
          <span className="panel-warning">
            main / master / develop が無いため HEAD を基準にしています
          </span>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="panel-empty">該当するブランチがありません。</p>
      ) : (
        <>
          {baseBranch && <ul className="panel-list">{renderRow(baseBranch)}</ul>}
          {STATE_ORDER.map((state) => {
            const items = groups[state];
            const open = !collapsed[state];
            return (
              <section key={state} className={`branch-group ${state}`}>
                <button
                  type="button"
                  className="branch-group-header"
                  aria-expanded={open}
                  onClick={() => setCollapsed((c) => ({ ...c, [state]: !c[state] }))}
                >
                  <span className="branch-group-arrow">{open ? "▾" : "▸"}</span>
                  <span className="branch-group-label">{STATE_LABEL[state]}</span>
                  <span className="branch-group-count">{items.length}</span>
                  {state === "merged" && items.length > 0 && (
                    <span className="branch-group-hint">削除候補</span>
                  )}
                </button>
                {open && items.length > 0 && (
                  <ul className="panel-list">{items.map(renderRow)}</ul>
                )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
