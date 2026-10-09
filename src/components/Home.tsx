import { useCallback, useEffect, useRef, useState } from "react";

import { repoOverview } from "../api";
import { normalizePath } from "../branchState";
import type { RepoOverview, RepositorySettings } from "../types";

/** 表示中に件数を取り直す間隔 */
const OVERVIEW_INTERVAL_MS = 60_000;

type Props = {
  repositories: RepositorySettings[];
  /** 表示中か。隠れている間は取り直さない */
  active: boolean;
  onOpen: (path: string) => void;
  onAdd: () => void;
  onRemove: (path: string) => void;
  onChangeMergeBase: (path: string, name: string | null) => void;
};

type Row = { settings: RepositorySettings; overview: RepoOverview | null; error: string | null };

/**
 * ホーム。登録リポジトリごとに未マージ数・作業中ワークツリー数を出し、
 * 「どのアプリで何本走っているか」を一覧する。
 */
export function Home({ repositories, active, onOpen, onAdd, onRemove, onChangeMergeBase }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const reposRef = useRef(repositories);
  reposRef.current = repositories;

  const refresh = useCallback(async () => {
    const repos = reposRef.current;
    const results = await Promise.all(
      repos.map(async (settings): Promise<Row> => {
        try {
          return { settings, overview: await repoOverview(settings.path, settings.mergeBase), error: null };
        } catch (e) {
          return { settings, overview: null, error: String(e) };
        }
      }),
    );
    setRows(results);
    setCheckedAt(Date.now());
  }, []);

  // 表示したとき、登録が変わったとき、表示中は 60 秒ごとに数え直す
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const run = () => {
      if (stopped || document.visibilityState === "hidden") return;
      void refresh();
    };
    run();
    const id = window.setInterval(run, OVERVIEW_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [active, repositories, refresh]);

  if (repositories.length === 0) {
    return (
      <div className="home">
        <div className="placeholder">
          <p>
            リポジトリを開くとここに登録され、未マージのブランチ数と作業中のワークツリー数が
            一覧できます。
          </p>
          <button type="button" onClick={onAdd}>
            リポジトリを開く
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="home">
      <div className="home-header">
        <h2>登録リポジトリ</h2>
        <button type="button" onClick={onAdd}>
          リポジトリを追加
        </button>
        {checkedAt !== null && (
          <span className="repo-updated" title="表示中は 60 秒ごとに数え直します">
            確認 {new Date(checkedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      <ul className="home-list">
        {(rows.length > 0
          ? rows
          : repositories.map((settings) => ({ settings, overview: null, error: null }))
        ).map(({ settings, overview, error }) => {
          const name =
            overview?.name ?? settings.path.split(/[\\/]/).filter(Boolean).pop() ?? settings.path;
          return (
            <li key={normalizePath(settings.path)} className="home-row">
              <div className="home-row-main">
                <button
                  type="button"
                  className="home-name"
                  onClick={() => onOpen(settings.path)}
                  title="タブで開く"
                >
                  {name}
                </button>
                <span className="home-path" title={settings.path}>
                  <bdi>{settings.path}</bdi>
                </span>
                <button
                  type="button"
                  className="home-remove"
                  title="一覧から外す（リポジトリ自体には触れません）"
                  onClick={() => onRemove(settings.path)}
                >
                  外す
                </button>
              </div>

              {error ? (
                <div className="home-row-error">{error}</div>
              ) : overview ? (
                <div className="home-row-stats">
                  <span className="repo-branch">
                    {overview.isDetached ? "detached HEAD" : (overview.headBranch ?? "-")}
                  </span>
                  <span className={`home-stat working${overview.working > 0 ? " on" : ""}`}>
                    作業中 {overview.working}
                  </span>
                  <span className={`home-stat unmerged${overview.unmerged > 0 ? " on" : ""}`}>
                    未マージ {overview.unmerged}
                  </span>
                  <span className="home-stat">ワークツリー {overview.worktrees}</span>
                  <label className="merge-base-picker">
                    基準
                    <select
                      value={
                        overview.mergeBase.source === "setting"
                          ? (overview.mergeBase.name ?? "")
                          : ""
                      }
                      onChange={(e) => onChangeMergeBase(settings.path, e.currentTarget.value || null)}
                    >
                      <option value="">自動（{overview.mergeBase.name ?? "HEAD"}）</option>
                      {settings.mergeBase && overview.mergeBase.settingMissing && (
                        <option value={settings.mergeBase}>{settings.mergeBase}（見つかりません）</option>
                      )}
                      {overview.mergeBase.source === "setting" && overview.mergeBase.name && (
                        <option value={overview.mergeBase.name}>{overview.mergeBase.name}</option>
                      )}
                    </select>
                  </label>
                </div>
              ) : (
                <div className="home-row-stats muted">読み込み中...</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
