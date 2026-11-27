//! アプリ本体の自動更新 (docs/updates.md)。
//! 更新は接続先のサーバーから受け取る。サーバーは自分と同じ版のアプリを配るので、サーバーの版を
//! 固定すればアプリも同じ版に揃う。どこへ問い合わせるかと、更新のしかた (auto / notify / off) は、
//! 画面が接続先のサーバーの情報 (/v1/server-info) を読んで native_update_configure で渡す。
//! 署名の公開鍵はビルド時の設定 (plugins.updater.pubkey) で渡す。設定の無いビルド
//! (開発中、鍵を用意する前) では何もしない。

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 起動してから最初に確認するまでの時間と、その後の間隔。
const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// 確認せずに取得して入れる (macOS と Linux はすぐ、Windows は終了するときに入れる)。
    Auto,
    /// 新しい版があることを知らせ、入れるかを尋ねる。
    Notify,
    /// 何もしない。
    Off,
}

impl Mode {
    fn parse(value: &str) -> Mode {
        match value {
            "auto" => Mode::Auto,
            "off" => Mode::Off,
            _ => Mode::Notify,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Mode::Auto => "auto",
            Mode::Notify => "notify",
            Mode::Off => "off",
        }
    }
}

#[derive(Default)]
pub struct UpdaterState {
    /// 問い合わせ先 (接続先のサーバーの更新の URL) と、更新のしかた。
    target: Mutex<Option<(Url, Mode)>>,
    /// この起動中に更新を尋ねたバージョン (自動確認で同じ版を何度も尋ねない)。
    prompted: Mutex<Option<String>>,
    /// 取得済みで、終了するときに入れる更新 (Windows の auto)。
    pending: Mutex<Option<(Update, Vec<u8>)>>,
    /// 入れ終えて、次に起動したときに使われる版 (macOS と Linux の auto)。
    installed: Mutex<Option<String>>,
}

fn configured(app: &AppHandle) -> bool {
    app.config().plugins.0.contains_key("updater")
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    app.manage(UpdaterState::default());
    if !configured(app) {
        return Ok(());
    }
    app.plugin(tauri_plugin_updater::Builder::new().build())?;

    let handle = app.clone();
    std::thread::Builder::new()
        .name("update-check".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK);
            loop {
                check(handle.clone(), false);
                std::thread::sleep(CHECK_INTERVAL);
            }
        })?;
    Ok(())
}

