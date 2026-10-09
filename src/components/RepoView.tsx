import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  isBrowserPreview,
  listBranches,
  listCommits,
  listWorktreeChanges,
  listWorktrees,
  mergeBaseInfo,
  openRepository,
  repoFingerprint,
  setBranchDescription,
  worktreeChangeCount,
} from "../api";
import { changesByPath } from "../branchState";
import { buildGraph } from "../graph/lanes";
import type { TabSpec } from "../tabs";
import type {
  BranchInfo,
  Commit,
  MergeBaseInfo,
  RepoFingerprint,
  RepoInfo,
  WorktreeChanges,
  WorktreeInfo,
} from "../types";
import { CommitList, type CommitListHandle } from "./CommitList";
import { Sidebar, type SidebarTab } from "./Sidebar";

const COMMIT_LIMIT = 500;
const SIDEBAR_WIDTH_KEY = "git-graph:sidebar-width";
const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 720;
/** ref の変化を見に行く間隔 */
const REFRESH_INTERVAL_MS = 5_000;
/** 未コミットの変更を数え直す間隔。ref より重いので間隔を広くとる */
const WORKTREE_INTERVAL_MS = 15_000;
/** 全ワークツリーの未コミット変更を数え直す間隔。主状態「作業中」の鮮度 */
const DIRTY_INTERVAL_MS = 30_000;

function readStoredWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return 380;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw));
}

type Props = {
  /** 開くパス。ワークツリーのパスならそのワークツリーの HEAD と未コミット変更が基準になる */
  path: string;
  /** ブランチビューのとき、絞り込むブランチ名 */
  focusBranch: string | null;
  /** 表示中のタブか。隠れている間はポーリングを止める */
  active: boolean;
  /** 設定に記録されたマージ基準（null なら自動検出）。変わったら一覧を判定し直す */
  preferredMergeBase: string | null;
  /** リポジトリを開けたときに呼ぶ。登録に使う */
  onOpened: (info: RepoInfo) => void;
  onChangeMergeBase: (mainPath: string, name: string | null) => void;
  onOpenTab: (tab: TabSpec) => void;
};

/**
 * 1 つのビュー（ワークツリービュー / ブランチビュー）の本体。
 * コミットグラフ、サイドバー、自動更新のポーリングを持つ。
 */
