import { useEffect, useState } from "react";

import { diffSummary, fileDiff } from "../api";
import type { ChangeStatus, DiffSummary, FileChange, FileDiff } from "../types";

type Props = {
  repoPath: string;
  /** 比較の基準。null なら to の第一親（作業ツリー表示のときは HEAD） */
  from: string | null;
  /** 比較対象。null なら作業ツリー */
  to: string | null;
};

const STATUS_LABEL: Record<ChangeStatus, string> = {
  added: "追加",
  deleted: "削除",
  modified: "変更",
  renamed: "改名",
  copied: "複製",
  typeChange: "種別",
  untracked: "未追跡",
  other: "その他",
};

/** 変更ファイル一覧と、選択したファイルのユニファイド差分。 */
export function DiffPane({ repoPath, from, to }: Props) {
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setFile(null);
    setDiff(null);
    setError(null);
    diffSummary(repoPath, from, to)
      .then((s) => {
        if (cancelled) return;
        setSummary(s);
        // 1 件だけなら開く手間を省く
        if (s.files.length === 1) setFile(s.files[0].path);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [repoPath, from, to]);

  useEffect(() => {
    if (file === null) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff(null);
    fileDiff(repoPath, from, to, file)
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [repoPath, from, to, file]);

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
              className={`file-row${f.path === file ? " selected" : ""}`}
              onClick={() => setFile(f.path === file ? null : f.path)}
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

      {file !== null && <DiffBody file={file} diff={diff} />}
    </div>
  );
}

function FileCounts({ change }: { change: FileChange }) {
  if (change.isBinary) return <span className="file-counts">バイナリ</span>;
  return (
    <span className="file-counts">
      {change.insertions > 0 && <span className="added">+{change.insertions}</span>}
      {change.deletions > 0 && <span className="removed">-{change.deletions}</span>}
    </span>
  );
}

function DiffBody({ file, diff }: { file: string; diff: FileDiff | null }) {
  if (!diff) return <p className="diff-note">{file} を読み込み中...</p>;
  if (diff.isBinary) return <p className="diff-note">バイナリファイルのため差分は表示できません。</p>;
  if (diff.hunks.length === 0) return <p className="diff-note">内容の差分はありません。</p>;

  return (
    <div className="diff-body">
      {diff.hunks.map((hunk, i) => (
        <div className="hunk" key={`${hunk.header}-${i}`}>
          <div className="hunk-header">{hunk.header}</div>
          {hunk.lines.map((line, j) => (
            <div className={`diff-line ${line.kind}`} key={j}>
              <span className="lineno">{line.oldLineno ?? ""}</span>
              <span className="lineno">{line.newLineno ?? ""}</span>
              <span className="sign">
                {line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}
              </span>
              <span className="code">{line.content}</span>
            </div>
          ))}
        </div>
      ))}
      {diff.truncated && <p className="diff-note">差分が大きいため途中までを表示しています。</p>}
    </div>
  );
}
