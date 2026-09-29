export type RefKind = "head" | "localBranch" | "remoteBranch" | "tag";

export type RefLabel = {
  name: string;
  kind: RefKind;
};

export type Commit = {
  id: string;
  shortId: string;
  summary: string;
  body: string;
  authorName: string;
  authorEmail: string;
  /** author date（UNIX 秒） */
  timestamp: number;
  /** タイムゾーンオフセット（分） */
  offsetMinutes: number;
  /** 親コミットの ID。先頭が第一親 */
  parents: string[];
  refs: RefLabel[];
};

export type RepoInfo = {
  path: string;
  headBranch: string | null;
  headCommit: string | null;
  isDetached: boolean;
  isEmpty: boolean;
};

export type BranchInfo = {
  name: string;
  kind: RefKind;
  /** ブランチが指すコミット ID */
  target: string;
  isHead: boolean;
  /** 追跡しているリモートブランチ名 */
  upstream: string | null;
  /** HEAD に取り込み済みか */
  merged: boolean;
  /** HEAD を基準にした差分。ahead = HEAD に無いコミット数 */
  ahead: number;
  behind: number;
  lastCommitTime: number;
  lastCommitSummary: string;
  lastCommitAuthor: string;
  /** このブランチをチェックアウトしているワークツリーのパス */
  worktreePath: string | null;
};

export type WorktreeInfo = {
  name: string;
  path: string;
  branch: string | null;
  head: string | null;
  isMain: boolean;
  isDetached: boolean;
  isLocked: boolean;
  lockReason: string | null;
  /** 作業ディレクトリが失われている等で git worktree prune の対象になるか */
  isPrunable: boolean;
};

export type ChangeStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied"
  | "typeChange"
  | "untracked"
  | "other";

export type FileChange = {
  path: string;
  /** リネーム / コピー元のパス */
  oldPath: string | null;
  status: ChangeStatus;
  insertions: number;
  deletions: number;
  isBinary: boolean;
};

export type DiffSummary = {
  files: FileChange[];
  insertions: number;
  deletions: number;
  /** マージコミットを第一親と比較しているか */
  againstFirstParent: boolean;
};

export type LineKind = "context" | "addition" | "deletion";

export type DiffLine = {
  kind: LineKind;
  oldLineno: number | null;
  newLineno: number | null;
  content: string;
};

export type DiffHunk = {
  header: string;
  lines: DiffLine[];
};

export type FileDiff = {
  hunks: DiffHunk[];
  isBinary: boolean;
  /** 行数が多すぎて打ち切ったか */
  truncated: boolean;
};

export type RepoFingerprint = {
  /** 全 ref をまとめたダイジェスト */
  refs: string;
  head: string | null;
  worktrees: number;
};
