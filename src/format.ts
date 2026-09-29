import type { Commit } from "./types";

const pad = (n: number) => String(n).padStart(2, "0");

/** コミットの author タイムゾーンでの日時を YYYY-MM-DD HH:mm 形式にする */
export function formatCommitDate(commit: Commit, withSeconds = false): string {
  const d = new Date((commit.timestamp + commit.offsetMinutes * 60) * 1000);
  const base =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getUTCSeconds())}` : base;
}

/** +09:00 のようなオフセット表記 */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * 最終コミットからの経過を「3日前」のように表す。
 * ブランチが放置されているかを一目で分かるようにするためのもの。
 */
export function formatAge(timestamp: number, now = Date.now()): string {
  const days = Math.floor((now / 1000 - timestamp) / 86400);
  if (days < 0) return "これから";
  if (days === 0) return "今日";
  if (days === 1) return "昨日";
  if (days < 30) return `${days}日前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}ヶ月前`;
  return `${Math.floor(days / 365)}年前`;
}

/** 放置されていると見なす日数。これを超えたら警告色にする */
export const STALE_DAYS = 60;

export function isStale(timestamp: number, now = Date.now()): boolean {
  return (now / 1000 - timestamp) / 86400 > STALE_DAYS;
}
