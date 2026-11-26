//! Windows の新着メールの通知 (トースト)。
//! 通知のプラグインはボタンまでしか出せないので、Windows だけはトーストの XML を自分で組み立て、
//! ボタン (既読にする、アーカイブなど) と返信欄を付ける。
//!
//! 押されたボタンと書いた文章は、画面へイベントで渡す。実際の操作と送信は、ログインしている
//! 画面が既存の API (メールへの操作、POST /v1/messages/send) で行う。
//!
//! 制限: 押された操作は、この通知に付けた受け口 (Activated) で受け取るので、通知センターに
//! 移ったあとの通知の操作はアプリへ届かないことがある (通知のプラグインと同じ制限)。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{Interface, HSTRING};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::{IReference, TypedEventHandler};
use windows::UI::Notifications::{
    ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
};

use crate::toast_xml::{
    is_button_id, toast_xml, ToastButton, ACTION_PREFIX, REPLY_INPUT, SEND_REPLY,
};
use crate::{show_main_window, OpenMessage, MAIN_WINDOW, OPEN_MESSAGE_EVENT};

/// ボタンが押された、または返信が送られたときに画面へ送るイベント。
pub(crate) const NOTIFICATION_ACTION_EVENT: &str = "desktop://notification-action";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationAction {
    message_id: String,
    /// "reply" か、ボタンの ID ("read"、"archive" など)。
    action: String,
    /// 返信欄に書いた文章 (返信のときだけ)。
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

/// 通知に使うアプリの ID (AppUserModelID)。インストールしたアプリは識別子、
/// 開発中 (target\debug などから直接動かしている) は PowerShell の ID を借りる
/// (通知のプラグインと同じ決め方。登録されていない ID では通知が出ないため)。
fn app_id(app: &AppHandle) -> String {
    const POWERSHELL_APP_ID: &str =
        "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
    let installed = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.display().to_string()))
        .map(|dir| !(dir.ends_with("\\target\\debug") || dir.ends_with("\\target\\release")))
        .unwrap_or(true);
    if installed {
        app.config().identifier.clone()
    } else {
        POWERSHELL_APP_ID.to_owned()
    }
}

/// 押されたボタン (引数) と、返信欄に書いた文章を読む。
fn read_activation(args: &Option<windows::core::IInspectable>) -> Option<(String, Option<String>)> {
    let args = args.as_ref()?.cast::<ToastActivatedEventArgs>().ok()?;
    let arguments = args.Arguments().ok()?.to_string();
    let text = args
        .UserInput()
        .ok()
        .and_then(|input| input.Lookup(&HSTRING::from(REPLY_INPUT)).ok())
        .and_then(|value| value.cast::<IReference<HSTRING>>().ok())
        .and_then(|value| value.Value().ok())
        .map(|value| value.to_string());
    Some((arguments, text))
}

fn handle_activation(
    app: &AppHandle,
    message_id: Option<&str>,
    arguments: &str,
    text: Option<String>,
) {
    let Some(message_id) = message_id else {
        // まとめた通知など、メールの決まっていない通知。押されたら受信トレイを開く。
        show_main_window(app);
        let _ = app.emit_to(
            MAIN_WINDOW,
            OPEN_MESSAGE_EVENT,
            OpenMessage { message_id: None },
        );
        return;
    };
    let action = if arguments == SEND_REPLY {
        let text = text.unwrap_or_default();
        if text.trim().is_empty() {
            // 何も書かずに送信が押された。メールを開いて、アプリの返信欄から書けるようにする。
            show_main_window(app);
            let _ = app.emit_to(
                MAIN_WINDOW,
                OPEN_MESSAGE_EVENT,
                OpenMessage {
                    message_id: Some(message_id.to_owned()),
                },
            );
            return;
        }
        NotificationAction {
            message_id: message_id.to_owned(),
            action: SEND_REPLY.to_owned(),
            text: Some(text),
        }
    } else if let Some(id) = arguments
        .strip_prefix(ACTION_PREFIX)
        .filter(|id| is_button_id(id))
    {
        NotificationAction {
            message_id: message_id.to_owned(),
            action: id.to_owned(),
            text: None,
        }
    } else {
        // 通知そのものが押された。ウィンドウを前に出してそのメールを開く。
        show_main_window(app);
        let _ = app.emit_to(
            MAIN_WINDOW,
            OPEN_MESSAGE_EVENT,
            OpenMessage {
                message_id: Some(message_id.to_owned()),
            },
        );
        return;
    };
    // ボタンと返信は、ウィンドウを出さずに画面へ渡す (画面がトレイに入っていても動いている)。
    let _ = app.emit_to(MAIN_WINDOW, NOTIFICATION_ACTION_EVENT, action);
}

/// 送信ボタンの絵 (アプリに埋め込んだ PNG)。作成画面の送信ボタンと同じ Lucide の send を黒で描いたもの。
/// Windows はダークモードのトーストでこの絵の色を反転させる (黒は白になる) ので、色は付けない。
/// トーストは絵をファイルで受け取るので、
/// アプリのキャッシュのフォルダへ書き出して file:/// の URL を返す。書き出せなければ None
/// (そのときは送信ボタンを文字のボタンにする)。
fn send_icon(app: &AppHandle) -> Option<String> {
    const ICON: &[u8] = include_bytes!("../icons/notification-send.png");
    let dir = app.path().app_cache_dir().ok()?;
    let path = dir.join("notification-send.png");
    let current = std::fs::read(&path).ok();
    if current.as_deref() != Some(ICON) {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&path, ICON).ok()?;
    }
    Some(format!(
        "file:///{}",
        path.display().to_string().replace('\\', "/")
    ))
}

/// トーストを出す。
pub(crate) fn show(
    app: &AppHandle,
    title: &str,
    body: &str,
    message_id: Option<String>,
    buttons: &[ToastButton],
    reply: bool,
) -> windows::core::Result<()> {
    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(toast_xml(
        title,
        body,
        message_id.as_deref(),
        buttons,
        reply,
        send_icon(app).as_deref(),
    )))?;
    let toast = ToastNotification::CreateToastNotification(&doc)?;
    if let Some(id) = &message_id {
        // 同じメールの通知は置き換える (二重に出さない)。
        toast.SetTag(&HSTRING::from(id.as_str()))?;
    }
    let handle = app.clone();
    toast.Activated(&TypedEventHandler::<
        ToastNotification,
        windows::core::IInspectable,
    >::new(move |_, args| {
        if let Some((arguments, text)) = read_activation(&args) {
            handle_activation(&handle, message_id.as_deref(), &arguments, text);
        }
        Ok(())
    }))?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id(app)))?.Show(&toast)
}
