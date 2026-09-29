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

/** git が扱う空ツリーのハッシュ。ルートコミットの比較相手に使う */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * 比較する 2 点を git diff の引数に落とす。
 * Rust 側（build_diff）と同じ規則。
 */
function diffRange(repo, from, to) {
  if (!to) return [from ?? "HEAD"];
  if (from) return [from, to];
  try {
    const parent = git(repo, ["rev-parse", `${to}^`]).trim();
    return [parent, to];
  } catch {
    return [EMPTY_TREE, to]; // ルートコミット
  }
}

function parentCount(repo, rev) {
  try {
    return git(repo, ["rev-list", "--parents", "-n", "1", rev]).trim().split(/\s+/).length - 1;
  } catch {
    return 0;
  }
}

/**
 * `git diff --patch` の出力をファイル単位に分解する。
 * Rust 側が返す構造（FileChange / DiffHunk / DiffLine）に合わせてある。
 */
function parsePatch(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;

  const pushFile = () => {
    if (file) files.push(file);
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      pushFile();
      hunk = null;
      file = {
        path: "",
        oldPath: null,
        status: "modified",
        insertions: 0,
        deletions: 0,
        isBinary: false,
        hunks: [],
      };
      // `diff --git a/foo b/bar` の b 側を採用する
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m) {
        file.oldPath = m[1];
        file.path = m[2];
      }
      continue;
    }
    if (!file) continue;

    if (line.startsWith("new file mode")) {
      file.status = "added";
      file.oldPath = null;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
      file.path = file.oldPath ?? file.path;
      file.oldPath = null;
      continue;
    }
    if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = line.slice(12);
      continue;
    }
    if (line.startsWith("rename to ")) {
      file.path = line.slice(10);
      continue;
    }
    if (line.startsWith("copy from ")) {
      file.status = "copied";
      file.oldPath = line.slice(10);
      continue;
    }
    if (line.startsWith("Binary files ")) {
      file.isBinary = true;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("+")) {
      file.insertions += 1;
      hunk.lines.push({
        kind: "addition",
        oldLineno: null,
        newLineno: newNo++,
        content: line.slice(1),
      });
    } else if (line.startsWith("-")) {
      file.deletions += 1;
      hunk.lines.push({
        kind: "deletion",
        oldLineno: oldNo++,
        newLineno: null,
        content: line.slice(1),
      });
    } else if (line.startsWith(" ")) {
      hunk.lines.push({
        kind: "context",
        oldLineno: oldNo++,
        newLineno: newNo++,
        content: line.slice(1),
      });
    }
    // "\ No newline at end of file" は無視する
  }

  pushFile();
  // 変更が無いのに diff --git だけ出るケース（モード変更のみ等）は落とさない
  return files.filter((f) => f.path !== "");
}

function runPatch(repo, from, to, file) {
  const args = ["diff", "--patch", "--find-renames", "--no-color", ...diffRange(repo, from, to)];
  if (file) args.push("--", file);
  return git(repo, args);
}

/** 未追跡ファイル（作業ツリーとの比較でのみ現れる） */
function untrackedFiles(repo) {
  const raw = git(repo, ["ls-files", "--others", "--exclude-standard"]).trim();
  return raw === "" ? [] : raw.split("\n").filter(Boolean);
}

export function diffSummary(path, from, to) {
  const info = repoInfo(path);
  if (info.isEmpty) {
    return { files: [], insertions: 0, deletions: 0, againstFirstParent: false };
  }

  const files = parsePatch(runPatch(info.path, from, to, null)).map((f) => ({
    path: f.path,
    oldPath: f.status === "renamed" || f.status === "copied" ? f.oldPath : null,
    status: f.status,
    insertions: f.insertions,
    deletions: f.deletions,
    isBinary: f.isBinary,
  }));

  if (!to) {
    for (const name of untrackedFiles(info.path)) {
      files.push({
        path: name,
        oldPath: null,
        status: "untracked",
        insertions: 0,
        deletions: 0,
        isBinary: false,
      });
    }
  }

  return {
    files,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    againstFirstParent: Boolean(to) && !from && parentCount(info.path, to) > 1,
  };
}

export function fileDiff(path, from, to, file) {
  const info = repoInfo(path);
  let parsed = parsePatch(runPatch(info.path, from, to, file));

  // 未追跡ファイルは git diff に出てこないので、空との比較で取り直す
  if (parsed.length === 0 && !to && untrackedFiles(info.path).includes(file)) {
    try {
      git(info.path, ["diff", "--no-index", "--patch", "--no-color", "/dev/null", file]);
    } catch (e) {
      // --no-index は差分があると終了コード 1 を返すので、出力だけ拾う
      parsed = parsePatch(String(e.stdout ?? ""));
    }
  }

  const target = parsed.find((f) => f.path === file || f.oldPath === file);
  return {
    hunks: target?.hunks ?? [],
    isBinary: target?.isBinary ?? false,
    truncated: false,
  };
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
      case "/__git/diff_summary":
        return send(
          200,
          diffSummary(
            url.searchParams.get("path") ?? ".",
            url.searchParams.get("from"),
            url.searchParams.get("to"),
          ),
        );
      case "/__git/file_diff":
        return send(
          200,
          fileDiff(
            url.searchParams.get("path") ?? ".",
            url.searchParams.get("from"),
            url.searchParams.get("to"),
            url.searchParams.get("file") ?? "",
          ),
        );
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
