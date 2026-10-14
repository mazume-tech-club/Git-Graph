import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

import type { DiffLine, FileDiff } from "./types";

/**
 * 差分のシンタックスハイライト。
 *
 * 配布サイズを抑えるため、社内でよく使う言語だけを登録する。言語は拡張子だけで決め、
 * 自動判定はしない（遅いうえに外れると不自然な色になるため）。
 * 結果は HTML ではなく行ごとの部品（Segment）にして返し、React の要素として描く。
 */

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  php: "php",
  py: "python",
  sql: "sql",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  scss: "scss",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  md: "markdown",
  sh: "bash",
  bash: "bash",
  ps1: "powershell",
  psm1: "powershell",
  toml: "ini",
  ini: "ini",
};

/** ファイル名から言語を決める。対応していなければ null */
export function languageFor(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  if (/^dockerfile$/i.test(name) || /\.dockerfile$/i.test(name)) return "dockerfile";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** 1 行の中の、同じ色で描く一続きの文字列。`cls` は highlight.js のクラス名（無ければ空） */
export type Segment = { text: string; cls: string };

/** ファイル全体に色を付け、行ごとの部品に分けて返す。`text` の行数と同じ長さになる */
export function highlightLines(text: string, language: string): Segment[][] {
  const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  return splitHighlighted(html);
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
};

function unescape(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e] ?? e);
}

/**
 * highlight.js の出力（span の入れ子と、エスケープ済みの文字列）を行ごとの部品に分ける。
 * 複数行にまたがる span（ブロックコメントなど）は、各行で同じクラスを引き継ぐ。
 */
export function splitHighlighted(html: string): Segment[][] {
  const lines: Segment[][] = [[]];
  const stack: string[] = [];
  const pattern = /<span class="([^"]*)">|<\/span>|[^<]+/g;
  for (const match of html.matchAll(pattern)) {
    if (match[1] !== undefined) {
      stack.push(match[1]);
      continue;
    }
    if (match[0] === "</span>") {
      stack.pop();
      continue;
    }
    const cls = stack.join(" ");
    unescape(match[0])
      .split("\n")
      .forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part !== "") lines[lines.length - 1].push({ text: part, cls });
      });
  }
  return lines;
}

/** 行番号 → その行の部品。変更前と変更後それぞれのファイルについて持つ */
export type Highlight = {
  old: Map<number, Segment[]>;
  new: Map<number, Segment[]>;
};

/**
 * ファイル全体の差分から、変更前・変更後のファイルを組み立てて色を付ける。
 * 断片ごとに色を付けるとブロックコメントの途中などで崩れるため、必ず全文に付ける。
 */
export function buildHighlight(full: FileDiff, language: string): Highlight {
  const oldLines: DiffLine[] = [];
  const newLines: DiffLine[] = [];
  for (const hunk of full.hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "addition") oldLines.push(line);
      if (line.kind !== "deletion") newLines.push(line);
    }
  }
  const paint = (lines: DiffLine[], lineno: (l: DiffLine) => number | null) => {
    const map = new Map<number, Segment[]>();
    if (lines.length === 0) return map;
    const segments = highlightLines(lines.map((l) => l.content).join("\n"), language);
    lines.forEach((line, i) => {
      const no = lineno(line);
      if (no !== null) map.set(no, segments[i] ?? []);
    });
    return map;
  };
  return {
    old: paint(oldLines, (l) => l.oldLineno),
    new: paint(newLines, (l) => l.newLineno),
  };
}

/** 表示する行に対応する部品。削除行は変更前、それ以外は変更後のファイルから引く */
export function segmentsFor(line: DiffLine, highlight: Highlight | null): Segment[] | undefined {
  if (!highlight) return undefined;
  const segments =
    line.kind === "deletion"
      ? line.oldLineno !== null
        ? highlight.old.get(line.oldLineno)
        : undefined
      : line.newLineno !== null
        ? highlight.new.get(line.newLineno)
        : undefined;
  // 自動更新の途中などで中身が食い違っていたら色は付けない
  if (!segments || segments.map((s) => s.text).join("") !== line.content) return undefined;
  return segments;
}
