import type { Commit } from "../types";

export const LANE_WIDTH = 16;
export const ROW_HEIGHT = 30;
export const NODE_RADIUS = 4.5;

export type GraphRow = {
  commit: Commit;
  /** このコミットのノードを置くレーン番号 */
  lane: number;
  /** 行の上端から降りてくるレーン（添字=レーン番号、値=そのレーンが待つコミット ID） */
  lanesAbove: (string | null)[];
  /** 行の下端へ続くレーン */
  lanesBelow: (string | null)[];
  /** 上から降りてきてこのノードに合流するレーン番号 */
  mergeIn: number[];
  /** このノードから親へ向かって下へ伸びるレーン番号（先頭が第一親） */
  forkOut: number[];
  /** この行で左へ詰め替えられたレーン（素通り線ではなく斜線で描く） */
  relocations: { from: number; to: number }[];
};

export type Graph = {
  rows: GraphRow[];
  /** 使用された最大レーン数（描画幅の算出に使う） */
  laneCount: number;
};

function firstFree(lanes: (string | null)[]): number {
  const i = lanes.indexOf(null);
  return i === -1 ? lanes.length : i;
}

/** 末尾の空きレーンを詰めて、グラフ幅が無駄に広がらないようにする */
function trimTrailing(lanes: (string | null)[]): void {
  while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
}

/**
 * コミット列（新しい順、親は必ず子より後ろ）からレーン配置を組み立てる。
 *
 * 各レーンは「次にそのレーンへ現れるべきコミット ID」を保持する。
 * コミットを処理するたびに、そのコミットを待っていたレーンを解放し、
 * 親コミットを待つレーンとして再確保する。
 */
export function buildGraph(commits: Commit[]): Graph {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let laneCount = 0;

  for (const commit of commits) {
    const lanesAbove = [...lanes];

    // 上から降りてきているレーンのうち、このコミットを待っているもの
    const mergeIn: number[] = [];
    lanesAbove.forEach((id, i) => {
      if (id === commit.id) mergeIn.push(i);
    });

    // ノードは合流レーンの最左に置く。どこからも参照されていなければ新規レーン
    const lane = mergeIn.length > 0 ? mergeIn[0] : firstFree(lanes);
    for (const i of mergeIn) lanes[i] = null;
    lanes[lane] = null;

    // 親を各レーンへ割り当てる。第一親は自分のレーンをそのまま引き継ぐ
    const forkOut: number[] = [];
    const relocations: { from: number; to: number }[] = [];
    commit.parents.forEach((parent, k) => {
      const existing = lanes.indexOf(parent);
      if (existing !== -1) {
        // 既に別の子が同じ親を待っているレーンへ合流させる。
        // ただし第一親がノードより右にいる場合は、左（ノードのレーン）へ詰め替えて
        // 幹が右へ流れていかないようにする。
        if (k === 0 && existing > lane) {
          lanes[existing] = null;
          lanes[lane] = parent;
          relocations.push({ from: existing, to: lane });
          forkOut.push(lane);
        } else {
          forkOut.push(existing);
        }
        return;
      }
      const target = k === 0 ? lane : firstFree(lanes);
      lanes[target] = parent;
      forkOut.push(target);
    });

    trimTrailing(lanes);
    const lanesBelow = [...lanes];

    laneCount = Math.max(laneCount, lanesAbove.length, lanesBelow.length, lane + 1);
    rows.push({ commit, lane, lanesAbove, lanesBelow, mergeIn, forkOut, relocations });
  }

  return { rows, laneCount };
}

const LANE_COLORS = [
  "#4c8dff",
  "#31c48d",
  "#f6a609",
  "#e05561",
  "#a78bfa",
  "#22b8cf",
  "#f472b6",
  "#84cc16",
];

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

export function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}
