import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  isBrowserPreview,
  listBranches,
  listCommits,
  listWorktrees,
  openRepository,
  pickRepository,
  repoFingerprint,
  setBranchDescription,
  startupRepository,
  worktreeChangeCount,
} from "./api";
import { CommitList, type CommitListHandle } from "./components/CommitList";
import { Sidebar, type SidebarTab } from "./components/Sidebar";
import { UpdateBanner } from "./components/UpdateBanner";
import { buildGraph } from "./graph/lanes";
import type { BranchInfo, Commit, RepoFingerprint, RepoInfo, WorktreeInfo } from "./types";
import "./App.css";

const COMMIT_LIMIT = 500;
const LAST_REPO_KEY = "git-graph:last-repo";
const SIDEBAR_WIDTH_KEY = "git-graph:sidebar-width";
const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 720;
/** ref の変化を見に行く間隔 */
const REFRESH_INTERVAL_MS = 5_000;
/** 未コミットの変更を数え直す間隔。ref より重いので間隔を広くとる */
const WORKTREE_INTERVAL_MS = 15_000;

function readStoredWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return 380;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw));
}

function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [worktreeSelected, setWorktreeSelected] = useState(false);
  const [compareBase, setCompareBase] = useState<string | null>(null);
  /** 作業ツリーで変更されているファイル数。中身は選んだときに別途取る */
  const [worktreeChanges, setWorktreeChanges] = useState(0);
  const [tab, setTab] = useState<SidebarTab>("branches");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth);
  /** 最後にリポジトリの変化を確認できた時刻。ポーリングが生きていることの目印 */
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const contentRef = useRef<HTMLElement>(null);
  const listRef = useRef<CommitListHandle>(null);

  /**
   * リポジトリを読み直す。
   * - `silent` … 失敗してもエラーを出さない（起動時の自動復元用）
   * - `keepSelection` … 選択中のコミットを維持する（自動更新用）
   */
  const load = useCallback(
    async (path: string, { silent = false, keepSelection = false } = {}) => {
    if (!keepSelection) setLoading(true);
    setError(null);
    try {
      const info = await openRepository(path);
      const [list, branchList, worktreeList, changes] = await Promise.all([
        listCommits(info.path, COMMIT_LIMIT),
        listBranches(info.path),
        listWorktrees(info.path),
        // 未コミットの変更。件数だけ先に出して、中身は開いたときに取る
        worktreeChangeCount(info.path).catch(() => 0),
      ]);
      setRepo(info);
      setCommits(list);
      setBranches(branchList);
      setWorktrees(worktreeList);
      setWorktreeChanges(changes);
      setCheckedAt(Date.now());
      if (keepSelection) {
        // 選択中のコミットが消えていたら先頭に戻す
        setSelectedId((prev) =>
          prev && list.some((c) => c.id === prev) ? prev : (list[0]?.id ?? null),
        );
      } else {
        setSelectedId(list.length > 0 ? list[0].id : null);
        setWorktreeSelected(false);
        setCompareBase(null);
      }
      localStorage.setItem(LAST_REPO_KEY, info.path);
    } catch (e) {
      if (silent) {
        localStorage.removeItem(LAST_REPO_KEY);
      } else {
        setError(String(e));
      }
      setRepo(null);
      setCommits([]);
      setBranches([]);
      setWorktrees([]);
      setWorktreeChanges(0);
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
    },
    [],
  );

  // 起動時引数のリポジトリを開く。無ければ前回開いたものを復元する
  useEffect(() => {
    void (async () => {
      const fromArgs = await startupRepository().catch(() => null);
      if (fromArgs) {
        await load(fromArgs);
        return;
      }
      const last = localStorage.getItem(LAST_REPO_KEY);
      if (last) await load(last, { silent: true });
    })();
  }, [load]);

  const chooseRepo = useCallback(async () => {
    const selected = await pickRepository(repo?.path ?? null);
    if (selected) await load(selected);
  }, [load, repo]);

  const graph = useMemo(() => buildGraph(commits), [commits]);
  const selected = useMemo(
    () => commits.find((c) => c.id === selectedId) ?? null,
    [commits, selectedId],
  );

  /** ブランチ・ワークツリーからコミットを選ぶ。一覧の該当行までスクロールする */
  const revealCommit = useCallback(
    (id: string) => {
      if (!commits.some((c) => c.id === id)) {
        setNotice(`このコミットは表示範囲（最新 ${COMMIT_LIMIT} 件）に含まれていません。`);
        return;
      }
      setNotice(null);
      setWorktreeSelected(false);
      setSelectedId(id);
      listRef.current?.scrollToCommit(id);
    },
    [commits],
  );

  /** グラフの行を選ぶ。行コンポーネントの memo を効かせるため参照を固定する */
  const selectCommit = useCallback((id: string) => {
    setWorktreeSelected(false);
    setSelectedId(id);
    setTab("detail");
  }, []);

  const selectWorktree = useCallback(() => {
    setWorktreeSelected(true);
    setTab("detail");
  }, []);

  /** ブランチとワークツリーの一覧だけを取り直す（コミットは変わっていないとき用） */
  const reloadLists = useCallback(async (path: string) => {
    const [branchList, worktreeList] = await Promise.all([
      listBranches(path),
      listWorktrees(path),
    ]);
    setBranches(branchList);
    setWorktrees(worktreeList);
  }, []);

  /**
   * ブランチのメモを保存して一覧を取り直す。
   * ref は変わらないので自動更新では拾えないため、ここで明示的に読み直す。
   */
  const editDescription = useCallback(
    async (branch: string, description: string | null) => {
      if (!repo) return;
      try {
        await setBranchDescription(repo.path, branch, description);
        await reloadLists(repo.path);
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

  // ref が変わったら読み直す。画面が隠れている間は止める
  useEffect(() => {
    if (!repoPath) return;
    let stopped = false;
    let previous: RepoFingerprint | null = null;

    const tick = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        const fp = await repoFingerprint(repoPath);
        if (previous !== null) {
          if (fp.refs !== previous.refs || fp.head !== previous.head) {
            // ref か HEAD が動いた。コミットの集合が変わりうるので全部読み直す
            await load(repoPath, { silent: true, keepSelection: true });
          } else if (fp.worktrees !== previous.worktrees) {
            // ワークツリーの追加・削除だけ。コミットは変わらないので一覧だけ取り直す
            await reloadLists(repoPath);
          }
        }
        previous = fp;
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
  }, [repoPath, load, reloadLists]);

  // 未コミットの変更の件数だけを定期的に取り直す
  useEffect(() => {
    if (!repoPath) return;
    let stopped = false;
    const id = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void worktreeChangeCount(repoPath)
        .then((n) => !stopped && setWorktreeChanges(n))
        .catch(() => undefined);
    }, WORKTREE_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [repoPath]);

  return (
    <div className="app">
      <header className="toolbar">
        <button type="button" onClick={chooseRepo} disabled={loading}>
          リポジトリを開く
        </button>
        {repo && (
          <div className="repo-info">
            <span className="repo-path" title={repo.path}>
              {repo.path}
            </span>
            <span className="repo-branch">
              {repo.isDetached ? "detached HEAD" : (repo.headBranch ?? "-")}
            </span>
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
      </header>

      <UpdateBanner />

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner">{notice}</div>}
      {loading && <div className="banner">読み込み中...</div>}

      {!loading && !error && repo && commits.length === 0 && (
        <div className="banner">コミットがありません。</div>
      )}

      {!repo && !loading && !error && (
        <div className="placeholder">
          <p>Git リポジトリを開くとコミットグラフを表示します。</p>
        </div>
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
              commit={selected}
              repoPath={repo.path}
              compareBase={compareBase}
              worktreeSelected={worktreeSelected}
              onSelectCommit={revealCommit}
              onSelectParent={revealCommit}
              onSetCompareBase={setCompareBase}
              onEditDescription={(b, d) => void editDescription(b, d)}
            />
          </div>
        </main>
      )}
    </div>
  );
}

export default App;
