import { LANE_WIDTH, ROW_HEIGHT, type Graph } from "../graph/lanes";
import { formatCommitDate } from "../format";
import { GraphCell } from "./GraphCell";
import { RefBadge } from "./RefBadge";

type Props = {
  graph: Graph;
  selectedId: string | null;
  onSelect: (id: string) => void;
};

export function CommitList({ graph, selectedId, onSelect }: Props) {
  const graphWidth = Math.max(graph.laneCount, 1) * LANE_WIDTH;

  return (
    <div className="commit-list" role="listbox" aria-label="コミット一覧">
      {graph.rows.map((row) => {
        const { commit } = row;
        const selected = commit.id === selectedId;
        return (
          <div
            key={commit.id}
            role="option"
            aria-selected={selected}
            tabIndex={0}
            className={`commit-row${selected ? " selected" : ""}`}
            style={{ height: ROW_HEIGHT }}
            onClick={() => onSelect(commit.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(commit.id);
              }
            }}
          >
            <div className="commit-graph" style={{ width: graphWidth }}>
              <GraphCell row={row} laneCount={graph.laneCount} />
            </div>
            <div className="commit-summary">
              {commit.refs.map((r) => (
                <RefBadge key={`${r.kind}:${r.name}`} refLabel={r} />
              ))}
              <span className="summary-text">{commit.summary || "(メッセージなし)"}</span>
            </div>
            <div className="commit-author">{commit.authorName}</div>
            <div className="commit-date">{formatCommitDate(commit)}</div>
            <div className="commit-hash">{commit.shortId}</div>
          </div>
        );
      })}
    </div>
  );
}
