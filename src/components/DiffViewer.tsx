import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fileDiff } from "../api";
import { blockStarts, splitRows } from "../diffRows";
import type { DiffHunk, DiffLine, FileDiff } from "../types";
import { FileCounts, STATUS_LABEL, type DiffComparison } from "./DiffPane";

const MODE_KEY = "git-graph:diff-mode";
const WRAP_KEY = "git-graph:diff-wrap";
/** 作業ツリーの差分を開いているときに取り直す間隔。未コミット件数の数え直しと揃える */
const POLL_INTERVAL_MS = 15_000;
/** 前後の変更箇所へ移動したとき、変更箇所の上に残す余白 */
const JUMP_MARGIN_PX = 40;

type Mode = "unified" | "split";

function readMode(): Mode {
  return localStorage.getItem(MODE_KEY) === "split" ? "split" : "unified";
}

function readWrap(): boolean {
  return localStorage.getItem(WRAP_KEY) === "1";
}

/** 比較の内容を短く言い表す。どの差分を見ているかをヘッダーに出すため */
function comparisonLabel({ from, to }: DiffComparison): string {
  if (to === null) return "作業ツリーの変更";
  if (from === null) return `${to.slice(0, 7)} の変更`;
  return `${from.slice(0, 7)} → ${to.slice(0, 7)}`;
}

type Props = {
  repoPath: string;
  comparison: DiffComparison;
  file: string;
  height: number;
  /** 定期的に取り直してよいか（表示中のタブか） */
  active: boolean;
  onSelectFile: (path: string) => void;
  onClose: () => void;
};

/**
 * 差分ビューア。グラフの下に開き、1 ファイル分の差分を広く表示する。
 * グラフで別のコミットを選ぶと、同じパスのファイルの差分に切り替わる。
 */
