mod git;

use git::{CommitInfo, RepoInfo};

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

/// 起動時引数で渡されたリポジトリのパス（`git-graph <path>`）。
/// 指定が無い、またはディレクトリでない場合は None。
#[tauri::command]
fn startup_repository() -> Option<String> {
    std::env::args()
        .nth(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| std::path::Path::new(arg).is_dir())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_repository,
            list_commits,
            startup_repository
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
