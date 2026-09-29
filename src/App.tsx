import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  isBrowserPreview,
  listBranches,
  listCommits,
  listWorktrees,
  openRepository,
  pickRepository,
  startupRepository,
} from "./api";
import { CommitList } from "./components/CommitList";
import { Sidebar, type SidebarTab } from "./components/Sidebar";
import { buildGraph } from "./graph/lanes";
import type { BranchInfo, Commit, RepoInfo, WorktreeInfo } from "./types";
import "./App.css";

const COMMIT_LIMIT = 500;
const LAST_REPO_KEY = "git-graph:last-repo";
const SIDEBAR_WIDTH_KEY = "git-graph:sidebar-width";
const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 720;

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
  const [tab, setTab] = useState<SidebarTab>("branches");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth);
  const contentRef = useRef<HTMLElement>(null);

  /** `silent` のときは失敗してもエラーを出さない（起動時の自動復元用） */
  const load = useCallback(async (path: string, silent = false) => {
    setLoading(true);
    setError(null);
    try {
      const info = await openRepository(path);
      const [list, branchList, worktreeList] = await Promise.all([
        listCommits(info.path, COMMIT_LIMIT),
        listBranches(info.path),
        listWorktrees(info.path),
      ]);
      setRepo(info);
      setCommits(list);
      setBranches(branchList);
      setWorktrees(worktreeList);
      setSelectedId(list.length > 0 ? list[0].id : null);
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
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // 起動時引数のリポジトリを開く。無ければ前回開いたものを復元する
  useEffect(() => {
    void (async () => {
      const fromArgs = await startupRepository().catch(() => null);
      if (fromArgs) {
        await load(fromArgs);
        return;
      }
      const last = localStorage.getItem(LAST_REPO_KEY);
      if (last) await load(last, true);
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

  return (
    <div className="app">
      <header className="toolbar">
        <button type="button" onClick={chooseRepo} disabled={loading}>
          リポジトリを開く
        </button>
        <button
          type="button"
          onClick={() => repo && void load(repo.path)}
          disabled={loading || !repo}
        >
          再読み込み
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
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
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
              onSelectCommit={revealCommit}
              onSelectParent={revealCommit}
            />
          </div>
        </main>
      )}
    </div>
  );
}

export default App;
