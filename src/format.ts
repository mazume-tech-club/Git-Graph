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