/// サーバーの URL から、更新を問い合わせる URL を作る。{{...}} は updater が埋める。
pub(crate) fn endpoint(server: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(server.trim()).map_err(|_| "サーバーの URL が不正です。".to_string())?;
    // updater は HTTPS でしか問い合わせない (通信の途中で書き換えられないように)。
    if url.scheme() != "https" {
        return Err("サーバーが HTTPS ではないので、アプリ本体は更新できません。".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("サーバーの URL が不正です。".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    let base = url.as_str().trim_end_matches('/').to_string();
    Url::parse(&format!(
        "{base}/v1/app-update/desktop?current={{{{current_version}}}}&target={{{{target}}}}&arch={{{{arch}}}}&bundle={{{{bundle_type}}}}"
    ))
    .map_err(|_| "サーバーの URL が不正です。".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUpdateStatus {
    /// このビルドで本体の自動更新が使えるか (署名の公開鍵を入れてビルドしたか)。
    configured: bool,
    /// いまのアプリ本体の版。
    version: String,
    /// 接続先のサーバーが決めた更新のしかた。まだ決まっていなければ null。
    mode: Option<&'static str>,
    /// 取得済みで、終了するときに入る版。
    pending: Option<String>,
    /// 入れ終えて、次に起動したときに使われる版。
    installed: Option<String>,
}

/// 接続先のサーバーの情報を受け取る。画面が起動するたび (と接続先を変えたとき) に呼ぶ。
#[tauri::command]
pub fn native_update_configure(
    app: AppHandle,
    server_url: String,
    mode: String,
) -> Result<(), String> {
    let mode = Mode::parse(&mode);
    let url = endpoint(&server_url)?;
    let state = app.state::<UpdaterState>();
    let changed = {
        let mut target = state.target.lock().map_err(|_| "状態を読めません。")?;
        let changed = target.as_ref() != Some(&(url.clone(), mode));
        *target = Some((url, mode));
        changed
    };
    // 起動してすぐは最初の確認 (FIRST_CHECK) に任せる。接続先や方針が変わったときだけ確かめ直す。
    if changed && configured(&app) && mode != Mode::Off {
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(FIRST_CHECK);
            check(handle, false);
        });
    }
    Ok(())
}

#[tauri::command]
pub fn native_update_status(app: AppHandle) -> NativeUpdateStatus {
    let state = app.state::<UpdaterState>();
    let mode = state
        .target
        .lock()
        .ok()
        .and_then(|target| target.as_ref().map(|(_, mode)| mode.name()));
    let pending = state
        .pending
        .lock()
        .ok()
        .and_then(|pending| pending.as_ref().map(|(update, _)| update.version.clone()));
    let installed = state.installed.lock().ok().and_then(|value| value.clone());
    NativeUpdateStatus {
        configured: configured(&app),
        version: app.package_info().version.to_string(),
        mode,
        pending,
        installed,
    }
}

/// 設定のバージョン情報の「更新を確認」から呼ぶ (結果は必ず知らせる)。
#[tauri::command]
pub fn native_update_check(app: AppHandle) {
    check(app, true);
}

/// 取得済みの更新 (pending) をすぐに入れて再起動する。
#[tauri::command]
pub fn native_update_install_now(app: AppHandle) -> Result<(), String> {
    let taken = app
        .state::<UpdaterState>()
        .pending
        .lock()
        .map_err(|_| "状態を読めません。")?
        .take();
    match taken {
        Some((update, bytes)) => {
            update.install(bytes).map_err(|error| error.to_string())?;
            app.restart();
        }
        None => Err("入れる更新がありません。".into()),
    }
}

/// 終了するときに呼ぶ。取得済みの更新があれば入れる (Windows はインストーラーが動き、終わると起動し直す)。
pub fn install_pending(app: &AppHandle) {
    let Some(state) = app.try_state::<UpdaterState>() else {
        return;
    };
    let taken = state
        .pending
        .lock()
        .ok()
        .and_then(|mut pending| pending.take());
    if let Some((update, bytes)) = taken {
        if let Err(error) = update.install(bytes) {
            eprintln!("終了時の更新に失敗しました: {error}");
        }
    }
}

fn info(app: &AppHandle, message: impl Into<String>) {
    app.dialog()
        .message(message)
        .title("Orbit の更新")
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

/// 更新を確認する。manual はメニューや設定から確認したとき (結果を必ず知らせる)。
pub fn check(app: AppHandle, manual: bool) {
    if !configured(&app) {
        if manual {
            info(&app, "このビルドでは、アプリ本体の自動更新は無効です。");
        }
        return;
    }
    let target = app
        .state::<UpdaterState>()
        .target
        .lock()
        .ok()
        .and_then(|target| target.clone());
    let Some((url, mode)) = target else {
        if manual {
            info(
                &app,
                "接続先のサーバーの情報をまだ読み込んでいません。少し待ってからお試しください。",
            );
        }
        return;
    };
    if mode == Mode::Off {
        if manual {
            info(
                &app,
                "接続先のサーバーの設定で、アプリ本体の自動更新は止められています。",
            );
        }
        return;
    }
    tauri::async_runtime::spawn(async move {
        let result = match app.updater_builder().endpoints(vec![url]) {
            Ok(builder) => match builder.build() {
                Ok(updater) => updater.check().await,
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        match result {
            Ok(Some(update)) => {
                if mode == Mode::Auto && !manual {
                    auto_install(&app, update).await;
                } else {
                    prompt(&app, update, manual);
                }
            }
            Ok(None) if manual => info(
                &app,
                format!("最新のバージョンです ({})。", app.package_info().version),
            ),
            Err(error) if manual => info(&app, format!("更新を確認できませんでした。\n{error}")),
            Err(error) => eprintln!("更新を確認できませんでした: {error}"),
            _ => {}
        }
    });
}

/// 確認せずに取得する。macOS と Linux はその場で入れ (次に起動したときに使われる)、
/// Windows は入れるとアプリが終了するので、終了するときまで取っておく。
async fn auto_install(app: &AppHandle, update: Update) {
    let state = app.state::<UpdaterState>();
    {
        let already = state
            .pending
            .lock()
            .ok()
            .and_then(|pending| pending.as_ref().map(|(u, _)| u.version.clone()));
        let installed = state.installed.lock().ok().and_then(|value| value.clone());
        if already.as_deref() == Some(update.version.as_str())
            || installed.as_deref() == Some(update.version.as_str())
        {
            return;
        }
    }
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("更新を取得できませんでした: {error}");
            return;
        }
    };
    if cfg!(windows) {
        if let Ok(mut pending) = state.pending.lock() {
            *pending = Some((update, bytes));
        }
    } else {
        let version = update.version.clone();
        match update.install(bytes) {
            Ok(()) => {
                if let Ok(mut installed) = state.installed.lock() {
                    *installed = Some(version);
                }
            }
            Err(error) => eprintln!("更新を入れられませんでした: {error}"),
        }
    }
}

fn prompt(app: &AppHandle, update: Update, manual: bool) {
    {
        let state = app.state::<UpdaterState>();
        let Ok(mut prompted) = state.prompted.lock() else {
            return;
        };
        // 自動の確認では、同じバージョンを 1 回の起動で 1 度だけ尋ねる。
        if !manual && prompted.as_deref() == Some(update.version.as_str()) {
            return;
        }
        *prompted = Some(update.version.clone());
    }

    let handle = app.clone();
    app.dialog()
        .message(format!(
            "新しいバージョン {} があります (現在は {})。\n更新して再起動しますか?",
            update.version, update.current_version
        ))
        .title("Orbit の更新")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "更新して再起動".into(),
            "あとで".into(),
        ))
        .show(move |accepted| {
            if !accepted {
                return;
            }
            tauri::async_runtime::spawn(async move {
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => handle.restart(),
                    Err(error) => info(&handle, format!("更新できませんでした。\n{error}")),
                }
            });
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 問い合わせ先はサーバーの下の_v1_app_update_desktop() {
        let url = endpoint("https://orbit.example.com/").unwrap();
        assert_eq!(
            url.as_str(),
            "https://orbit.example.com/v1/app-update/desktop?current={{current_version}}&target={{target}}&arch={{arch}}&bundle={{bundle_type}}"
        );
        let url = endpoint("https://example.com/orbit?x=1").unwrap();
        assert!(url
            .as_str()
            .starts_with("https://example.com/orbit/v1/app-update/desktop?"));
    }

    #[test]
    fn https_以外のサーバーからは更新しない() {
        assert!(endpoint("http://localhost:8787").is_err());
        assert!(endpoint("https://user:pass@example.com").is_err());
        assert!(endpoint("not a url").is_err());
    }

    #[test]
    fn 更新のしかたの読み取り() {
        assert_eq!(Mode::parse("auto"), Mode::Auto);
        assert_eq!(Mode::parse("off"), Mode::Off);
        assert_eq!(Mode::parse("notify"), Mode::Notify);
        assert_eq!(Mode::parse("?"), Mode::Notify);
    }
}
