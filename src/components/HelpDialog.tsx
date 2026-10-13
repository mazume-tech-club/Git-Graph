import { useEffect, useRef, useState } from "react";

import { isBrowserPreview } from "../api";
import {
  appVersion,
  canUpdate,
  checkForUpdate,
  installUpdate,
  openExternal,
  type UpdateInfo,
} from "../update";

type Props = {
  open: boolean;
  onClose: () => void;
};

/** リリース一覧。自動更新の配信元と同じ Gitea */
const RELEASES_URL = "http://git.example.com/example-org/Git-Graph/releases";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo; ratio: number | null }
  | { kind: "failed"; message: string };

const USAGE: { label: string; hint: string }[] = [
  { label: "リポジトリを開く", hint: "ツールバー左のボタン、またはホームの一覧から。開いたリポジトリはホームに登録される" },
  { label: "タブ", hint: "ワークツリーごと・ブランチごとに別のタブで開ける。再起動後も復元される" },
  { label: "ブランチの変更内容", hint: "一覧でブランチを選ぶと、マージ基準との共通祖先からの差分を詳細に出す" },
  { label: "メモ", hint: "ブランチの行で ✎ を押すと用途を書ける。git の branch.<name>.description に保存する" },
  { label: "テーマ", hint: "ツールバー右端の ⚙ から。ライト / ダーク / OS に従う / カスタム" },
  { label: "終了", hint: "× はタスクトレイに格納。終了はトレイアイコンの右クリックメニューから" },
];

/**
 * ヘルプダイアログ。バージョン情報・更新の確認・使い方の要点を出す。
 * 更新の確認は起動時の自動確認とは別に、ここから手動でもできる。
 */
export function HelpDialog({ open, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open || version !== null) return;
    appVersion()
      .then(setVersion)
      .catch(() => setVersion("不明"));
  }, [open, version]);

  const check = () => {
    setUpdate({ kind: "checking" });
    checkForUpdate()
      .then((info) => setUpdate(info ? { kind: "available", info } : { kind: "latest" }))
      .catch((e) => setUpdate({ kind: "failed", message: String(e) }));
  };

  const install = (info: UpdateInfo) => {
    setUpdate({ kind: "installing", info, ratio: null });
    installUpdate((ratio) =>
      setUpdate((prev) => (prev.kind === "installing" ? { ...prev, ratio } : prev)),
    ).catch((e) => setUpdate({ kind: "failed", message: String(e) }));
  };

  const busy = update.kind === "checking" || update.kind === "installing";

  return (
    <dialog ref={ref} className="settings help" onClose={onClose} aria-label="ヘルプ">
      <div className="settings-body">
        <h2>ヘルプ</h2>

        <fieldset className="settings-group">
          <legend>バージョン情報</legend>
          <div className="help-version">
            <span className="help-app-name">Git Graph</span>
            <span className="mono">{version === null ? "…" : `v${version}`}</span>
            {isBrowserPreview() && (
              <span className="settings-option-hint">ブラウザプレビュー</span>
            )}
          </div>

          <div className="help-update">
            {canUpdate() ? (
              <>
                <button type="button" disabled={busy} onClick={check}>
                  更新を確認
                </button>
                <span className="help-update-status" aria-live="polite">
                  {updateStatusText(update)}
                </span>
                {update.kind === "available" && (
                  <button type="button" onClick={() => install(update.info)}>
                    今すぐ更新
                  </button>
                )}
              </>
            ) : (
              <span className="settings-option-hint">
                ブラウザプレビューでは更新を確認できません
              </span>
            )}
          </div>

          {update.kind === "available" && update.info.notes && (
            <pre className="help-notes">{update.info.notes}</pre>
          )}

          <div className="help-links">
            <button type="button" className="link" onClick={() => void openExternal(RELEASES_URL)}>
              リリース一覧を開く
            </button>
          </div>
        </fieldset>

        <fieldset className="settings-group">
          <legend>使い方</legend>
          <dl className="help-usage">
            {USAGE.map((u) => (
              <div key={u.label} className="help-usage-row">
                <dt>{u.label}</dt>
                <dd>{u.hint}</dd>
              </div>
            ))}
          </dl>
        </fieldset>

        <div className="settings-actions">
          <button type="button" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </dialog>
  );
}

function updateStatusText(state: UpdateState): string {
  switch (state.kind) {
    case "idle":
      return "起動時にも自動で確認しています";
    case "checking":
      return "確認しています...";
    case "latest":
      return "最新版です";
    case "available":
      return `新しいバージョン v${state.info.version} があります`;
    case "installing": {
      const percent = state.ratio === null ? "" : `（${Math.round(state.ratio * 100)}%）`;
      return `v${state.info.version} を適用しています${percent}... 完了すると再起動します`;
    }
    case "failed":
      return `確認できませんでした: ${state.message}`;
  }
}
