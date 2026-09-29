mod git;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};

use git::{BranchInfo, CommitInfo, DiffSummary, FileDiff, RepoFingerprint, RepoInfo, WorktreeInfo};

/// 指定パス（またはその上位）の Git リポジトリを開き、概要を返す。
#[tauri::command]
fn open_repository(path: String) -> Result<RepoInfo, String> {
    git::repo_info(&path)
}

/// コミット履歴を新しい順に取得する。
#[tauri::command]
fn list_commits(path: String, limit: Option<usize>) -> Result<Vec<CommitInfo>, String> {
    git::list_commits(&path, limit.unwrap_or(500))
}

/// ブランチ一覧。HEAD に取り込み済みかどうかも含めて返す。
#[tauri::command]
fn list_branches(path: String) -> Result<Vec<BranchInfo>, String> {
    git::list_branches(&path)
}

/// ワークツリー一覧。
#[tauri::command]
fn list_worktrees(path: String) -> Result<Vec<WorktreeInfo>, String> {
    git::list_worktrees(&path)
}

/// 変更されたファイルの一覧。
///
/// `to` を省略すると作業ツリーとの比較、`from` を省略すると `to` の第一親との比較。
/// 両方指定すれば任意の 2 コミット間を比較できる。
#[tauri::command]
fn diff_summary(
    path: String,
    from: Option<String>,
    to: Option<String>,
) -> Result<DiffSummary, String> {
    git::diff_summary(&path, from.as_deref(), to.as_deref())
}

/// 1 ファイル分の差分。範囲の指定方法は diff_summary と同じ。
#[tauri::command]
fn file_diff(
    path: String,
    from: Option<String>,
    to: Option<String>,
    file: String,
) -> Result<FileDiff, String> {
    git::file_diff(&path, from.as_deref(), to.as_deref(), &file)
}

/// ブランチの説明を設定する。空文字を渡すと設定を消す。
#[tauri::command]
fn set_branch_description(
    path: String,
    branch: String,
    description: Option<String>,
) -> Result<(), String> {
    git::set_branch_description(&path, &branch, description.as_deref())
}

/// 変化の検知に使う軽い指紋。定期的に呼ぶ想定。
#[tauri::command]
fn repo_fingerprint(path: String) -> Result<RepoFingerprint, String> {
    git::fingerprint(&path)
}

/// 起動時引数で渡されたリポジトリのパス（`git-graph <path>`）。
/// 指定が無い、またはディレクトリでない場合は None。
#[tauri::command]
fn startup_repository() -> Option<String> {
    std::env::args()
        .nth(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| std::path::Path::new(arg).is_dir())
}

/// メインウィンドウを前面に戻す。最小化されている場合も考慮する。
fn show_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            open_repository,
            list_commits,
            list_branches,
            list_worktrees,
            diff_summary,
            file_diff,
            repo_fingerprint,
            set_branch_description,
            startup_repository
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "ウィンドウを表示", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Git Graph")
                .menu(&menu)
                // 左クリックはメニューではなくウィンドウの復帰に割り当てる
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            // トレイが使えない環境（Linux でトレイホストが無い等）でも起動は続ける
            if let Err(err) = tray.build(app) {
                eprintln!("タスクトレイを作成できませんでした: {err}");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            let WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            // トレイがあるときだけ格納する。無い環境で閉じられなくなるのを避ける
            if window.app_handle().tray_by_id("main").is_none() {
                return;
            }
            api.prevent_close();
            let _ = window.hide();
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
