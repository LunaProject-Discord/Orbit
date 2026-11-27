//! ショートカットからの起動。
//! デスクトップ版は「Orbit」という 1 つのアプリで、Orbit Mail / Calendar / Contacts のショートカットは
//! どれも同じ実行ファイルを `--app=<名前>` 付きで起動する (Windows のインストーラーが作るショートカット、
//! Linux の .desktop の「アクション」)。すでに起動していれば、単一インスタンスのプラグインが
//! 引数をこちらへ渡すので、そのアプリのウィンドウを前に出す。
//!
//! 予定の通知を押したときも、ここ (open_event) を通ってカレンダーのウィンドウを出す。
//! 段取り 10 でカレンダーを専用のウィンドウにするときは open_app だけを変えればよく、通知のコードは変えない。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, WebviewWindow};

use crate::reminder_xml::OpenEventTarget;
use crate::{show_main_window, MAIN_WINDOW};

/// 予定を開いてほしいときに画面へ送るイベント (apps/web の DESKTOP_CALENDAR_EVENTS.openEvent)。
pub(crate) const OPEN_EVENT_EVENT: &str = "desktop://open-event";
/// 画面が受け取りに来るのを待つ時間。アプリの起動直後は、画面がイベントを聞き始める前に届くことがある。
const PENDING_OPEN_EVENT_TTL: Duration = Duration::from_secs(120);

/// まだ画面が受け取っていない「予定を開いてほしい」(ウィンドウの名前、開く予定、届いた時刻)。
static PENDING_OPEN_EVENT: Mutex<Option<(&'static str, OpenEventTarget, Instant)>> =
    Mutex::new(None);

/// Orbit のアプリ。名前はショートカットの引数 (`--app=mail`) と同じ。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OrbitApp {
    Mail,
    Calendar,
    Contacts,
}

impl OrbitApp {
    fn parse(value: &str) -> Option<OrbitApp> {
        match value.trim().to_ascii_lowercase().as_str() {
            "mail" => Some(OrbitApp::Mail),
            "calendar" => Some(OrbitApp::Calendar),
            "contacts" => Some(OrbitApp::Contacts),
            _ => None,
        }
    }
}

/// 起動の引数から、開くアプリを読む (`--app=mail` と `--app mail` の両方を受け付ける)。
/// 指定が無い、または知らない名前なら None。
pub fn requested_app<I, S>(args: I) -> Option<OrbitApp>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let arg = arg.as_ref();
        if let Some(value) = arg.strip_prefix("--app=") {
            return OrbitApp::parse(value);
        }
        if arg == "--app" {
            return args
                .next()
                .and_then(|value| OrbitApp::parse(value.as_ref()));
        }
    }
    None
}

/// アプリのウィンドウを前に出し、そのウィンドウの名前を返す。
pub fn open_app(app: &AppHandle, target: OrbitApp) -> &'static str {
    match target {
        OrbitApp::Mail => show_main_window(app),
        // カレンダーと連絡先はまだ無い。できたら、それぞれのウィンドウを開く
        // (それまではショートカットも作らない。windows/installer.nsi の ORBIT_APPS)。
        // いまはメインウィンドウを出し、予定を開くときは画面がカレンダーへ移る。
        OrbitApp::Calendar | OrbitApp::Contacts => show_main_window(app),
    }
    MAIN_WINDOW
}

/// 予定の通知が押された: カレンダーのウィンドウを出し、その予定を開くよう画面へ伝える。
/// event_id が無ければ (まとめた通知など) カレンダーを開くだけ。
/// アプリの起動直後で画面がまだ聞いていなくても届くよう、画面が take_pending_open_event で
/// 受け取りに来るまで覚えておく (イベントは「受け取りに来て」の合図も兼ねる)。
pub(crate) fn open_event(app: &AppHandle, target: OpenEventTarget) {
    let label = open_app(app, OrbitApp::Calendar);
    if let Ok(mut pending) = PENDING_OPEN_EVENT.lock() {
        *pending = Some((label, target.clone(), Instant::now()));
    }
    let _ = app.emit_to(label, OPEN_EVENT_EVENT, target);
}

/// まだ受け取っていない「予定を開いてほしい」を受け取る (1 度だけ)。
/// 頼んだウィンドウ以外から呼ばれたら何も返さない。
#[tauri::command]
pub(crate) fn take_pending_open_event(window: WebviewWindow) -> Option<OpenEventTarget> {
    let mut pending = PENDING_OPEN_EVENT.lock().ok()?;
    take_pending(&mut pending, window.label(), Instant::now())
}

fn take_pending(
    pending: &mut Option<(&'static str, OpenEventTarget, Instant)>,
    label: &str,
    now: Instant,
) -> Option<OpenEventTarget> {
    match pending {
        Some((_, _, at)) if now.duration_since(*at) > PENDING_OPEN_EVENT_TTL => {
            *pending = None;
            None
        }
        Some((owner, _, _)) if *owner == label => pending.take().map(|(_, target, _)| target),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_app_from_the_arguments() {
        assert_eq!(
            requested_app(["orbit-desktop.exe", "--app=mail"]),
            Some(OrbitApp::Mail)
        );
        assert_eq!(
            requested_app(["orbit-desktop", "--app", "calendar"]),
            Some(OrbitApp::Calendar)
        );
        assert_eq!(
            requested_app(["orbit-desktop", "--app=Contacts"]),
            Some(OrbitApp::Contacts)
        );
        assert_eq!(requested_app(["orbit-desktop"]), None);
        assert_eq!(requested_app(["orbit-desktop", "--app=photos"]), None);
        assert_eq!(requested_app(["orbit-desktop", "--app"]), None);
        // アプリ専用の URL (ログインから戻るとき) は、ここでは扱わない。
        assert_eq!(
            requested_app(["orbit-desktop", "jp.lunaproject.orbit.mail://oauth?code=x"]),
            None
        );
    }

    #[test]
    fn 開いてほしい予定は頼んだウィンドウが_1_度だけ受け取る() {
        let target = OpenEventTarget {
            event_id: Some("019aa0c2-7b3e-7c11-9d2f-0123456789ab".into()),
            recurrence_id: None,
        };
        let at = Instant::now();
        let mut pending = Some((MAIN_WINDOW, target.clone(), at));
        assert_eq!(take_pending(&mut pending, "window-1", at), None);
        assert_eq!(
            take_pending(&mut pending, MAIN_WINDOW, at),
            Some(target.clone())
        );
        assert_eq!(take_pending(&mut pending, MAIN_WINDOW, at), None);

        // 古いものは捨てる (しばらくして開いた画面が、昔押した通知の予定を開かない)。
        let mut pending = Some((MAIN_WINDOW, target, at));
        let later = at + PENDING_OPEN_EVENT_TTL + Duration::from_secs(1);
        assert_eq!(take_pending(&mut pending, MAIN_WINDOW, later), None);
        assert!(pending.is_none());
    }
}
