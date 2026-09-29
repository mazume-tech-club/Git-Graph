import { DiffPane } from "./DiffPane";
import { formatCommitDate, formatOffset } from "../format";
import type { Commit } from "../types";
import { RefBadge } from "./RefBadge";

type Props = {
  commit: Commit | null;
  repoPath: string;
  /** 比較の基準に固定したコミット */
  compareBase: string | null;
  onSelectParent: (id: string) => void;
  onSetCompareBase: (id: string | null) => void;
};

export function CommitDetail({
  commit,
  repoPath,
  compareBase,
  onSelectParent,
  onSetCompareBase,
}: Props) {
  if (!commit) {
    return <div className="detail empty">コミットを選択すると詳細が表示されます</div>;
  }

  // 自分自身が基準のときは通常表示（第一親との差分）に戻す
  const comparing = compareBase !== null && compareBase !== commit.id;

  return (
    <div className="detail">
      <h2 className="detail-summary">{commit.summary || "(メッセージなし)"}</h2>

      {commit.refs.length > 0 && (
        <div className="detail-refs">
          {commit.refs.map((r) => (
            <RefBadge key={`${r.kind}:${r.name}`} refLabel={r} />
          ))}
        </div>
      )}

      <dl className="detail-meta">
        <dt>コミット</dt>
        <dd className="mono">{commit.id}</dd>

        <dt>作成者</dt>
        <dd>
          {commit.authorName} &lt;{commit.authorEmail}&gt;
        </dd>

        <dt>日時</dt>
        <dd>
          {formatCommitDate(commit, true)} ({formatOffset(commit.offsetMinutes)})
        </dd>

        <dt>親</dt>
        <dd>
          {commit.parents.length === 0 ? (
            <span className="muted">なし（ルートコミット）</span>
          ) : (
            commit.parents.map((p) => (
              <button
                key={p}
                type="button"
                className="parent-link mono"
                onClick={() => onSelectParent(p)}
              >
                {p.slice(0, 7)}
              </button>
            ))
          )}
        </dd>
      </dl>

      {commit.body.trim() !== "" && <pre className="detail-body">{commit.body.trim()}</pre>}

      <div className="compare-bar">
        {comparing ? (
          <>
            <span className="mono">
              {compareBase.slice(0, 7)} ↔ {commit.id.slice(0, 7)}
            </span>
            <button type="button" onClick={() => onSetCompareBase(null)}>
              比較を解除
            </button>
          </>
        ) : (
          <button type="button" onClick={() => onSetCompareBase(commit.id)}>
            比較対象に設定
          </button>
        )}
      </div>

      <DiffPane repoPath={repoPath} from={comparing ? compareBase : null} to={commit.id} />
    </div>
  );
}
