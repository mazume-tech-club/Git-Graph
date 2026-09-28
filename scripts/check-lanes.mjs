/**
 * レーン配置（src/graph/lanes.ts）の検証スクリプト。
 *
 *   node scripts/check-lanes.mjs [リポジトリのパス...]
 *
 * 実際の Git 履歴を読み込んでレーンを組み立て、不変条件を検査したうえで
 * ASCII のグラフを出力する。`git log --graph --topo-order` と見比べられる。
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repos = process.argv.slice(2);
if (repos.length === 0) repos.push(process.cwd());

// lanes.ts は TypeScript なので、その場でコンパイルして読み込む
const outDir = mkdtempSync(join(tmpdir(), "git-graph-check-"));
let buildGraph;
try {
  execSync(
    `npx tsc src/graph/lanes.ts --ignoreConfig --outDir "${outDir}"` +
      ` --module esnext --target es2022 --moduleResolution bundler --skipLibCheck`,
    { stdio: "inherit" },
  );
  ({ buildGraph } = await import(pathToFileURL(join(outDir, "graph", "lanes.js")).href));
} finally {
  process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));
}

function readCommits(repo) {
  let raw;
  try {
    raw = execSync(
      `git -C "${repo}" log --all --topo-order --pretty=format:%H%x09%P%x09%s`,
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (e) {
    // コミットが 1 件も無いリポジトリでは git log が失敗する
    const stderr = String(e.stderr ?? "");
    if (/does not have any commits yet|bad default revision/.test(stderr)) return [];
    throw new Error(`git log に失敗しました (${repo}): ${stderr.trim() || e.message}`);
  }
  if (raw === "") return [];
  return raw.split("\n").map((line) => {
    const [id, parents, summary = ""] = line.split("\t");
    return {
      id,
      shortId: id.slice(0, 7),
      summary,
      body: "",
      authorName: "",
      authorEmail: "",
      timestamp: 0,
      offsetMinutes: 0,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      refs: [],
    };
  });
}

function check(rows, commits) {
  const errors = [];
  const rowIndex = new Map(rows.map((r, i) => [r.commit.id, i]));
  const known = new Set(commits.map((c) => c.id));

  rows.forEach((row, i) => {
    const above = i === 0 ? [] : rows[i - 1].lanesBelow;

    // 1. 行の上端のレーンは、直前の行の下端と一致する
    if (JSON.stringify(row.lanesAbove) !== JSON.stringify(above))
      errors.push(`row ${i} (${row.commit.shortId}): lanesAbove が前行の lanesBelow と不一致`);

    // 2. このコミットを待っていたレーンは全て mergeIn に含まれる
    above.forEach((id, l) => {
      if (id === row.commit.id && !row.mergeIn.includes(l))
        errors.push(`row ${i}: レーン ${l} がこのコミットを待っているが mergeIn に無い`);
    });

    // 3. forkOut の各レーンは、対応する親を実際に待っている
    row.commit.parents.forEach((p, k) => {
      const l = row.forkOut[k];
      if (l === undefined) {
        errors.push(`row ${i}: 親 ${p.slice(0, 7)} に対応するレーンが無い`);
        return;
      }
      if (row.lanesBelow[l] !== p)
        errors.push(`row ${i}: レーン ${l} が親 ${p.slice(0, 7)} を待っていない`);
    });

    // 4. 第一親はノードのレーンを引き継ぐ（既に左のレーンで待たれている場合を除く）
    if (
      row.commit.parents.length > 0 &&
      row.forkOut[0] !== row.lane &&
      !(row.forkOut[0] < row.lane && above[row.forkOut[0]] === row.commit.parents[0])
    )
      errors.push(`row ${i}: 第一親がレーン ${row.lane} を引き継いでいない`);

    // 5. 親は必ず自分より下の行にある
    row.commit.parents.forEach((p) => {
      if (known.has(p) && rowIndex.get(p) <= i)
        errors.push(`row ${i}: 親 ${p.slice(0, 7)} が子より上の行にある`);
    });

    // 6. 詰め替えは左向きで、内容が引き継がれている
    row.relocations.forEach((r) => {
      if (r.to >= r.from) errors.push(`row ${i}: 詰め替えが左向きでない`);
      if (row.lanesBelow[r.to] !== above[r.from])
        errors.push(`row ${i}: 詰め替え先レーン ${r.to} が元の内容を引き継いでいない`);
      // 空いた元レーンは同じ行で別の親に再利用されてよい
      if (row.lanesBelow[r.from] != null && !row.forkOut.includes(r.from))
        errors.push(`row ${i}: 詰め替え元レーン ${r.from} が解放も再利用もされていない`);
    });
  });

  // 7. 履歴を全件読んだので、最終行の後に待ち状態のレーンは残らない
  const tail = rows.at(-1)?.lanesBelow.filter((x) => x !== null) ?? [];
  if (tail.length > 0) errors.push(`最終行の後に未解決レーンが ${tail.length} 本残っている`);

  return errors;
}

function render(rows, laneCount, limit) {
  return rows
    .slice(0, limit)
    .map((row) => {
      const cells = Array.from({ length: laneCount }, (_, l) => {
        if (l === row.lane) return row.commit.parents.length > 1 ? "M" : "*";
        const above = row.lanesAbove[l] != null;
        const below = row.lanesBelow[l] != null;
        if (above && below) return "|";
        return above || below ? ":" : " ";
      });
      return `${cells.join(" ")}  ${row.commit.shortId} ${row.commit.summary.slice(0, 50)}`;
    })
    .join("\n");
}

const showGraph = process.env.SHOW_GRAPH === "1";
let failed = 0;

for (const repo of repos) {
  const commits = readCommits(repo);
  if (commits.length === 0) {
    console.log(`SKIP ${repo}: コミットがありません`);
    continue;
  }
  const { rows, laneCount } = buildGraph(commits);
  const errors = check(rows, commits);
  if (showGraph && rows.length > 0) console.log(render(rows, laneCount, 40));
  const head = `${repo}: ${rows.length} commits, ${laneCount} lanes`;
  if (errors.length === 0) {
    console.log(`OK   ${head}`);
  } else {
    failed += 1;
    console.log(`NG   ${head}\n     ${errors.slice(0, 10).join("\n     ")}`);
    if (errors.length > 10) console.log(`     ... 他 ${errors.length - 10} 件`);
  }
}

process.exit(failed === 0 ? 0 : 1);
