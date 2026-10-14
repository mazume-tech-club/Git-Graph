/**
 * 差分ビューアの表示ロジック（src/diffRows.ts と src/highlight.ts）の検査スクリプト。
 *
 *   node scripts/check-diff.mjs
 *
 * 左右に並べる組み立て、行内の強調範囲、ハイライト結果の行分割を固定の入力で確かめる。
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// TypeScript なのでその場でコンパイルする。highlight.js を解決できるよう、
// 出力先はプロジェクトの node_modules 配下に置く
const cacheDir = join(process.cwd(), "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, "git-graph-check-diff-"));
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));
execSync(
  `npx tsc src/diffRows.ts src/highlight.ts --ignoreConfig --outDir "${outDir}"` +
    ` --module esnext --target es2022 --moduleResolution bundler --skipLibCheck`,
  { stdio: "inherit" },
);
const load = (name) => import(pathToFileURL(join(outDir, name)).href);
const { splitRows, blockStarts, wordDiff, intralineRanges } = await load("diffRows.js");
const { splitHighlighted, highlightLines, languageFor, buildHighlight, segmentsFor } =
  await load("highlight.js");

const ctx = (content, o, n) => ({ kind: "context", oldLineno: o, newLineno: n, content });
const del = (content, o) => ({ kind: "deletion", oldLineno: o, newLineno: null, content });
const add = (content, n) => ({ kind: "addition", oldLineno: null, newLineno: n, content });

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`OK   ${name}`);
}

check("削除と追加を上から順に組にし、余りは反対側を空ける", () => {
  const lines = [ctx("a", 1, 1), del("b", 2), del("c", 3), add("B", 2), ctx("d", 4, 3)];
  const rows = splitRows(lines);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => [r.left?.content ?? null, r.right?.content ?? null, r.blockStart]),
    [
      ["a", "a", false],
      ["b", "B", true],
      ["c", null, false],
      ["d", "d", false],
    ],
  );
});

check("変更箇所の先頭だけに印を付ける", () => {
  const lines = [ctx("a", 1, 1), del("b", 2), add("B", 2), ctx("c", 3, 3), add("x", 4)];
  assert.deepEqual(blockStarts(lines), [false, true, false, false, true]);
});

check("変わった単語だけを範囲にする", () => {
  const diff = wordDiff('const NAME = "step1";', 'const NAME = "renamed-step1";');
  assert.ok(diff);
  const [oldRanges, newRanges] = diff;
  // step1 は前後で共通なので、挿入した「renamed-」だけが変わった部分になる
  assert.deepEqual(oldRanges, []);
  assert.deepEqual(newRanges, [[14, 22]]);

  const replaced = wordDiff("let total = count + 1;", "let total = amount + 1;");
  assert.deepEqual(replaced, [[[12, 17]], [[12, 18]]]); // count → amount
});

check("ほぼ書き換えた行は強調しない", () => {
  assert.equal(wordDiff("alpha beta gamma", "completely different words here"), null);
});

check("日本語は 1 文字ずつ比べる", () => {
  const diff = wordDiff("// 初期コミット", "// 最初のコミット");
  assert.ok(diff);
  const [oldRanges, newRanges] = diff;
  // 「初」が共通なので、変わったのは「期」と「最」「の」
  assert.deepEqual(oldRanges, [[4, 5]]);
  assert.deepEqual(newRanges, [
    [3, 4],
    [5, 6],
  ]);
});

check("行内の強調は組になった行にだけ付く", () => {
  const lines = [del("let a = 1;", 1), add("let a = 2;", 1), add("extra();", 2)];
  const ranges = intralineRanges(lines);
  assert.deepEqual(ranges[0], [[8, 9]]);
  assert.deepEqual(ranges[1], [[8, 9]]);
  assert.equal(ranges[2], undefined);
});

check("複数行にまたがる span は各行でクラスを引き継ぐ", () => {
  const lines = splitHighlighted(
    'a<span class="hljs-comment">/* x\ny */</span>b &lt;&amp;&gt;\n',
  );
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], [
    { text: "a", cls: "" },
    { text: "/* x", cls: "hljs-comment" },
  ]);
  assert.deepEqual(lines[1], [
    { text: "y */", cls: "hljs-comment" },
    { text: "b <&>", cls: "" },
  ]);
  assert.deepEqual(lines[2], []);
});

check("ハイライトしても行の文字列は変わらない", () => {
  const source = 'fn main() {\n    /* a\n       b */\n    let s = "<&>";\n}';
  const lines = highlightLines(source, "rust");
  assert.deepEqual(
    lines.map((segs) => segs.map((s) => s.text).join("")),
    source.split("\n"),
  );
  assert.ok(lines[2].some((s) => s.cls.includes("hljs-comment")), "コメントの 2 行目も色が付く");
});

check("拡張子から言語を決める", () => {
  assert.equal(languageFor("src/App.tsx"), "typescript");
  assert.equal(languageFor("src-tauri/Cargo.toml"), "ini");
  assert.equal(languageFor("docker/Dockerfile"), "dockerfile");
  assert.equal(languageFor("README"), null);
  assert.equal(languageFor(".gitignore"), null);
});

check("全体の差分から変更前後の行に色を引ける", () => {
  const full = {
    hunks: [{ header: "", lines: [ctx("// c", 1, 1), del("let a = 1;", 2), add("let a = 2;", 2)] }],
    isBinary: false,
    truncated: false,
  };
  const highlight = buildHighlight(full, "typescript");
  const removed = segmentsFor(del("let a = 1;", 2), highlight);
  const added = segmentsFor(add("let a = 2;", 2), highlight);
  assert.ok(removed?.some((s) => s.cls.includes("hljs-keyword")));
  assert.ok(added?.some((s) => s.cls.includes("hljs-keyword")));
  // 中身が食い違う行には色を付けない
  assert.equal(segmentsFor(add("changed", 2), highlight), undefined);
});

console.log(`\n${passed} 件すべて成功`);