export function DiffViewer({
  repoPath,
  comparison,
  file,
  height,
  active,
  onSelectFile,
  onClose,
}: Props) {
  const { from, to, summary } = comparison;
  const [mode, setMode] = useState<Mode>(readMode);
  const [wrap, setWrap] = useState(readWrap);
  const [fullFile, setFullFile] = useState(false);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 前後の変更箇所へ移動するときにスクロールさせる要素 */
  const scrollerRef = useRef<HTMLDivElement>(null);

  const files = summary.files;
  const index = files.findIndex((f) => f.path === file);
  const change = index >= 0 ? files[index] : null;

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem(WRAP_KEY, wrap ? "1" : "0");
  }, [wrap]);

  // ファイルを開いたらキー操作をすぐ受けられるようにする
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [file]);

  const inSummary = change !== null;
  const oldPath = change?.oldPath ?? null;
  useEffect(() => {
    setDiff(null);
    setError(null);
    if (!inSummary) return;
    let cancelled = false;
    fileDiff(repoPath, from, to, file, oldPath, fullFile)
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [repoPath, from, to, file, oldPath, fullFile, inSummary]);

  // 作業ツリーの差分は編集で中身が変わるので、開いている 1 ファイル分だけ取り直す。
  // 表示中の内容を消さずに差し替えるので、スクロール位置はそのまま残る
  useEffect(() => {
    if (to !== null || !active || !inSummary) return;
    let stopped = false;
    const id = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void fileDiff(repoPath, from, null, file, oldPath, fullFile)
        .then((d) => !stopped && setDiff(d))
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [repoPath, from, to, file, oldPath, fullFile, active, inSummary]);

  const prevFile = index > 0 ? files[index - 1] : index < 0 ? files[files.length - 1] : null;
  const nextFile = index < 0 ? files[0] : (files[index + 1] ?? null);

  /** 前後の変更箇所へ移動する。変更箇所の先頭行には data-change が付いている */
  const jumpToChange = useCallback((direction: 1 | -1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const tops = Array.from(scroller.querySelectorAll<HTMLElement>("[data-change]")).map(
      (el) => el.getBoundingClientRect().top - base,
    );
    const anchor = scroller.scrollTop + JUMP_MARGIN_PX;
    const target =
      direction === 1 ? tops.find((t) => t > anchor + 1) : tops.reverse().find((t) => t < anchor - 1);
    if (target !== undefined) scroller.scrollTop = Math.max(0, target - JUMP_MARGIN_PX);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target instanceof HTMLInputElement && e.key !== "Escape") return;
    switch (e.key) {
      case "Escape":
        onClose();
        break;
      case "[":
        if (prevFile) onSelectFile(prevFile.path);
        break;
      case "]":
        if (nextFile) onSelectFile(nextFile.path);
        break;
      case "n":
        jumpToChange(1);
        break;
      case "p":
        jumpToChange(-1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div
      className="diff-viewer"
      style={{ height }}
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label="差分ビューア"
    >
      <div className="viewer-bar">
        {change && (
          <span className={`file-status status-${change.status}`}>
            {STATUS_LABEL[change.status]}
          </span>
        )}
        <span className="viewer-path" title={change?.oldPath ? `${change.oldPath} → ${file}` : file}>
          {change?.oldPath && <span className="muted">{change.oldPath} → </span>}
          {file}
        </span>
        {change && <FileCounts change={change} />}
        <span className="viewer-range">{comparisonLabel(comparison)}</span>

        <span className="viewer-spacer" />

        <div className="viewer-group">
          <button
            type="button"
            disabled={!prevFile}
            onClick={() => prevFile && onSelectFile(prevFile.path)}
            title="前のファイル（[）"
          >
            ‹ 前
          </button>
          <span className="viewer-index">
            {index >= 0 ? index + 1 : "-"} / {files.length}
          </span>
          <button
            type="button"
            disabled={!nextFile}
            onClick={() => nextFile && onSelectFile(nextFile.path)}
            title="次のファイル（]）"
          >
            次 ›
          </button>
        </div>

        <div className="viewer-group" role="radiogroup" aria-label="表示形式">
          <button
            type="button"
            role="radio"
            aria-checked={mode === "unified"}
            className={mode === "unified" ? "active" : ""}
            onClick={() => setMode("unified")}
          >
            ユニファイド
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "split"}
            className={mode === "split" ? "active" : ""}
            onClick={() => setMode("split")}
          >
            左右に並べる
          </button>
        </div>

        <label className="viewer-check">
          <input
            type="checkbox"
            checked={fullFile}
            onChange={(e) => setFullFile(e.target.checked)}
          />
          ファイル全体
        </label>
        <label className="viewer-check">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
          折り返す
        </label>

        <button
          type="button"
          className="viewer-close"
          onClick={onClose}
          title="閉じる（Esc）"
          aria-label="差分ビューアを閉じる"
        >
          ×
        </button>
      </div>

      <ViewerBody
        file={file}
        label={comparisonLabel(comparison)}
        inSummary={inSummary}
        renamed={oldPath !== null}
        diff={diff}
        error={error}
        mode={mode}
        wrap={wrap}
        fullFile={fullFile}
        scrollerRef={scrollerRef}
      />
    </div>
  );
}

type BodyProps = {
  file: string;
  label: string;
  inSummary: boolean;
  /** 改名・複製か。内容に差が無いときの文言を変える */
  renamed: boolean;
  diff: FileDiff | null;
  error: string | null;
  mode: Mode;
  wrap: boolean;
  fullFile: boolean;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
};

function ViewerBody({
  file,
  label,
  inSummary,
  renamed,
  diff,
  error,
  mode,
  wrap,
  fullFile,
  scrollerRef,
}: BodyProps) {
  if (!inSummary) {
    return <p className="viewer-note">{file} は「{label}」では変更されていません。</p>;
  }
  if (error) return <p className="viewer-note error">{error}</p>;
  if (!diff) return <p className="viewer-note">読み込み中...</p>;
  if (diff.isBinary) {
    return <p className="viewer-note">バイナリファイルのため差分は表示できません。</p>;
  }
  if (diff.hunks.length === 0) {
    return (
      <p className="viewer-note">
        {renamed ? "パスが変わっただけで、内容の差分はありません。" : "内容の差分はありません。"}
      </p>
    );
  }

  const truncated = diff.truncated && (
    <p className="viewer-note">差分が大きいため途中までを表示しています。</p>
  );
  // 全体表示ではハンクが 1 つだけなので見出しは出さない
  const showHeader = !fullFile;

  if (mode === "split" && !wrap) {
    return (
      <SplitScrolled
        hunks={diff.hunks}
        showHeader={showHeader}
        scrollerRef={scrollerRef}
        footer={truncated}
      />
    );
  }

  return (
    <div className={`viewer-body${wrap ? " wrap" : ""}`} ref={scrollerRef}>
      <div className="viewer-lines">
        {diff.hunks.map((hunk, i) => (
          <div key={`${hunk.header}-${i}`}>
            {showHeader && <div className="hunk-header">{hunk.header}</div>}
            {mode === "split" ? <SplitWrapped hunk={hunk} /> : <UnifiedHunk hunk={hunk} />}
          </div>
        ))}
      </div>
      {truncated}
    </div>
  );
}

function sign(line: DiffLine): string {
  return line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
}

function UnifiedHunk({ hunk }: { hunk: DiffHunk }) {
  const starts = useMemo(() => blockStarts(hunk.lines), [hunk.lines]);
  return (
    <>
      {hunk.lines.map((line, j) => (
        <div className={`diff-line ${line.kind}`} key={j} data-change={starts[j] || undefined}>
          <span className="gutter">
            <span className="lineno">{line.oldLineno ?? ""}</span>
            <span className="lineno">{line.newLineno ?? ""}</span>
            <span className="sign">{sign(line)}</span>
          </span>
          <span className="code">{line.content}</span>
        </div>
      ))}
    </>
  );
}

/** 左右に並べる表示の片側の 1 行。対応する行が無いときは空けておく */
function SideLine({
  line,
  side,
  change,
}: {
  line: DiffLine | null;
  side: "old" | "new";
  change?: boolean;
}) {
  if (!line) {
    return (
      <div className="diff-line empty" data-change={change || undefined}>
        <span className="gutter">
          <span className="lineno" />
          <span className="sign" />
        </span>
        <span className="code"> </span>
      </div>
    );
  }
  return (
    <div className={`diff-line ${line.kind}`} data-change={change || undefined}>
      <span className="gutter">
        <span className="lineno">{side === "old" ? line.oldLineno : line.newLineno}</span>
        <span className="sign">{sign(line)}</span>
      </span>
      <span className="code">{line.content}</span>
    </div>
  );
}

/** 折り返すときの左右表示。行ごとに左右を並べ、高さは長い方に揃う */
function SplitWrapped({ hunk }: { hunk: DiffHunk }) {
  const rows = useMemo(() => splitRows(hunk.lines), [hunk.lines]);
  return (
    <>
      {rows.map((row, j) => (
        <div className="split-row" key={j} data-change={row.blockStart || undefined}>
          <SideLine line={row.left} side="old" />
          <SideLine line={row.right} side="new" />
        </div>
      ))}
    </>
  );
}

/**
 * 折り返さないときの左右表示。左右を別々にスクロールできるようにし、
 * 片方を動かすともう片方も同じ位置へ動かす。
 */
function SplitScrolled({
  hunks,
  showHeader,
  scrollerRef,
  footer,
}: {
  hunks: DiffHunk[];
  showHeader: boolean;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  footer: React.ReactNode;
}) {
  const rows = useMemo(() => hunks.map((h) => splitRows(h.lines)), [hunks]);
  const rightRef = useRef<HTMLDivElement>(null);
  /** こちらから動かしたことで起きるスクロールイベント。打ち返すと位置が戻されるので無視する */
  const echo = useRef({ left: false, right: false });

  const sync = (source: "left" | "right") => () => {
    const target = source === "left" ? "right" : "left";
    if (echo.current[source]) {
      echo.current[source] = false;
      return;
    }
    const a = source === "left" ? scrollerRef.current : rightRef.current;
    const b = source === "left" ? rightRef.current : scrollerRef.current;
    if (!a || !b) return;
    const before = [b.scrollTop, b.scrollLeft];
    b.scrollTop = a.scrollTop;
    b.scrollLeft = a.scrollLeft;
    if (b.scrollTop !== before[0] || b.scrollLeft !== before[1]) echo.current[target] = true;
  };

  const side = (which: "old" | "new") => (
    <div className="viewer-lines">
      {hunks.map((hunk, i) => (
        <div key={`${hunk.header}-${i}`}>
          {showHeader && <div className="hunk-header">{hunk.header}</div>}
          {rows[i].map((row, j) => (
            <SideLine
              key={j}
              line={which === "old" ? row.left : row.right}
              side={which}
              change={row.blockStart}
            />
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <div className="viewer-split">
      <div className="viewer-body split-side" ref={scrollerRef} onScroll={sync("left")}>
        {side("old")}
        {footer}
      </div>
      <div className="viewer-body split-side" ref={rightRef} onScroll={sync("right")}>
        {side("new")}
        {footer}
      </div>
    </div>
  );
}
