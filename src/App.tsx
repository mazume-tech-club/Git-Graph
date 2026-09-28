import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { CommitDetail } from "./components/CommitDetail";
import { CommitList } from "./components/CommitList";
import { buildGraph } from "./graph/lanes";
import type { Commit, RepoInfo } from "./types";
import "./App.css";

const COMMIT_LIMIT = 500;
const LAST_REPO_KEY = "git-graph:last-repo";

function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** `silent` のときは失敗してもエラーを出さない（起動時の自動復元用） */
  const load = useCallback(async (path: string, silent = false) => {
    setLoading(true);
    setError(null);
    try {
      const info = await invoke<RepoInfo>("open_repository", { path });
      const list = await invoke<Commit[]>("list_commits", {
        path: info.path,
        limit: COMMIT_LIMIT,
      });
      setRepo(info);
      setCommits(list);
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
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // 起動時引数のリポジトリを開く。無ければ前回開いたものを復元する
  useEffect(() => {
    void (async () => {
      const fromArgs = await invoke<string | null>("startup_repository").catch(() => null);
      if (fromArgs) {
        await load(fromArgs);
        return;
      }
      const last = localStorage.getItem(LAST_REPO_KEY);
      if (last) await load(last, true);
    })();
  }, [load]);

  const chooseRepo = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "リポジトリを選択" });
    if (typeof selected === "string") await load(selected);
  }, [load]);

  const graph = useMemo(() => buildGraph(commits), [commits]);
  const selected = useMemo(
    () => commits.find((c) => c.id === selectedId) ?? null,
    [commits, selectedId],
  );

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
            <span className="repo-count">
              {commits.length}
              {commits.length >= COMMIT_LIMIT ? `+ (上限 ${COMMIT_LIMIT})` : ""} commits
            </span>
          </div>
        )}
      </header>

      {error && <div className="banner error">{error}</div>}
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
        <main className="content">
          <CommitList graph={graph} selectedId={selectedId} onSelect={setSelectedId} />
          <aside className="sidebar">
            <CommitDetail
              commit={selected}
              onSelectParent={(id) => {
                if (commits.some((c) => c.id === id)) setSelectedId(id);
              }}
            />
          </aside>
        </main>
      )}
    </div>
  );
}

export default App;
