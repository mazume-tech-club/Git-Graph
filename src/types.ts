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
  /** マージ基準に取り込み済みか */
  merged: boolean;
  /** マージ基準との差分。ahead = マージ基準に無いコミット数 */
  ahead: number;
  behind: number;
  /** このブランチ自身がマージ基準か */
  isMergeBase: boolean;
  /** 上流に無いコミットがあるか（上流が無いローカルブランチも true）。リモート追跡ブランチは false */
  unpushed: boolean;
  lastCommitTime: number;
  lastCommitSummary: string;
  lastCommitAuthor: string;
  /** `git branch --edit-description` で設定される説明 */
  description: string | null;
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
  /** チェックアウト中のブランチに付けられた説明 */
  description: string | null;
  /** HEAD のコミットメッセージ（1 行目） */
  headSummary: string | null;
  headTime: number | null;
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

export type ThemeMode = "light" | "dark" | "system" | "custom";

export type ThemeSettings = {
  mode: ThemeMode;
  /** カスタムのときの基調色（`#rrggbb`） */
  baseColor: string;
};

/** 設定ファイルの内容。Rust 側の `settings::Settings` と 1 対 1 */
export type Settings = {
  theme: ThemeSettings;
  repositories: RepositorySettings[];
};

export type MergeBaseSource = "setting" | "auto" | "head";

/** 「取り込まれたか」を判定する相手となる統合ブランチ */
export type MergeBaseInfo = {
  /** ローカルブランチ名。HEAD を使うときは null */
  name: string | null;
  commit: string | null;
  source: MergeBaseSource;
  /** 設定で指定された名前がローカルブランチとして存在しなかったか */
  settingMissing: boolean;
};

/** ワークツリー 1 つ分の未コミット変更の件数 */
export type WorktreeChanges = {
  path: string;
  /** 変更ファイル数。ワークツリーを開けなかったときは null */
  changes: number | null;
};

/** リポジトリごとの設定 */
export type RepositorySettings = {
  path: string;
  /** マージ基準のローカルブランチ名。null なら自動検出 */
  mergeBase: string | null;
};
