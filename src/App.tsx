import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  diffSummary,
  isBrowserPreview,
  listBranches,
  listCommits,
  listWorktrees,
  openRepository,
  pickRepository,
  repoFingerprint,
  startupRepository,
} from "./api";
import { CommitList } from "./components/CommitList";
import { Sidebar, type SidebarTab } from "./components/Sidebar";
import { buildGraph } from "./graph/lanes";
import type { BranchInfo, Commit, DiffSummary, RepoInfo, WorktreeInfo } from "./types";
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
  const [worktreeChanges, setWorktreeChanges] = useState<DiffSummary | null>(null);
  const [tab, setTab] = useState<SidebarTab>("branches");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const contentRef = useRef<HTMLElement>(null);

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
        diffSummary(info.path, null, null).catch(() => null),
      ]);
      setRepo(info);
      setCommits(list);
      setBranches(branchList);
      setWorktrees(worktreeList);
      setWorktreeChanges(changes);
      setUpdatedAt(Date.now());
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
      setWorktreeChanges(null);
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
      requestAnimationFrame(() => {
        document.getElementById(`commit-${id}`)?.scrollIntoView({ block: "center" });
      });
    },
    [commits],
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
    let previous: string | null = null;

    const tick = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        const fp = await repoFingerprint(repoPath);
        const key = `${fp.refs}:${fp.head}:${fp.worktrees}`;
        if (previous !== null && key !== previous) {
          await load(repoPath, { silent: true, keepSelection: true });
        }
        previous = key;
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
  }, [repoPath, load]);

  // 未コミットの変更の件数だけを定期的に取り直す
  useEffect(() => {
    if (!repoPath) return;
    let stopped = false;
    const id = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void diffSummary(repoPath, null, null)
        .then((s) => !stopped && setWorktreeChanges(s))
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
            {updatedAt !== null && (
              <span className="repo-updated" title="変更があると自動で読み直します">
                更新 {new Date(updatedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        )}
      </header>

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
            graph={graph}
            selectedId={worktreeSelected ? null : selectedId}
            onSelect={(id) => {
              setWorktreeSelected(false);
              setSelectedId(id);
              setTab("detail");
            }}
            worktreeChanges={worktreeChanges?.files.length ?? 0}
            worktreeSelected={worktreeSelected}
            onSelectWorktree={() => {
              setWorktreeSelected(true);
              setTab("detail");
            }}
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
            />
          </div>
        </main>
      )}
    </div>
  );
}

export default App;
