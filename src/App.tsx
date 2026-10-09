import { useCallback, useEffect, useRef, useState } from "react";

import { loadSettings, pickRepository, saveSettings, startupRepository } from "./api";
import { normalizePath } from "./branchState";
import { Home } from "./components/Home";
import { RepoView } from "./components/RepoView";
import { SettingsDialog } from "./components/SettingsDialog";
import { TabBar } from "./components/TabBar";
import { UpdateBanner } from "./components/UpdateBanner";
import {
  HOME_TAB,
  loadStoredTabs,
  newTabId,
  sameView,
  storeTabs,
  type RepoTab,
  type Tab,
  type TabSpec,
} from "./tabs";
import { applyTheme } from "./theme";
import type { RepoInfo, Settings, ThemeSettings } from "./types";
import "./App.css";

/** v1.3 以前が最後に開いたリポジトリを控えていたキー。タブの控えが無いときだけ使う */
const LAST_REPO_KEY = "git-graph:last-repo";
/** 設定の保存をまとめる待ち時間。色の選択中は値が連続して変わるため */
const SETTINGS_SAVE_DELAY_MS = 400;

const DEFAULT_SETTINGS: Settings = {
  theme: { mode: "system", baseColor: "#1b1d23" },
  repositories: [],
};

/** 設定に記録されたマージ基準。無ければ null（自動検出） */
function preferredMergeBase(settings: Settings, mainPath: string): string | null {
  const key = normalizePath(mainPath);
  return settings.repositories.find((r) => normalizePath(r.path) === key)?.mergeBase ?? null;
}

/**
 * アプリの外枠。タブと設定を持ち、各タブの中身は RepoView / Home に任せる。
 * タブは全部マウントしたまま表示を切り替える（選択やスクロールを保つため）。
 * ポーリングは表示中のタブだけが行う。
 */
