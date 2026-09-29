/**
 * ブラウザで表示確認するための開発用 Git API。
 *
 * Tauri アプリでは Rust 側（src-tauri/src/git.rs）が同じ形の JSON を返す。
 * こちらは `git` コマンドを呼ぶだけの簡易版で、開発サーバでしか使わない。
 * 仕様の正は Rust 側にあるので、挙動が食い違ったら Rust 側に合わせること。
 */
import { execFileSync } from "node:child_process";

const UNIT = "\x1f"; // フィールド区切り
const RECORD = "\x1e"; // レコード区切り

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** `+09:00` → 540 */
function offsetMinutes(isoDate) {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(isoDate);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/** `%D` の装飾文字列を RefLabel の配列にする */
function parseRefs(decoration, remotes) {
  if (!decoration) return [];
  return decoration
    .split(", ")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      if (raw.startsWith("tag: ")) return { name: raw.slice(5), kind: "tag" };
      if (raw.startsWith("HEAD -> ")) return { name: raw.slice(8), kind: "head" };
      if (raw === "HEAD") return { name: "HEAD", kind: "head" };
      const remote = remotes.find((r) => raw.startsWith(`${r}/`));
      return { name: raw, kind: remote ? "remoteBranch" : "localBranch" };
    });
}

export function repoInfo(path) {
  const root = git(path, ["rev-parse", "--show-toplevel"]).trim();
  const remotes = git(root, ["remote"]).split("\n").filter(Boolean);
  let headBranch = null;
  let headCommit = null;
  let isDetached = false;
  let isEmpty = false;

  try {
    headCommit = git(root, ["rev-parse", "HEAD"]).trim();
    const name = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    isDetached = name === "HEAD";
    headBranch = isDetached ? null : name;
  } catch {
    isEmpty = true; // コミットが 1 件も無い
  }

  return { path: root, headBranch, headCommit, isDetached, isEmpty, remotes };
}

export function listCommits(path, limit) {
  const info = repoInfo(path);
  if (info.isEmpty) return [];

  const format = [
    "%H", // id
    "%P", // parents
    "%an",
    "%ae",
    "%at",
    "%aI",
    "%D", // refs
    "%s",
    "%b",
  ].join(UNIT);

  const raw = git(info.path, [
    "log",
    "--all",
    "--topo-order",
    `--max-count=${limit}`,
    `--pretty=format:${format}${RECORD}`,
  ]);

  return raw
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim() !== "")
    .map((record) => {
      const [id, parents, an, ae, at, aI, decoration, summary, body] = record.split(UNIT);
      return {
        id,
        shortId: id.slice(0, 7),
        summary: summary ?? "",
        body: body ?? "",
        authorName: an ?? "",
        authorEmail: ae ?? "",
        timestamp: Number(at ?? 0),
        offsetMinutes: offsetMinutes(aI ?? ""),
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        refs: parseRefs(decoration, info.remotes),
      };
    });
}

/** `git worktree list --porcelain` を解析する */
export function listWorktrees(path) {
  const info = repoInfo(path);
  const raw = git(info.path, ["worktree", "list", "--porcelain"]);
  const list = [];
  let current = null;

  const flush = () => {
    if (current) list.push(current);
  };

  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        name: "",
        path: line.slice(9).trim(),
        branch: null,
        head: null,
        isMain: list.length === 0,
        isDetached: false,
        isLocked: false,
        lockReason: null,
        isPrunable: false,
      };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    } else if (line.trim() === "detached") {
      current.isDetached = true;
    } else if (line.startsWith("locked")) {
      current.isLocked = true;
      current.lockReason = line.slice(6).trim() || null;
    } else if (line.trim() === "prunable" || line.startsWith("prunable ")) {
      current.isPrunable = true;
    }
  }
  flush();

  for (const wt of list) {
    wt.name = wt.isMain ? "(main)" : (wt.path.split(/[\/]/).filter(Boolean).pop() ?? wt.path);
  }
  return list;
}

export function listBranches(path) {
  const info = repoInfo(path);
  if (info.isEmpty) return [];

  // ブランチ名 -> それを開いているワークツリーのパス
  const byBranch = new Map();
  for (const wt of listWorktrees(info.path)) {
    if (wt.branch) byBranch.set(wt.branch, wt.path);
  }

  const format = [
    "%(refname)",
    "%(refname:short)",
    "%(objectname)",
    "%(upstream:short)",
    "%(committerdate:unix)",
    "%(contents:subject)",
    "%(authorname)",
    "%(HEAD)",
  ].join(UNIT);

  const raw = git(info.path, [
    "for-each-ref",
    `--format=${format}`,
    "refs/heads",
    "refs/remotes",
  ]).trim();
  if (raw === "") return [];

  return raw.split("\n").map((line) => {
    const [fullref, name, target, upstream, time, summary, author, head] = line.split(UNIT);
    const isHead = head === "*";
    // remote の設定有無に関わらず、refs/remotes/ 配下ならリモート追跡ブランチ
    const isRemote = fullref.startsWith("refs/remotes/");

    // --left-right --count は「左だけにある数」「右だけにある数」を返す
    let ahead = 0;
    let behind = 0;
    try {
      const counts = git(info.path, ["rev-list", "--left-right", "--count", `${target}...HEAD`]);
      [ahead, behind] = counts.trim().split(/\s+/).map(Number);
    } catch {
      // HEAD が無い等。0 のままにする
    }

    return {
      name,
      kind: isHead ? "head" : isRemote ? "remoteBranch" : "localBranch",
      target,
      isHead,
      upstream: upstream || null,
      merged: ahead === 0,
      ahead,
      behind,
      lastCommitTime: Number(time ?? 0),
      lastCommitSummary: summary ?? "",
      lastCommitAuthor: author ?? "",
      worktreePath: byBranch.get(name) ?? null,
    };
  });
}

/**
 * Vite の開発サーバに差し込むミドルウェア。
 * Tauri のコマンドと 1 対 1 で対応させてある。
 */
export function gitApiMiddleware(req, res, next) {
  if (!req.url?.startsWith("/__git/")) return next();

  const url = new URL(req.url, "http://localhost");
  const send = (status, payload) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
  };

  try {
    switch (url.pathname) {
      case "/__git/startup_repository":
        // ブラウザで開くリポジトリは環境変数で指定する
        return send(200, process.env.GIT_GRAPH_REPO ?? null);
      case "/__git/open_repository":
        return send(200, repoInfo(url.searchParams.get("path") ?? "."));
      case "/__git/list_branches":
        return send(200, listBranches(url.searchParams.get("path") ?? "."));
      case "/__git/list_worktrees":
        return send(200, listWorktrees(url.searchParams.get("path") ?? "."));
      case "/__git/list_commits":
        return send(
          200,
          listCommits(
            url.searchParams.get("path") ?? ".",
            Number(url.searchParams.get("limit") ?? 500),
          ),
        );
      default:
        return send(404, { error: "not found" });
    }
  } catch (e) {
    const stderr = String(e?.stderr ?? "").trim();
    return send(400, { error: stderr || String(e?.message ?? e) });
  }
}
