//! ショートカットからの起動。
//! デスクトップ版は「Orbit」という 1 つのアプリで、Orbit Mail / Calendar / Contacts のショートカットは
//! どれも同じ実行ファイルを `--app=<名前>` 付きで起動する (Windows のインストーラーが作るショートカット、
//! Linux の .desktop の「アクション」)。すでに起動していれば、単一インスタンスのプラグインが
//! 引数をこちらへ渡すので、そのアプリのウィンドウを前に出す。

use tauri::AppHandle;

use crate::show_main_window;

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

/// アプリのウィンドウを前に出す。
pub fn open_app(app: &AppHandle, target: OrbitApp) {
    match target {
        OrbitApp::Mail => show_main_window(app),
        // カレンダーと連絡先はまだ無い。できたら、それぞれのウィンドウを開く
        // (それまではショートカットも作らない。windows/installer.nsi の ORBIT_APPS)。
        OrbitApp::Calendar | OrbitApp::Contacts => show_main_window(app),
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
}
