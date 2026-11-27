//! 画面側のタイトルバー (各アプリの上部の行) を支える処理。
//!
//! - macOS の信号機ボタンの位置。上部の行 (高さ 56px) があるウィンドウでは、その行の縦の中央へ下げる
//!   (tauri.macos.conf.json の trafficLightPosition)。作成専用のウィンドウは上部の行が無く、
//!   画面側が細いタイトルバーを出すので、OS の既定の位置のままにする。
//! - 上部の行の空き部分をダブルクリックしたときの動き。macOS はシステム設定
//!   (「タイトルバーをダブルクリックしたとき」) に従う。Windows と Linux は最大化と元に戻すを切り替える。

use tauri::WebviewWindow;

/// 作成専用のウィンドウ (?window=compose) のパスか。画面側の lib/windows.ts と合わせる。
pub(crate) fn is_compose_path(path: &str) -> bool {
    path.split_once('?')
        .map(|(_, query)| query.split('&').any(|pair| pair == "window=compose"))
        .unwrap_or(false)
}

/// タイトルバーをダブルクリックしたときの動き。
#[derive(Debug, PartialEq, Eq)]
enum DoubleClickAction {
    /// 最大化と元に戻すを切り替える (macOS の「拡大/縮小」「しない」以外の既定)。
    Zoom,
    Minimize,
    None,
}

/// macOS の設定の値から動きを決める。action は AppleActionOnDoubleClick
/// ("Maximize" / "Fill" / "Minimize" / "None")、legacy は古い AppleMiniaturizeOnDoubleClick ("1" なら しまう)。
/// どちらも無ければ OS の既定 (拡大/縮小)。
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn double_click_action(action: Option<&str>, legacy: Option<&str>) -> DoubleClickAction {
    match action.map(str::trim) {
        Some("Minimize") => DoubleClickAction::Minimize,
        Some("None") => DoubleClickAction::None,
        Some(_) => DoubleClickAction::Zoom,
        None if legacy.map(str::trim) == Some("1") => DoubleClickAction::Minimize,
        None => DoubleClickAction::Zoom,
    }
}

#[cfg(target_os = "macos")]
fn read_global_default(key: &str) -> Option<String> {
    let output = std::process::Command::new("/usr/bin/defaults")
        .args(["read", "-g", key])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(target_os = "macos")]
fn current_action() -> DoubleClickAction {
    // 設定は利用者がいつでも変えられるので、押されるたびに読む (ダブルクリックはまれなので軽い)。
    let action = read_global_default("AppleActionOnDoubleClick");
    let legacy = read_global_default("AppleMiniaturizeOnDoubleClick");
    double_click_action(action.as_deref(), legacy.as_deref())
}

#[cfg(not(target_os = "macos"))]
fn current_action() -> DoubleClickAction {
    DoubleClickAction::Zoom
}

/// 上部の行の空き部分がダブルクリックされた。画面側は、呼べなかったとき (null) と見分けるために true を受け取る。
#[tauri::command]
pub fn title_bar_double_click(window: WebviewWindow) -> Result<bool, String> {
    let result = match current_action() {
        DoubleClickAction::Zoom => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        DoubleClickAction::Minimize => window.minimize(),
        DoubleClickAction::None => Ok(()),
    };
    result.map(|()| true).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_windows_are_found_by_query() {
        assert!(is_compose_path("/mail/compose/new?window=compose&fresh=1"));
        assert!(is_compose_path("/mail/compose/new?fresh=1&window=compose"));
        assert!(!is_compose_path("/mail/accounts/a/messages/b?window=message"));
        assert!(!is_compose_path("/mail/compose/new"));
        assert!(!is_compose_path("/mail/window=compose"));
        assert!(!is_compose_path("/mail?window=composer"));
    }

    #[test]
    fn double_click_follows_the_macos_setting() {
        use DoubleClickAction as A;
        assert_eq!(double_click_action(Some("Maximize"), None), A::Zoom);
        assert_eq!(double_click_action(Some("Fill"), None), A::Zoom);
        assert_eq!(double_click_action(Some("Minimize"), None), A::Minimize);
        assert_eq!(double_click_action(Some("None\n"), None), A::None);
        assert_eq!(double_click_action(None, Some("1")), A::Minimize);
        assert_eq!(double_click_action(None, Some("0")), A::Zoom);
        assert_eq!(double_click_action(None, None), A::Zoom);
        // 新しい設定があれば、古い設定より優先する。
        assert_eq!(double_click_action(Some("Maximize"), Some("1")), A::Zoom);
    }
}
