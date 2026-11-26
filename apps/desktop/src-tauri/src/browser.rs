//! WebView のブラウザーとしての機能を、アプリ向けに整える。
//!
//! - Windows (WebView2) のブラウザーのショートカット (F5、Ctrl+P、Ctrl+F、Ctrl+U など) を止める。
//!   同じキーへのアプリの操作は、画面側 (apps/web/src/lib/desktop/browser-keys.ts) が割り当てる。
//!   ズーム (Ctrl+± / Ctrl+ホイール / ピンチ)、ステータスバー (リンクの URL の表示)、
//!   スワイプでの戻る・進むは、Tauri (wry) が既定で止めている。
//! - 強制再読み込み (キャッシュを使わない再読み込み)。画面からは頼めないので、OS ごとの WebView に頼む。
//! - 添付ファイルなどの保存。WebView のダウンロード (右上に出る一覧) を使わず、保存先を選ぶ画面を出す。

use std::path::Path;

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// 保存するファイル名を受け取るヘッダー (URL エンコードした文字列)。
const FILE_NAME_HEADER: &str = "x-file-name";

/// ブラウザーのショートカットを止める。開発中は開発者ツール (F12) を使えるよう、止めない。
pub fn disable_browser_keys(window: &WebviewWindow) {
    if cfg!(debug_assertions) {
        return;
    }
    #[cfg(windows)]
    let _ = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows::core::Interface;
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };
        if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    });
    #[cfg(not(windows))]
    let _ = window;
}

/// キャッシュを使わずに、画面を読み込み直す。
#[tauri::command]
pub fn force_reload(window: WebviewWindow) -> Result<(), String> {
    window
        .with_webview(|webview| {
            #[cfg(windows)]
            unsafe {
                use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
                use windows::core::w;
                let Ok(core) = webview.controller().CoreWebView2() else {
                    return;
                };
                let handler =
                    CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
                let _ = core.CallDevToolsProtocolMethod(
                    w!("Page.reload"),
                    w!(r#"{"ignoreCache":true}"#),
                    &handler,
                );
            }
            #[cfg(target_os = "macos")]
            unsafe {
                let view: &objc2_web_kit::WKWebView = &*webview.inner().cast();
                let _ = view.reloadFromOrigin();
            }
            #[cfg(target_os = "linux")]
            {
                use webkit2gtk::WebViewExt;
                webview.inner().reload_bypass_cache();
            }
        })
        .map_err(|error| error.to_string())
}

/// 保存先の候補に出すファイル名。フォルダの区切りや制御文字は使わない。
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    match Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
    {
        Some(name) if !name.is_empty() => name.to_owned(),
        _ => "file".to_owned(),
    }
}

/// URL エンコードされた文字列を戻す (%XX だけを扱う)。
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = |byte: u8| (byte as char).to_digit(16);
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// ファイルを保存する。保存先は利用者が選ぶ。保存したら true、選ぶのをやめたら false。
/// 中身は、呼び出しの本体 (バイト列) で受け取る。
#[tauri::command]
pub async fn save_file(
    app: AppHandle,
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<bool, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("保存する中身がありません。".into());
    };
    let name = request
        .headers()
        .get(FILE_NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default();
    let Some(path) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(safe_file_name(&name))
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|error| error.to_string())?;
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ファイル名からフォルダの区切りを除く() {
        assert_eq!(safe_file_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_file_name("C:\\Windows\\a.txt"), "C__Windows_a.txt");
        assert_eq!(safe_file_name("見積書.pdf"), "見積書.pdf");
        assert_eq!(safe_file_name(""), "file");
        assert_eq!(safe_file_name(".."), "file");
    }

    #[test]
    fn url_エンコードを戻す() {
        assert_eq!(percent_decode("%E8%A6%8B%E7%A9%8D.pdf"), "見積.pdf");
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