function App() {
  const [{ tabs, activeId }, setTabState] = useState(loadStoredTabs);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    storeTabs(tabs, activeId);
  }, [tabs, activeId]);

  /** 設定を更新する。画面には即反映し、保存は少し待ってまとめる */
  const updateSettings = useCallback((update: (prev: Settings) => Settings) => {
    setSettings((prev) => {
      const next = update(prev);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        saveSettings(next).catch((e) => setNotice(`設定を保存できません: ${String(e)}`));
      }, SETTINGS_SAVE_DELAY_MS);
      return next;
    });
  }, []);

  const changeTheme = useCallback(
    (theme: ThemeSettings) => updateSettings((prev) => ({ ...prev, theme })),
    [updateSettings],
  );

  /** タブを開く。同じビューのタブがあればそれを前に出す */
  const openTab = useCallback((spec: TabSpec) => {
    setTabState((state) => {
      const candidate = { ...spec, id: newTabId() } as Tab;
      const existing = state.tabs.find((t) => sameView(t, candidate));
      if (existing) return { tabs: state.tabs, activeId: existing.id };
      return { tabs: [...state.tabs, candidate], activeId: candidate.id };
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabState((state) => {
      const index = state.tabs.findIndex((t) => t.id === id);
      if (index <= 0) return state;
      const tabs = state.tabs.filter((t) => t.id !== id);
      // 閉じたタブを見ていたなら、左隣（無ければホーム）へ
      const activeId =
        state.activeId === id ? (tabs[index - 1]?.id ?? HOME_TAB.id) : state.activeId;
      return { tabs, activeId };
    });
  }, []);

  const activate = useCallback((id: string) => {
    setTabState((state) => ({ ...state, activeId: id }));
  }, []);

  /** リポジトリを登録する。単位はメインワークツリー。既にあれば何もしない */
  const register = useCallback(
    (mainPath: string) => {
      updateSettings((prev) => {
        const key = normalizePath(mainPath);
        if (prev.repositories.some((r) => normalizePath(r.path) === key)) return prev;
        return {
          ...prev,
          repositories: [...prev.repositories, { path: mainPath, mergeBase: null }],
        };
      });
    },
    [updateSettings],
  );

  const unregister = useCallback(
    (mainPath: string) => {
      const key = normalizePath(mainPath);
      updateSettings((prev) => ({
        ...prev,
        repositories: prev.repositories.filter((r) => normalizePath(r.path) !== key),
      }));
    },
    [updateSettings],
  );

  /** マージ基準をリポジトリごとに記憶する。null で自動検出に戻す。未登録なら登録も兼ねる */
  const changeMergeBase = useCallback(
    (mainPath: string, name: string | null) => {
      const key = normalizePath(mainPath);
      updateSettings((prev) => {
        const others = prev.repositories.filter((r) => normalizePath(r.path) !== key);
        const current = prev.repositories.find((r) => normalizePath(r.path) === key);
        return {
          ...prev,
          repositories: [...others, { ...current, path: current?.path ?? mainPath, mergeBase: name }],
        };
      });
    },
    [updateSettings],
  );

  /** ビューがリポジトリを開けたら登録する（ワークツリーならメインワークツリーを） */
  const onOpened = useCallback((info: RepoInfo) => register(info.mainPath), [register]);

  const chooseRepo = useCallback(async () => {
    const current = tabs.find((t) => t.id === activeId);
    const selected = await pickRepository(current && current.kind !== "home" ? current.path : null);
    if (selected) openTab({ kind: "worktree", path: selected });
  }, [tabs, activeId, openTab]);

  // 設定を読んでから、起動時引数のリポジトリをタブで開く。
  // 設定が先なのは、リポジトリごとのマージ基準を最初の読み込みから効かせるため
  useEffect(() => {
    void (async () => {
      try {
        setSettings(await loadSettings());
      } catch (e) {
        setNotice(`設定を読めなかったので既定値を使います: ${String(e)}`);
      }
      const fromArgs = await startupRepository().catch(() => null);
      if (fromArgs) {
        openTab({ kind: "worktree", path: fromArgs });
      } else {
        // 旧版からの移行: タブの控えが無く、最後に開いたリポジトリだけあるとき
        const last = localStorage.getItem(LAST_REPO_KEY);
        if (last && tabs.length === 1) openTab({ kind: "worktree", path: last });
      }
      localStorage.removeItem(LAST_REPO_KEY);
      setReady(true);
    })();
    // 起動時に 1 回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <header className="toolbar">
        <button type="button" onClick={() => void chooseRepo()}>
          リポジトリを開く
        </button>
        <TabBar tabs={tabs} activeId={activeId} onActivate={activate} onClose={closeTab} />
        <button
          type="button"
          className="settings-button"
          title="設定"
          aria-label="設定"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </button>
      </header>

      <SettingsDialog
        open={settingsOpen}
        theme={settings.theme}
        onChangeTheme={changeTheme}
        onClose={() => setSettingsOpen(false)}
      />

      <UpdateBanner />

      {notice && <div className="banner">{notice}</div>}

      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div key={tab.id} className="tab-pane" hidden={!active}>
            {tab.kind === "home" ? (
              <Home
                repositories={settings.repositories}
                active={active && ready}
                onOpen={(path) => openTab({ kind: "worktree", path })}
                onAdd={() => void chooseRepo()}
                onRemove={unregister}
                onChangeMergeBase={changeMergeBase}
              />
            ) : (
              ready && (
                <RepoView
                  path={tab.path}
                  focusBranch={tab.kind === "branch" ? tab.branch : null}
                  active={active}
                  preferredMergeBase={preferredForTab(settings, tab)}
                  onOpened={onOpened}
                  onChangeMergeBase={changeMergeBase}
                  onOpenTab={openTab}
                />
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * タブのパスに対するマージ基準の設定。タブのパスがワークツリーでも、登録は
 * メインワークツリー単位なので、パスの一致で見つからなければ登録一覧から
 * そのパスを含むものを探す。
 */
function preferredForTab(settings: Settings, tab: RepoTab): string | null {
  const direct = preferredMergeBase(settings, tab.path);
  if (direct !== null) return direct;
  const key = normalizePath(tab.path);
  const parent = settings.repositories.find((r) => key.startsWith(normalizePath(r.path) + "/"));
  return parent?.mergeBase ?? null;
}

export default App;
