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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_repository, list_commits])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
