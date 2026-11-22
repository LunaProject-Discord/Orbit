//! デスクトップ版だけの設定。アプリの設定フォルダーの settings.json に保存する。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// ウィンドウを閉じてもトレイに残り、新着メールの通知を受け続ける。
    pub close_to_tray: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
        }
    }
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

pub fn parse(text: &str) -> Settings {
    serde_json::from_str(text).unwrap_or_default()
}

/// 読めなければ既定値で動く (初回の起動、壊れたファイルなど)。
pub fn load(app: &AppHandle) -> Settings {
    path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|text| parse(&text))
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &Settings) {
    let Some(path) = path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(settings) {
        // 保存できなくても、この起動中は選んだ設定で動く。
        let _ = fs::write(path, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broken_or_partial_files_fall_back_to_defaults() {
        assert_eq!(parse("not json"), Settings::default());
        assert_eq!(parse("{}"), Settings::default());
        assert!(!parse(r#"{"closeToTray":false,"unknown":1}"#).close_to_tray);
    }
}
