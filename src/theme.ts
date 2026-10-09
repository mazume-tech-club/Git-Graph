import type { ThemeSettings } from "./types";

/**
 * テーマの適用。
 *
 * `<html data-theme="light|dark|custom">` を切り替え、CSS 変数を差し替える。
 * 「OS に従う」は JS 側で light / dark に解決するので、CSS には 3 通りしか無い。
 * カスタムは基調色 1 色から背景・枠線・文字色を派生させ、インラインの CSS 変数で上書きする。
 *
 * 解決した結果は localStorage にも控え、index.html の先頭スクリプトが React より先に
 * 当てる。設定ファイルの読み込みを待つ間、既定の配色が一瞬出るのを防ぐため。
 */

/** 解決済みのテーマを控えるキー。index.html と合わせること */
export const THEME_CACHE_KEY = "git-graph:theme-resolved";

/** 固定のアクセント色。カスタムでもこれを基準にし、コントラスト不足なら補正する */
const ACCENT = "#4c8dff";
/** ライト / ダークの文字色。カスタムではどちらか読みやすい方を使う */
const FG_LIGHT_THEME = "#1d2129";
const FG_DARK_THEME = "#e6e8ee";

/** CSS 変数名と値 */
type Palette = Record<string, string>;

type Resolved = {
  attr: "light" | "dark" | "custom";
  vars: Palette;
};

const DARK_QUERY = "(prefers-color-scheme: dark)";
let systemListener: (() => void) | null = null;

/** テーマ設定を画面に当てる。OS 追従のときは変更も監視する */
export function applyTheme(theme: ThemeSettings): void {
  const media = window.matchMedia(DARK_QUERY);
  if (systemListener) {
    media.removeEventListener("change", systemListener);
    systemListener = null;
  }
  if (theme.mode === "system") {
    systemListener = () => paint(resolve(theme, media.matches));
    media.addEventListener("change", systemListener);
  }
  paint(resolve(theme, media.matches));
}

function resolve(theme: ThemeSettings, systemDark: boolean): Resolved {
  switch (theme.mode) {
    case "light":
      return { attr: "light", vars: {} };
    case "dark":
      return { attr: "dark", vars: {} };
    case "system":
      return { attr: systemDark ? "dark" : "light", vars: {} };
    case "custom":
      return { attr: "custom", vars: derivePalette(theme.baseColor) };
  }
}

function paint(resolved: Resolved): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", resolved.attr);
  for (const name of PALETTE_KEYS) {
    const value = resolved.vars[name];
    if (value === undefined) {
      root.style.removeProperty(name);
    } else {
      root.style.setProperty(name, value);
    }
  }
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(resolved));
  } catch {
    // 保存できなくても表示には影響しない
  }
}

const PALETTE_KEYS = [
  "--bg",
  "--bg-elevated",
  "--bg-hover",
  "--bg-selected",
  "--border",
  "--fg",
  "--fg-muted",
  "--accent",
  "color-scheme",
] as const;

/**
 * 基調色 1 色から配色を作る。
 *
 * - 文字色は基調色とのコントラストが高い方（白系 / 黒系）
 * - 浮いた面・ホバー・枠線は基調色を文字色の方へ少しずつ寄せる
 * - 選択行はアクセント色を混ぜる
 * - アクセント色は固定だが、背景とのコントラストが 3 を切るなら文字色の方へ寄せて補正する
 */
export function derivePalette(baseColor: string): Palette {
  const base = parseHex(baseColor) ?? parseHex("#1b1d23")!;
  const fgDark = parseHex(FG_DARK_THEME)!;
  const fgLight = parseHex(FG_LIGHT_THEME)!;
  const useLightText = contrast(base, fgDark) >= contrast(base, fgLight);
  const fg = useLightText ? fgDark : fgLight;

  let accent = parseHex(ACCENT)!;
  for (let i = 0; i < 12 && contrast(base, accent) < 3; i += 1) {
    accent = mix(accent, fg, 0.12);
  }

  return {
    "--bg": toHex(base),
    "--bg-elevated": toHex(mix(base, fg, 0.04)),
    "--bg-hover": toHex(mix(base, fg, 0.08)),
    "--bg-selected": toHex(mix(base, accent, 0.28)),
    "--border": toHex(mix(base, fg, 0.14)),
    "--fg": toHex(fg),
    "--fg-muted": toHex(mix(fg, base, 0.4)),
    "--accent": toHex(accent),
    "color-scheme": useLightText ? "dark" : "light",
  };
}

type Rgb = [number, number, number];

/** `#rgb` / `#rrggbb` を読む。読めなければ null */
export function parseHex(text: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** a を b の方へ t（0〜1）だけ寄せる */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return a.map((v, i) => v + (b[i] - v) * t) as Rgb;
}

/** WCAG の相対輝度 */
function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG のコントラスト比（1〜21） */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
