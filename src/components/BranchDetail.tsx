import { useEffect, useState } from "react";

import { mergeBaseCommit } from "../api";
import { formatAge } from "../format";
import type { BranchInfo, MergeBaseInfo } from "../types";
import { DiffPane } from "./DiffPane";

type Props = {
  branch: BranchInfo;
  mergeBase: MergeBaseInfo | null;
  repoPath: string;
  /** グラフ側でそのコミットを選ぶ */
  onSelectCommit: (id: string) => void;
};

/**
 * ブランチの変更内容。マージ基準との共通祖先からブランチ先端までの差分を出し、
 * メモが無くても「このブランチで何を作っていたか」が掴めるようにする。
 */
export function BranchDetail({ branch, mergeBase, repoPath, onSelectCommit }: Props) {
  const baseCommit = mergeBase?.commit ?? null;
  // 共通祖先。null は未取得、"" は履歴がつながっていない
  const [ancestor, setAncestor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAncestor(null);
    setError(null);
    if (!baseCommit || branch.isMergeBase) return;
    let cancelled = false;
    mergeBaseCommit(repoPath, baseCommit, branch.target)
      .then((id) => !cancelled && setAncestor(id ?? ""))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [repoPath, baseCommit, branch.target, branch.isMergeBase]);

  const baseLabel = mergeBase?.name ?? "HEAD";

  return (
    <div className="detail">
      <h2 className="detail-summary">
        {branch.name}
        {branch.isMergeBase && <span className="badge-base">基準</span>}
      </h2>

      <dl className="detail-meta">
        <dt>先端</dt>
        <dd>
          <button
            type="button"
            className="parent-link mono"
            onClick={() => onSelectCommit(branch.target)}
          >
            {branch.target.slice(0, 7)}
          </button>{" "}
          {branch.lastCommitSummary || "(メッセージなし)"}
          <span className="muted">（{formatAge(branch.lastCommitTime)}）</span>
        </dd>

        {!branch.isMergeBase && (
          <>
            <dt>基準</dt>
            <dd>
              {baseLabel}
              {baseCommit && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="parent-link mono"
                    onClick={() => onSelectCommit(baseCommit)}
                  >
                    {baseCommit.slice(0, 7)}
                  </button>
                </>
              )}
            </dd>

            <dt>共通祖先</dt>
            <dd>
              {ancestor === null ? (
                <span className="muted">{baseCommit ? "取得中..." : "-"}</span>
              ) : ancestor === "" ? (
                <span className="muted">なし（履歴がつながっていません）</span>
              ) : (
                <button
                  type="button"
                  className="parent-link mono"
                  onClick={() => onSelectCommit(ancestor)}
                >
                  {ancestor.slice(0, 7)}
                </button>
              )}
            </dd>

            <dt>基準との差</dt>
            <dd>
              <span className="ahead">↑{branch.ahead}</span> 基準に無いコミット /{" "}
              <span className="behind">↓{branch.behind}</span> 基準にあって無いコミット
            </dd>
          </>
        )}

        <dt>上流</dt>
        <dd>
          {branch.upstream ?? <span className="muted">なし</span>}
          {branch.unpushed && <span className="badge-unpushed">未 push</span>}
        </dd>

        {branch.worktreePath && (
          <>
            <dt>ワークツリー</dt>
            <dd>
              <bdi>{branch.worktreePath}</bdi>
            </dd>
          </>
        )}

        {branch.description && (
          <>
            <dt>メモ</dt>
            <dd>{branch.description}</dd>
          </>
        )}
      </dl>

      {error && <p className="diff-note error">{error}</p>}
      {branch.isMergeBase ? (
        <p className="diff-note">このブランチがマージ基準です。他のブランチはこれと比べられます。</p>
      ) : branch.merged ? (
        <p className="diff-note">
          {baseLabel} に取り込み済みです。基準に無い変更はありません。
        </p>
      ) : ancestor ? (
        <>
          <h3 className="detail-section">基準に無い変更（共通祖先からの差分）</h3>
          <DiffPane repoPath={repoPath} from={ancestor} to={branch.target} />
        </>
      ) : null}
    </div>
  );
}
