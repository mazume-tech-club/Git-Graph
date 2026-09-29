/**
 * 自動更新。Gitea のリリースに置いた latest.json を見て、新しい版があれば入れ替える。
 *
 * Tauri の WebView でのみ動く。ブラウザプレビューでは何もしない。
 */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type UpdateInfo = {
  version: string;
  notes: string | null;
};

/** check() が返したオブジェクト。downloadAndInstall に必要なので保持する */
type PendingUpdate = {
  version: string;
  body?: string;
  downloadAndInstall: (onEvent: (event: DownloadEvent) => void) => Promise<void>;
};

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

let pending: PendingUpdate | null = null;

/** 新しい版があればその情報を返す。無ければ null */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = (await check()) as PendingUpdate | null;
  if (!update) {
    pending = null;
    return null;
  }
  pending = update;
  return { version: update.version, notes: update.body?.trim() || null };
}

/**
 * 更新をダウンロードして適用し、アプリを再起動する。
 * `onProgress` には 0〜1 の進捗を渡す。総サイズが不明なときは null。
 */
export async function installUpdate(
  onProgress?: (ratio: number | null) => void,
): Promise<void> {
  if (!pending) return;

  let downloaded = 0;
  let total: number | null = null;

  await pending.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        onProgress?.(total === null ? null : 0);
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.(total === null ? null : Math.min(1, downloaded / total));
        break;
      case "Finished":
        onProgress?.(1);
        break;
    }
  });

  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
