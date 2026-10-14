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

/** 行の中で強調する範囲。文字位置（UTF-16 単位）の [start, end) */
export type Range = [number, number];

/** 単語単位の比較をあきらめる計算量（トークン数の積）の上限。長い行で固まらないように */
const MAX_WORD_DIFF_CELLS = 250_000;
/** 変わらなかった文字がこの割合を切る行は、ほぼ書き換えなので強調しない */
const MIN_UNCHANGED_RATIO = 0.25;

/**
 * 英数字の並び、空白の並び、漢字・かなや記号の 1 文字をそれぞれ 1 トークンにする。
 * 漢字・かな（と長音符）は単語の区切りが無いので 1 文字ずつ比べる
 */
const TOKEN =
  /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー]|(?:(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー])[\p{L}\p{N}_])+|\s+|./gu;

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/**
 * 対になる削除行と追加行を単語単位で比べ、それぞれの変わった範囲を返す。
 * ほとんど書き換えている行や、長すぎて比べられない行は null（行全体の色だけにする）。
 */
export function wordDiff(oldText: string, newText: string): [Range[], Range[]] | null {
  const a = tokenize(oldText);
  const b = tokenize(newText);

  // 前後の一致部分は表を作らずに飛ばす
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length * midB.length > MAX_WORD_DIFF_CELLS) return null;

  // 最長共通部分列で、真ん中のどのトークンが共通かを決める
  const n = midA.length;
  const m = midB.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * (m + 1) + j] =
        midA[i] === midB[j]
          ? table[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
    }
  }
  const keepA = new Array<boolean>(a.length).fill(true);
  const keepB = new Array<boolean>(b.length).fill(true);
  for (let i = 0; i < n; i += 1) keepA[head + i] = false;
  for (let j = 0; j < m; j += 1) keepB[head + j] = false;
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (midA[i] === midB[j]) {
      keepA[head + i] = true;
      keepB[head + j] = true;
      i += 1;
      j += 1;
    } else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  const visible = (tokens: string[], keep: boolean[], kept: boolean) =>
    tokens.reduce((sum, t, i) => (keep[i] === kept && t.trim() !== "" ? sum + t.length : sum), 0);
  const unchanged = visible(a, keepA, true);
  const longest = Math.max(
    unchanged + visible(a, keepA, false),
    visible(b, keepB, true) + visible(b, keepB, false),
  );
  if (longest === 0 || unchanged / longest < MIN_UNCHANGED_RATIO) return null;

  return [toRanges(a, keepA), toRanges(b, keepB)];
}

/** 共通でないトークンの位置を、隣り合うものはつなげて範囲にする */
function toRanges(tokens: string[], keep: boolean[]): Range[] {
  const ranges: Range[] = [];
  let offset = 0;
  tokens.forEach((token, i) => {
    const end = offset + token.length;
    if (!keep[i]) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === offset) last[1] = end;
      else ranges.push([offset, end]);
    }
    offset = end;
  });
  return ranges;
}

/**
 * ハンクの各行について、行内で強調する範囲。変更箇所の中で上から順に削除行と追加行を
 * 組にして比べる（左右に並べる表示と同じ組み方）。組にならない行や比べられない行は undefined。
 */
export function intralineRanges(lines: DiffLine[]): (Range[] | undefined)[] {
  const result = new Array<Range[] | undefined>(lines.length);
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === "context") {
      i += 1;
      continue;
    }
    const deletions: number[] = [];
    const additions: number[] = [];
    while (i < lines.length && lines[i].kind !== "context") {
      (lines[i].kind === "deletion" ? deletions : additions).push(i);
      i += 1;
    }
    const pairs = Math.min(deletions.length, additions.length);
    for (let j = 0; j < pairs; j += 1) {
      const diff = wordDiff(lines[deletions[j]].content, lines[additions[j]].content);
      if (!diff) continue;
      result[deletions[j]] = diff[0];
      result[additions[j]] = diff[1];
    }
  }
  return result;
}
