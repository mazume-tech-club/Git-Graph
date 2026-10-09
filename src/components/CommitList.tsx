import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";

import { LANE_WIDTH, ROW_HEIGHT, type Graph, type GraphRow } from "../graph/lanes";
import { formatCommitDate } from "../format";
import { GraphCell } from "./GraphCell";
import { RefBadge } from "./RefBadge";

/** 親から一覧を操作するためのハンドル */
export type CommitListHandle = {
  /** 指定コミットの行が中央に来るようスクロールする */
  scrollToCommit: (id: string) => void;
};

type Props = {
  ref?: Ref<CommitListHandle>;
  graph: Graph;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 未コミットの変更ファイル数。0 なら擬似行を出さない */
  worktreeChanges: number;
  worktreeSelected: boolean;
  onSelectWorktree: () => void;
};

/** 見えている範囲の前後に余分に描く行数。スクロール中の白抜けを防ぐ */
const OVERSCAN = 8;

/**
 * コミット一覧。行の高さが固定なので、見えている範囲の行だけを DOM に置く
 * （仮想スクロール）。500 行分の SVG を全部描かないようにするため。
 */
export function CommitList({
  ref,
  graph,
  selectedId,
  onSelect,
  worktreeChanges,
  worktreeSelected,
  onSelectWorktree,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 先頭に見えている行の番号と、表示領域に入る行数。どちらも整数なので
  // スクロールのたびに setState しても値が同じなら再描画されない
  const [firstVisible, setFirstVisible] = useState(0);
  const [visibleRows, setVisibleRows] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setVisibleRows(Math.ceil(el.clientHeight / ROW_HEIGHT));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setFirstVisible(Math.floor(e.currentTarget.scrollTop / ROW_HEIGHT));
  }, []);

  const graphWidth = Math.max(graph.laneCount, 1) * LANE_WIDTH;
  // 未コミット行があると、コミット行はその分だけ下にずれる
  const offsetRows = worktreeChanges > 0 ? 1 : 0;
  const total = graph.rows.length;
  const start = Math.max(0, firstVisible - offsetRows - OVERSCAN);
  const end = Math.min(total, firstVisible - offsetRows + visibleRows + OVERSCAN);

  useImperativeHandle(
    ref,
    () => ({
      scrollToCommit(id) {
        const el = containerRef.current;
        const index = graph.rows.findIndex((r) => r.commit.id === id);
        if (!el || index < 0) return;
        const rowTop = (index + offsetRows) * ROW_HEIGHT;
        el.scrollTop = Math.max(0, rowTop - (el.clientHeight - ROW_HEIGHT) / 2);
      },
    }),
    [graph, offsetRows],
  );

  return (
    <div
      className="commit-list"
      role="listbox"
      aria-label="コミット一覧"
      ref={containerRef}
      onScroll={onScroll}
    >
      {worktreeChanges > 0 && (
        <div
          role="option"
          aria-selected={worktreeSelected}
          tabIndex={0}
          className={`commit-row worktree-changes${worktreeSelected ? " selected" : ""}`}
          style={{ height: ROW_HEIGHT }}
          onClick={onSelectWorktree}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelectWorktree();
            }
          }}
        >
          <div className="commit-graph" style={{ width: graphWidth }} />
          <div className="commit-summary">
            <span className="badge-uncommitted">未コミット</span>
            <span className="summary-text">作業ツリーの変更（{worktreeChanges} ファイル）</span>
          </div>
        </div>
      )}
      {/* 描いていない行の分だけ高さを確保し、スクロールバーの長さを全体に合わせる */}
      {start > 0 && <div style={{ height: start * ROW_HEIGHT }} />}
      {graph.rows.slice(start, end).map((row) => (
        <CommitRow
          key={row.commit.id}
          row={row}
          laneCount={graph.laneCount}
          graphWidth={graphWidth}
          selected={row.commit.id === selectedId}
          onSelect={onSelect}
        />
      ))}
      {end < total && <div style={{ height: (total - end) * ROW_HEIGHT }} />}
    </div>
  );
}

type RowProps = {
  row: GraphRow;
  laneCount: number;
  graphWidth: number;
  selected: boolean;
  onSelect: (id: string) => void;
};

/** 1 コミット分の行。選択が変わった行以外は描き直さない */
const CommitRow = memo(function CommitRow({
  row,
  laneCount,
  graphWidth,
  selected,
  onSelect,
}: RowProps) {
  const { commit } = row;
  return (
    <div
      id={`commit-${commit.id}`}
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
        <GraphCell row={row} laneCount={laneCount} />
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
});
