import type { DiffLine } from "./types";

/** 左右に並べる表示の 1 行。片側に対応する行が無いときは null */
export type SplitRow = {
  left: DiffLine | null;
  right: DiffLine | null;
  /** 変更箇所（連続する追加・削除）の先頭か。前後の変更箇所へ移動するときの目印 */
  blockStart: boolean;
};

/**
 * 各行が変更箇所の先頭かどうか。ユニファイド表示で前後の変更箇所へ移動するのに使う。
 * 削除と追加が続くひとまとまりを 1 つの変更箇所として数える。
 */
export function blockStarts(lines: DiffLine[]): boolean[] {
  return lines.map(
    (line, i) => line.kind !== "context" && (i === 0 || lines[i - 1].kind === "context"),
  );
}

/**
 * ハンクの行を左右に並べる。変更前を左、変更後を右に置く。
 *
 * 変わらない行は左右に同じ行を出す。連続する削除と追加は上から順に組にし、
 * 数が合わない分は反対側を空ける。
 */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "context") {
      rows.push({ left: line, right: line, blockStart: false });
      i += 1;
      continue;
    }

    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (i < lines.length && lines[i].kind !== "context") {
      (lines[i].kind === "deletion" ? deletions : additions).push(lines[i]);
      i += 1;
    }
    const count = Math.max(deletions.length, additions.length);
    for (let j = 0; j < count; j += 1) {
      rows.push({
        left: deletions[j] ?? null,
        right: additions[j] ?? null,
        blockStart: j === 0,
      });
    }
  }
  return rows;
}
