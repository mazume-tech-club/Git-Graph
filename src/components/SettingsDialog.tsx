import { useEffect, useRef, useState } from "react";

import { parseHex } from "../theme";
import type { ThemeMode, ThemeSettings } from "../types";

type Props = {
  open: boolean;
  theme: ThemeSettings;
  /** 変更はその場で反映・保存する（OK ボタンは無い） */
  onChangeTheme: (theme: ThemeSettings) => void;
  onClose: () => void;
};

const MODES: { id: ThemeMode; label: string; hint: string }[] = [
  { id: "system", label: "OS に従う", hint: "Windows の設定（ライト / ダーク）に合わせる" },
  { id: "light", label: "ライト", hint: "白地" },
  { id: "dark", label: "ダーク", hint: "黒地" },
  { id: "custom", label: "カスタム", hint: "基調色を 1 色選び、他の色はそこから決める" },
];

/** 設定ダイアログ。今はテーマだけ */
export function SettingsDialog({ open, theme, onChangeTheme, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  // 色のテキスト入力は途中の文字列（"#12" など）を保持する必要があるので別に持つ
  const [colorText, setColorText] = useState(theme.baseColor);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // 先頭ではなく選択中の項目にフォーカスを置く。先頭に当たると選ばれているように見えるため
      dialog.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    setColorText(theme.baseColor);
  }, [theme.baseColor]);

  const setMode = (mode: ThemeMode) => onChangeTheme({ ...theme, mode });

  const setColor = (text: string) => {
    setColorText(text);
    const rgb = parseHex(text);
    if (rgb) {
      const hex = `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      onChangeTheme({ ...theme, mode: "custom", baseColor: hex });
    }
  };

  return (
    <dialog ref={ref} className="settings" onClose={onClose} aria-label="設定">
      <div className="settings-body">
        <h2>設定</h2>

        <fieldset className="settings-group">
          <legend>テーマ</legend>
          {MODES.map((m) => (
            <label key={m.id} className="settings-option">
              <input
                type="radio"
                name="theme-mode"
                checked={theme.mode === m.id}
                onChange={() => setMode(m.id)}
              />
              <span className="settings-option-label">{m.label}</span>
              <span className="settings-option-hint">{m.hint}</span>
            </label>
          ))}

          <div className={`settings-color${theme.mode === "custom" ? "" : " disabled"}`}>
            <label>
              基調色
              <input
                type="color"
                value={theme.baseColor}
                disabled={theme.mode !== "custom"}
                onChange={(e) => setColor(e.currentTarget.value)}
              />
            </label>
            <input
              className="mono"
              type="text"
              value={colorText}
              disabled={theme.mode !== "custom"}
              maxLength={7}
              spellCheck={false}
              aria-label="基調色（16 進）"
              onChange={(e) => setColor(e.currentTarget.value)}
            />
            <span className="settings-option-hint">
              文字色・枠線・選択色は基調色から自動で決めます
            </span>
          </div>
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
