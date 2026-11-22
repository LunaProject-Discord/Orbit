//! Orbit Mail のデスクトップ版。
//! 画面は apps/web の静的出力をそのまま載せ、ここでは OS との橋渡しだけを受け持つ
//! (ウィンドウ枠、トレイ、未読数のバッジ、新着メールの通知、外部リンク、自動更新)。

mod badge;
mod fonts;
mod settings;
mod tray;
mod updater;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Url, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use settings::Settings;

pub(crate) const MAIN_WINDOW: &str = "main";
/// 通知が押されたときに画面へ送るイベント。
const OPEN_MESSAGE_EVENT: &str = "desktop://open-message";
/// アプリ専用の URL で開かれたときに画面へ送るイベント。
const APP_URL_EVENT: &str = "desktop://app-url";
/// アプリ専用の URL のスキーム。外のブラウザーでの Google / Microsoft のログインから戻るときに使う
/// (tauri.conf.json の plugins.deep-link、Web 側の lib/native/oauth.ts と合わせる)。
const APP_URL_SCHEME: &str = "jp.lunaproject.orbit.mail";

pub(crate) struct AppState {
    pub settings: Mutex<Settings>,
    pub unread: AtomicU32,
    /// トレイの「終了」などで、本当に終了しようとしている。
    pub quitting: AtomicBool,
    /// この起動中に更新を尋ねたバージョン (自動確認で同じ版を何度も尋ねない)。
    pub prompted_update: Mutex<Option<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenMessage {
    message_id: Option<String>,
}

/// メインウィンドウを前面に出す (トレイに入っていれば戻す)。
pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn quit(app: &AppHandle) {
    app.state::<AppState>()
        .quitting
        .store(true, Ordering::SeqCst);
    app.exit(0);
}

/// メッセージの ID (UUID) の形かどうか。画面から受け取った値を通知に載せる前に確かめる。
fn is_message_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// 新着メールを OS の通知で知らせる。押されたら、そのメールを開くよう画面へ伝える。
#[tauri::command]
fn notify_new_mail(
    app: AppHandle,
    title: String,
    body: String,
    message_id: Option<String>,
) -> Result<(), String> {
    let mut builder = app.notification().builder().title(title).body(body);
    if let Some(id) = message_id.filter(|id| is_message_id(id)) {
        builder = builder.extra("messageId", id);
    }
    builder.show().map_err(|error| error.to_string())
}

/// 受信トレイの未読数を、トレイとタスクバー (Dock) のアイコンに出す。
#[tauri::command]
fn set_unread_count(app: AppHandle, count: u32) {
    let state = app.state::<AppState>();
    if state.unread.swap(count, Ordering::SeqCst) == count {
        return;
    }
    badge::apply(&app, count);
}

/// アプリの画面そのもの (同梱したファイル、開発時は dev サーバー) かどうか。
fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            Some("localhost") | Some("127.0.0.1") => tauri::is_dev(),
            _ => false,
        },
        _ => false,
    }
}

/// メール本文のリンクなどを、OS の既定のブラウザーやメールソフトで開く。
fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
        .expect("tauri.conf.json に main ウィンドウの設定がありません");

    // 画面が描かれる前に、デスクトップ版であることを html に印を付けて伝える
    // (タイトルバーの分の余白を最初から確保し、表示がずれないようにする)。
    let script = format!(
        r#"(function () {{
  var mark = function () {{ document.documentElement.dataset.desktop = "{platform}"; }};
  if (document.documentElement) return mark();
  new MutationObserver(function (_, observer) {{
    if (!document.documentElement) return;
    observer.disconnect();
    mark();
  }}).observe(document, {{ childList: true }});
}})();"#,
        platform = platform_name()
    );

    let navigation_handle = app.clone();
    let new_window_handle = app.clone();
    WebviewWindowBuilder::from_config(app, &config)?
        .initialization_script(script)
        // アプリの画面の外へは移動させず、外部の URL はブラウザーで開く
        // (Google / Microsoft のログイン画面もここを通る)。
        .on_navigation(move |url| {
            if is_app_url(url) {
                return true;
            }
            open_external(&navigation_handle, url);
            false
        })
        .on_new_window(move |url, _features| {
            open_external(&new_window_handle, &url);
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        // 二重に起動されたら、すでに開いているウィンドウを前に出す。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            notify_new_mail,
            set_unread_count,
            fonts::list_fonts
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AppState {
                settings: Mutex::new(settings::load(&handle)),
                unread: AtomicU32::new(0),
                quitting: AtomicBool::new(false),
                prompted_update: Mutex::new(None),
            });

            updater::setup(&handle)?;
            create_main_window(&handle)?;
            tray::setup(&handle)?;

            // インストーラーを通さずに動かしているとき (開発中、Linux の AppImage) も、
            // アプリ専用の URL でこのアプリが開くようにする。
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            let _ = app.deep_link().register_all();

            // 外のブラウザーでのログインから戻ってきたら、ウィンドウを前に出して画面へ渡す。
            let url_handle = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if url.scheme() != APP_URL_SCHEME {
                        continue;
                    }
                    show_main_window(&url_handle);
                    let _ = url_handle.emit_to(MAIN_WINDOW, APP_URL_EVENT, url.to_string());
                }
            });

            // 通知が押されたら、ウィンドウを前に出してそのメールを開く。
            let action_handle = handle.clone();
            app.notification().on_action(move |action| {
                if action.action_id() != "tap" {
                    return;
                }
                let message_id = action
                    .notification()
                    .and_then(|notification| notification.extra().get("messageId"))
                    .and_then(|value| value.as_str())
                    .filter(|id| is_message_id(id))
                    .map(str::to_owned);
                show_main_window(&action_handle);
                let _ = action_handle.emit_to(
                    MAIN_WINDOW,
                    OPEN_MESSAGE_EVENT,
                    OpenMessage { message_id },
                );
            })?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let keep_running = state
                    .settings
                    .lock()
                    .map(|s| s.close_to_tray)
                    .unwrap_or(true);
                // 閉じてもトレイに残し、新着メールの通知を受け続ける。
                if keep_running && !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Orbit Mail を起動できませんでした");

    app.run(|app, event| match event {
        // macOS で Dock のアイコンが押されたら、閉じていたウィンドウを戻す。
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main_window(app),
        RunEvent::ExitRequested { .. } => {
            app.state::<AppState>()
                .quitting
                .store(true, Ordering::SeqCst);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_id_must_be_uuid() {
        assert!(is_message_id("019aa0c2-7b3e-7c11-9d2f-0123456789ab"));
        assert!(!is_message_id("019aa0c2-7b3e-7c11-9d2f-0123456789a"));
        assert!(!is_message_id("019aa0c2_7b3e_7c11_9d2f_0123456789ab"));
        assert!(!is_message_id("../../etc/passwd"));
    }

    #[test]
    fn only_app_urls_stay_in_the_window() {
        let url = |value: &str| Url::parse(value).unwrap();
        assert!(is_app_url(&url("tauri://localhost/login")));
        assert!(is_app_url(&url("http://tauri.localhost/")));
        assert!(is_app_url(&url("about:srcdoc")));
        assert!(!is_app_url(&url(
            "https://accounts.google.com/o/oauth2/v2/auth"
        )));
        assert!(!is_app_url(&url("https://tauri.localhost.example.com/")));
        assert!(!is_app_url(&url("mailto:someone@example.com")));
        assert!(!is_app_url(&url("file:///etc/passwd")));
    }
}
