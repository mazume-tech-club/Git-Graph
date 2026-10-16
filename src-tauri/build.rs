use std::path::Path;

fn main() {
    guard_private_config();
    tauri_build::build()
}

/// Windows のリリース用ビルドで社内の値（tauri.windows.conf.json）が無ければ止める。
///
/// 無いままだとダミーの identifier（com.example.gitgraph）で別アプリとして配ってしまい、
/// 既存の利用者の設定が引き継がれず、更新の確認先も届かない URL になる。
///
/// GitHub に置く公開用の exe（社内の値を入れない）を作るときだけは、環境変数
/// `GIT_GRAPH_PUBLIC_BUILD=1` で止めないようにする。
fn guard_private_config() {
    println!("cargo:rerun-if-changed=tauri.windows.conf.json");
    println!("cargo:rerun-if-env-changed=GIT_GRAPH_PUBLIC_BUILD");
    if std::env::var("GIT_GRAPH_PUBLIC_BUILD").as_deref() == Ok("1") {
        return;
    }
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    if windows && release && !Path::new("tauri.windows.conf.json").exists() {
        panic!(
            "src-tauri/tauri.windows.conf.json がありません。\n\
             社内の identifier と更新の配信元を書いたファイルで、Git には入れていません。\n\
             tauri.windows.conf.example.json を写して実際の値を書いてください。"
        );
    }
}
