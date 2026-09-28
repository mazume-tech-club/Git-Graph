import {
  laneColor,
  laneX,
  LANE_WIDTH,
  NODE_RADIUS,
  ROW_HEIGHT,
  type GraphRow,
} from "../graph/lanes";

const CENTER_Y = ROW_HEIGHT / 2;

/** (x1,y1) から (x2,y2) へ縦向きに滑らかにつなぐパス */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const my = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}

type Props = {
  row: GraphRow;
  laneCount: number;
};

/**
 * 1 コミット分のグラフ描画。行ごとに独立した SVG を持たせることで、
 * 行の高さ・仮想スクロールとレイアウトを合わせやすくしている。
 */
export function GraphCell({ row, laneCount }: Props) {
  const { commit, lane, lanesAbove, mergeIn, forkOut, relocations } = row;
  const width = Math.max(laneCount, 1) * LANE_WIDTH;
  const nodeX = laneX(lane);

  // このコミットに関係せず、上から下へまっすぐ素通りするレーン
  const relocated = new Set(relocations.map((r) => r.from));
  const passThrough = lanesAbove
    .map((id, i) => (id !== null && !mergeIn.includes(i) && !relocated.has(i) ? i : -1))
    .filter((i) => i >= 0);

  const isMerge = commit.parents.length > 1;

  return (
    <svg
      className="graph-cell"
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      aria-hidden="true"
    >
      {passThrough.map((i) => (
        <path
          key={`pass-${i}`}
          d={`M ${laneX(i)} 0 L ${laneX(i)} ${ROW_HEIGHT}`}
          stroke={laneColor(i)}
          strokeWidth={1.5}
          fill="none"
        />
      ))}

      {/* 上から降りてきてこのノードに合流する線 */}
      {mergeIn.map((i) => (
        <path
          key={`merge-${i}`}
          d={curve(laneX(i), 0, nodeX, CENTER_Y)}
          stroke={laneColor(i)}
          strokeWidth={1.5}
          fill="none"
        />
      ))}

      {/* 左へ詰め替えられたレーン（行をまたいで斜めに降りる） */}
      {relocations.map((r) => (
        <path
          key={`move-${r.from}-${r.to}`}
          d={curve(laneX(r.from), 0, laneX(r.to), ROW_HEIGHT)}
          stroke={laneColor(r.to)}
          strokeWidth={1.5}
          fill="none"
        />
      ))}

      {/* このノードから親へ向かって下へ伸びる線 */}
      {forkOut.map((i) => (
        <path
          key={`fork-${i}`}
          d={curve(nodeX, CENTER_Y, laneX(i), ROW_HEIGHT)}
          stroke={laneColor(i)}
          strokeWidth={1.5}
          fill="none"
        />
      ))}

      <circle
        cx={nodeX}
        cy={CENTER_Y}
        r={NODE_RADIUS}
        fill={isMerge ? "var(--bg)" : laneColor(lane)}
        stroke={laneColor(lane)}
        strokeWidth={2}
      />
    </svg>
  );
}
