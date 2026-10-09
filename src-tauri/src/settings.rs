//! アプリの設定ファイル。
//!
//! テーマなど「消えると困る」設定を JSON で保存する。保存先はアプリの設定ディレクトリ
//! （Windows では `%APPDATA%\jp.asuzacgroup.gitgraph\settings.json`）。
//! サイドバー幅のような軽い UI 状態は localStorage のままで、ここには入れない。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 設定ファイルの名前
pub const FILE_NAME: &str = "settings.json";

/// テーマの選び方
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
    /// OS の設定（prefers-color-scheme）に従う
    #[default]
    System,
    /// 基調色 1 色から配色を派生させる
    Custom,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ThemeSettings {
    pub mode: ThemeMode,
    /// カスタムのときの基調色（`#rrggbb`）。他のモードでは使わないが値は保持する
    pub base_color: String,
}

impl Default for ThemeSettings {
    fn default() -> Self {
        Self {
            mode: ThemeMode::System,
            base_color: "#1b1d23".to_string(),
        }
    }
}

/// 設定全体。項目を増やすときは `#[serde(default)]` を保ったまま足す。
/// 古い版が書いたファイルに項目が無くても既定値で読めるようにするため。
/// 知らない項目は読み飛ばす（新しい版が書いたファイルを古い版で開いても壊れない）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: ThemeSettings,
}

/// 設定を読む。ファイルが無ければ既定値。壊れていればエラー
/// （黙って既定値で上書きすると利用者の編集が消えるため）。
pub fn load(dir: &Path) -> Result<Settings, String> {
    let file = dir.join(FILE_NAME);
    if !file.exists() {
        return Ok(Settings::default());
    }
    let text = std::fs::read_to_string(&file)
        .map_err(|e| format!("設定ファイルを読めません: {}: {e}", file.display()))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("設定ファイルの形式が不正です: {}: {e}", file.display()))
}

/// 設定を書く。一時ファイルに書いてから置き換え、途中で落ちても元の内容を壊さない。
pub fn save(dir: &Path, settings: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("設定フォルダを作れません: {}: {e}", dir.display()))?;
    let file = dir.join(FILE_NAME);
    let tmp = temp_path(&file);
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text)
        .map_err(|e| format!("設定ファイルを書けません: {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("設定ファイルを置き換えられません: {}: {e}", file.display())
    })
}

fn temp_path(file: &Path) -> PathBuf {
    file.with_extension("json.tmp")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn missing_file_yields_defaults() {
        let dir = TempDir::new().unwrap();
        let settings = load(dir.path()).unwrap();
        assert_eq!(settings, Settings::default());
        assert_eq!(settings.theme.mode, ThemeMode::System);
    }

    #[test]
    fn round_trips_through_file() {
        let dir = TempDir::new().unwrap();
        let settings = Settings {
            theme: ThemeSettings {
                mode: ThemeMode::Custom,
                base_color: "#102030".to_string(),
            },
        };
        save(dir.path(), &settings).unwrap();
        assert_eq!(load(dir.path()).unwrap(), settings);
        // 一時ファイルは残らない
        assert!(!dir.path().join("settings.json.tmp").exists());
    }

    #[test]
    fn tolerates_missing_and_unknown_fields() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(FILE_NAME),
            r#"{ "theme": { "mode": "dark" }, "futureItem": 1 }"#,
        )
        .unwrap();
        let settings = load(dir.path()).unwrap();
        assert_eq!(settings.theme.mode, ThemeMode::Dark);
        assert_eq!(settings.theme.base_color, "#1b1d23");
    }

    #[test]
    fn broken_file_is_an_error_not_overwritten() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(FILE_NAME), "{ not json").unwrap();
        let err = load(dir.path()).unwrap_err();
        assert!(err.contains("形式が不正"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join(FILE_NAME)).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn mode_serializes_lowercase() {
        let json = serde_json::to_string(&ThemeMode::System).unwrap();
        assert_eq!(json, r#""system""#);
    }
}
