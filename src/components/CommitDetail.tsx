import { formatCommitDate, formatOffset } from "../format";
import type { Commit } from "../types";
import { RefBadge } from "./RefBadge";

type Props = {
  commit: Commit | null;
  onSelectParent: (id: string) => void;
};

export function CommitDetail({ commit, onSelectParent }: Props) {
  if (!commit) {
    return <div className="detail empty">コミットを選択すると詳細が表示されます</div>;
  }

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
    </div>
  );
}