export function RepoView({
  path,
  focusBranch,
  active,
  preferredMergeBase,
  onOpened,
  onChangeMergeBase,
  onOpenTab,
}: Props) {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [mergeBase, setMergeBase] = useState<MergeBaseInfo | null>(null);
  /** 全ワークツリーの未コミット変更の件数。主状態「作業中」の判定に使う */
  const [dirtyList, setDirtyList] = useState<WorktreeChanges[]>([]);
  /** 一覧で選んだブランチ名。グラフの行を選ぶと解除される */
  const [selectedBranchName, setSelectedBranchName] = useState<string | null>(focusBranch);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [worktreeSelected, setWorktreeSelected] = useState(false);
  const [compareBase, setCompareBase] = useState<string | null>(null);
  /** 作業ツリーで変更されているファイル数。中身は選んだときに別途取る */
  const [worktreeChanges, setWorktreeChanges] = useState(0);
  const [tab, setTab] = useState<SidebarTab>(focusBranch ? "detail" : "branches");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth);
  /** 最後にリポジトリの変化を確認できた時刻。ポーリングが生きていることの目印 */
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const contentRef = useRef<HTMLElement>(null);
  const listRef = useRef<CommitListHandle>(null);
  // 読み込み処理から最新のマージ基準設定を参照するための控え
  const preferredRef = useRef(preferredMergeBase);
  preferredRef.current = preferredMergeBase;
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;

  /**
   * リポジトリを読み直す。
   * - `keepSelection` … 選択中のコミットを維持する（自動更新用）
   */
  const load = useCallback(
    async ({ keepSelection = false } = {}) => {
      if (!keepSelection) setLoading(true);
      setError(null);
      try {
        const info = await openRepository(path);
        const preferred = preferredRef.current;
        const [list, base, branchList, worktreeList, changes, dirty] = await Promise.all([
          listCommits(info.path, COMMIT_LIMIT, focusBranch),
          mergeBaseInfo(info.path, preferred),
          listBranches(info.path, preferred),
          listWorktrees(info.path),
          // 未コミットの変更。件数だけ先に出して、中身は開いたときに取る
          worktreeChangeCount(info.path).catch(() => 0),
          listWorktreeChanges(info.path).catch(() => []),
        ]);
        setRepo(info);
        setCommits(list);
        setMergeBase(base);
        setBranches(branchList);
        setWorktrees(worktreeList);
        setWorktreeChanges(changes);
        setDirtyList(dirty);
        setCheckedAt(Date.now());
        if (keepSelection) {
          // 選択中のコミットが消えていたら先頭に戻す
          setSelectedId((prev) =>
            prev && list.some((c) => c.id === prev) ? prev : (list[0]?.id ?? null),
          );
          // 選んでいたブランチが消えていたら解除する
          setSelectedBranchName((prev) =>
            prev && branchList.some((b) => b.name === prev) ? prev : null,
          );
        } else {
          setSelectedId(list.length > 0 ? list[0].id : null);
          setSelectedBranchName(focusBranch);
          setWorktreeSelected(false);
          setCompareBase(null);
          onOpenedRef.current(info);
        }
      } catch (e) {
        setError(String(e));
        setRepo(null);
        setCommits([]);
        setBranches([]);
        setWorktrees([]);
        setMergeBase(null);
        setDirtyList([]);
        setWorktreeChanges(0);
        setSelectedId(null);
        setSelectedBranchName(null);
      } finally {
        setLoading(false);
      }
    },
    [path, focusBranch],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const graph = useMemo(() => buildGraph(commits), [commits]);
  const selected = useMemo(
    () => commits.find((c) => c.id === selectedId) ?? null,
    [commits, selectedId],
  );

  /** ブランチ・ワークツリーからコミットを選ぶ。一覧の該当行までスクロールする */
  const revealCommit = useCallback(
    (id: string) => {
      if (!commits.some((c) => c.id === id)) {
        setNotice(
          focusBranch
            ? `このコミットはブランチ ${focusBranch} の表示範囲に含まれていません。`
            : `このコミットは表示範囲（最新 ${COMMIT_LIMIT} 件）に含まれていません。`,
        );
        return;
      }
      setNotice(null);
      setWorktreeSelected(false);
      setSelectedId(id);
      listRef.current?.scrollToCommit(id);
    },
    [commits, focusBranch],
  );

  /** グラフの行を選ぶ。行コンポーネントの memo を効かせるため参照を固定する */
  const selectCommit = useCallback((id: string) => {
    setWorktreeSelected(false);
    setSelectedBranchName(null);
    setSelectedId(id);
    setTab("detail");
  }, []);

  const selectWorktree = useCallback(() => {
    setWorktreeSelected(true);
    setSelectedBranchName(null);
    setTab("detail");
  }, []);

  /** 一覧でブランチを選ぶ。グラフは先端へ飛ばし、詳細にはブランチの変更内容を出す */
  const selectBranch = useCallback(
    (branch: BranchInfo) => {
      revealCommit(branch.target);
      setSelectedBranchName(branch.name);
      setTab("detail");
    },
    [revealCommit],
  );

  /** ブランチとワークツリーの一覧だけを取り直す（コミットは変わっていないとき用） */
  const reloadLists = useCallback(async () => {
    const preferred = preferredRef.current;
    const [base, branchList, worktreeList, dirty] = await Promise.all([
      mergeBaseInfo(path, preferred),
      listBranches(path, preferred),
      listWorktrees(path),
      listWorktreeChanges(path).catch(() => []),
    ]);
    setMergeBase(base);
    setBranches(branchList);
    setWorktrees(worktreeList);
    setDirtyList(dirty);
  }, [path]);

  // 設定のマージ基準が（ホームや他のタブで）変わったら判定し直す
  const firstPreferred = useRef(true);
  useEffect(() => {
    if (firstPreferred.current) {
      firstPreferred.current = false;
      return;
    }
    if (!repo) return;
    reloadLists().catch((e) => setError(String(e)));
    // repo は依存に入れない。開き直しは load が担う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferredMergeBase, reloadLists]);

  const changeMergeBase = useCallback(
    (name: string | null) => {
      if (repo) onChangeMergeBase(repo.mainPath, name);
    },
    [repo, onChangeMergeBase],
  );

  /**
   * ブランチのメモを保存して一覧を取り直す。
   * ref は変わらないので自動更新では拾えないため、ここで明示的に読み直す。
   */
  const editDescription = useCallback(
    async (branch: string, description: string | null) => {
      if (!repo) return;
      try {
        await setBranchDescription(repo.path, branch, description);
        await reloadLists();
      } catch (e) {
        setError(String(e));
      }
    },
    [repo, reloadLists],
  );

  // サイドバーの幅をドラッグで変える
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = contentRef.current;
    if (!container) return;
    const onMove = (ev: PointerEvent) => {
      const width = container.getBoundingClientRect().right - ev.clientX;
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  const repoPath = repo?.path ?? null;
  /** ポーリングしてよいか。隠れたタブや隠れたウィンドウでは止める */
  const canPoll = () => active && document.visibilityState !== "hidden";

  // ref が変わったら読み直す。隠れている間は止め、表示されたら即確認する
  useEffect(() => {
    if (!repoPath || !active) return;
    let stopped = false;
    let previous: RepoFingerprint | null = null;

    const tick = async () => {
      if (stopped || !canPoll()) return;
      try {
        const fp = await repoFingerprint(repoPath);
        if (previous !== null) {
          if (fp.refs !== previous.refs || fp.head !== previous.head) {
            // ref か HEAD が動いた。コミットの集合が変わりうるので全部読み直す
            await load({ keepSelection: true });
          } else if (fp.worktrees !== previous.worktrees) {
            // ワークツリーの追加・削除だけ。コミットは変わらないので一覧だけ取り直す
            await reloadLists();
          }
        } else if (lastFingerprint.current && lastFingerprint.current !== fp.refs) {
          // 隠れている間に変わっていた
          await load({ keepSelection: true });
        }
        previous = fp;
        lastFingerprint.current = fp.refs;
        // 変化が無くても「確認できた」ことは出す
        setCheckedAt(Date.now());
      } catch {
        // 一時的な失敗（読み込み中の ref など）は次の周期に任せる
      }
    };

    void tick();
    const id = window.setInterval(tick, REFRESH_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
    // canPoll は active を閉じ込めた関数なので依存は active でよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, active, load, reloadLists]);
  /** タブが隠れる前に最後に見た refs。再表示時に変化を見つけるため */
  const lastFingerprint = useRef<string | null>(null);

  // 未コミットの変更の件数だけを定期的に取り直す
  useEffect(() => {
    if (!repoPath || !active) return;
    let stopped = false;
    const id = window.setInterval(() => {
      if (!canPoll()) return;
      void worktreeChangeCount(repoPath)
        .then((n) => !stopped && setWorktreeChanges(n))
        .catch(() => undefined);
    }, WORKTREE_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, active]);

  // 全ワークツリーの未コミット変更を取り直す。主状態「作業中」の鮮度を保つため。
  // ref の確認より粗い間隔にして負荷を抑える
  useEffect(() => {
    if (!repoPath || !active) return;
    let stopped = false;
    const id = window.setInterval(() => {
      if (!canPoll()) return;
      void listWorktreeChanges(repoPath)
        .then((d) => !stopped && setDirtyList(d))
        .catch(() => undefined);
    }, DIRTY_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, active]);

  const dirty = useMemo(() => changesByPath(dirtyList), [dirtyList]);
  const selectedBranch = useMemo(
    () => branches.find((b) => b.name === selectedBranchName) ?? null,
    [branches, selectedBranchName],
  );

  return (
    <div className="repo-view">
      {repo && (
        <div className="repo-info">
          <span className="repo-path" title={repo.path}>
            {repo.path}
          </span>
          <span className="repo-branch">
            {repo.isDetached ? "detached HEAD" : (repo.headBranch ?? "-")}
          </span>
          {focusBranch && (
            <span className="repo-focus" title="このブランチから辿れるコミットだけを表示しています">
              ブランチビュー: {focusBranch}
            </span>
          )}
          {isBrowserPreview() && <span className="repo-preview">ブラウザプレビュー</span>}
          <span className="repo-count">
            {commits.length}
            {commits.length >= COMMIT_LIMIT ? `+ (上限 ${COMMIT_LIMIT})` : ""} commits
          </span>
          {checkedAt !== null && (
            <span
              className="repo-updated"
              title={`${REFRESH_INTERVAL_MS / 1000} 秒ごとに変更を確認し、変わっていれば読み直します`}
            >
              確認 {new Date(checkedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner">{notice}</div>}
      {loading && <div className="banner">読み込み中...</div>}

      {!loading && !error && repo && commits.length === 0 && (
        <div className="banner">コミットがありません。</div>
      )}

      {repo && commits.length > 0 && (
        <main className="content" ref={contentRef}>
          <CommitList
            ref={listRef}
            graph={graph}
            selectedId={worktreeSelected ? null : selectedId}
            onSelect={selectCommit}
            worktreeChanges={worktreeChanges}
            worktreeSelected={worktreeSelected}
            onSelectWorktree={selectWorktree}
          />
          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startResize}
          />
          <div className="sidebar-shell" style={{ width: sidebarWidth }}>
            <Sidebar
              tab={tab}
              onChangeTab={setTab}
              branches={branches}
              worktrees={worktrees}
              dirty={dirty}
              mergeBase={mergeBase}
              commit={selected}
              selectedBranch={selectedBranch}
              repoPath={repo.path}
              compareBase={compareBase}
              worktreeSelected={worktreeSelected}
              onSelectCommit={revealCommit}
              onSelectParent={revealCommit}
              onSelectBranch={selectBranch}
              onChangeMergeBase={changeMergeBase}
              onSetCompareBase={setCompareBase}
              onEditDescription={(b, d) => void editDescription(b, d)}
              onOpenBranchTab={(name) =>
                onOpenTab({ kind: "branch", path: repo.path, branch: name })
              }
              onOpenWorktreeTab={(wtPath) => onOpenTab({ kind: "worktree", path: wtPath })}
            />
          </div>
        </main>
      )}
    </div>
  );
}
