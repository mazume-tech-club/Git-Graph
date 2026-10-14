import { useEffect, useRef, useState } from "react";

import { diffSummary } from "../api";
import type { ChangeStatus, DiffSummary, FileChange } from "../types";

/** 差分ビューアに出す比較。サイドバーの変更ファイル一覧が読み込めたら RepoView へ渡す */
export type DiffComparison = {
  from: string | null;
  to: string | null;
  summary: DiffSummary;
};

/** サイドバーの一覧と差分ビューアをつなぐ。RepoView が持つ */
export type DiffViewerLink = {
  /** 差分ビューアで開いているファイル。閉じていれば null */
  openFile: string | null;
  onOpenFile: (path: string | null) => void;
  onComparison: (comparison: DiffComparison) => void;
};

type Props = {
  repoPath: string;
  /** 比較の基準。null なら to の第一親（作業ツリー表示のときは HEAD） */
  from: string | null;
  /** 比較対象。null なら作業ツリー */
  to: string | null;
  viewer: DiffViewerLink;
};

export const STATUS_LABEL: Record<ChangeStatus, string> = {
  added: "追加",
  deleted: "削除",
  modified: "変更",
  renamed: "改名",
  copied: "複製",
  typeChange: "種別",
  untracked: "未追跡",
  other: "その他",
};

/** 変更ファイルの一覧。ファイルを選ぶと差分ビューアで開く。 */
export function DiffPane({ repoPath, from, to, viewer }: Props) {
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 呼び出し側が毎回新しいオブジェクトを渡しても読み直さないよう、控えから呼ぶ
  const onComparison = useRef(viewer.onComparison);
  onComparison.current = viewer.onComparison;

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setError(null);
    diffSummary(repoPath, from, to)
      .then((s) => {
        if (cancelled) return;
        setSummary(s);
        onComparison.current({ from, to, summary: s });
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [repoPath, from, to]);

  if (error) return <p className="diff-note error">{error}</p>;
  if (!summary) return <p className="diff-note">差分を読み込み中...</p>;
  if (summary.files.length === 0) return <p className="diff-note">変更されたファイルはありません。</p>;

  return (
    <div className="diff-pane">
      <div className="diff-summary-line">
        <span>{summary.files.length} ファイル</span>
        <span className="added">+{summary.insertions}</span>
        <span className="removed">-{summary.deletions}</span>
        {summary.againstFirstParent && (
          <span className="diff-note-inline">第一親との差分</span>
        )}
      </div>

      <ul className="file-list">
        {summary.files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              className={`file-row${f.path === viewer.openFile ? " selected" : ""}`}
              onClick={() => viewer.onOpenFile(f.path === viewer.openFile ? null : f.path)}
              title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
            >
              <span className={`file-status status-${f.status}`}>{STATUS_LABEL[f.status]}</span>
              <span className="file-path">
                <bdi>{f.path}</bdi>
              </span>
              <FileCounts change={f} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FileCounts({ change }: { change: FileChange }) {
  if (change.isBinary) return <span className="file-counts">バイナリ</span>;
  return (
    <span className="file-counts">
      {change.insertions > 0 && <span className="added">+{change.insertions}</span>}
      {change.deletions > 0 && <span className="removed">-{change.deletions}</span>}
    </span>
  );
}
