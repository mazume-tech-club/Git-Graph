import { useEffect, useState } from "react";

import { checkForUpdate, installUpdate, type UpdateInfo } from "../update";

type State =
  | { kind: "idle" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo; ratio: number | null }
  | { kind: "failed"; message: string };

/**
 * 新しい版が出ていたら知らせる。押されたときだけ更新を適用する。
 * 起動直後に勝手に入れ替えると作業中に再起動がかかるため、確認を挟んでいる。
 */
export function UpdateBanner() {
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    checkForUpdate()
      .then((info) => {
        if (!cancelled && info) setState({ kind: "available", info });
      })
      // 更新サーバに届かないだけで使えなくなるのは困るので、失敗は黙って無視する
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "idle") return null;

  if (state.kind === "failed") {
    return (
      <div className="banner error">
        更新に失敗しました: {state.message}
      </div>
    );
  }

  if (state.kind === "installing") {
    const percent = state.ratio === null ? null : Math.round(state.ratio * 100);
    return (
      <div className="banner update">
        v{state.info.version} を適用しています
        {percent !== null && `（${percent}%）`}... 完了すると再起動します。
      </div>
    );
  }

  return (
    <div className="banner update">
      <span>新しいバージョン v{state.info.version} があります。</span>
      {state.info.notes && (
        <span className="update-notes" title={state.info.notes}>
          {state.info.notes.split("\n")[0]}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          setState({ kind: "installing", info: state.info, ratio: null });
          void installUpdate((ratio) =>
            setState((prev) =>
              prev.kind === "installing" ? { ...prev, ratio } : prev,
            ),
          ).catch((e) => setState({ kind: "failed", message: String(e) }));
        }}
      >
        今すぐ更新
      </button>
      <button type="button" onClick={() => setState({ kind: "idle" })}>
        あとで
      </button>
    </div>
  );
}
