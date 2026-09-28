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
