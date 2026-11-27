//! アプリ本体の自動更新 (docs/updates.md)。
//! 更新は接続先のサーバーから受け取る。サーバーは自分と同じ版のアプリを配るので、サーバーの版を
//! 固定すればアプリも同じ版に揃う。どこへ問い合わせるかと、更新のしかた (auto / notify / off) は、
//! 画面が接続先のサーバーの情報 (/v1/server-info) を読んで native_update_configure で渡す。
//! 署名の公開鍵はビルド時の設定 (plugins.updater.pubkey) で渡す。設定の無いビルド
//! (開発中、鍵を用意する前) では何もしない。
//! 確認・取得・入れ替えの状態は OS のダイアログでは知らせず、画面へイベント (STATUS_EVENT) で送り、
//! 画面が設定の「バージョン情報」とトーストに出す (apps/web/src/lib/app-update)。

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{show_main_window, MAIN_WINDOW};

/// 状態が変わるたびに画面へ送るイベント (中身は NativeUpdateStatus)。
pub const STATUS_EVENT: &str = "native-update://status";
/// トレイの「更新を確認」で、画面に設定の「バージョン情報」を開かせるイベント。
pub const OPEN_EVENT: &str = "native-update://open";

/// 起動してから最初に確認するまでの時間と、その後の間隔。
const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// 取得中の進み具合を画面へ送る間隔。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// 確認せずに取得して入れる (macOS と Linux はすぐ、Windows は終了するときに入れる)。
    Auto,
    /// 新しい版があることを画面に出し、利用者が「更新して再起動」を押したら入れる。
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

/// いま行っていること。画面の「アプリ本体の更新」にそのまま出す。
#[derive(Clone, Serialize, PartialEq, Eq, Debug, Default)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Phase {
    /// 何もしていない (取得済みの版は pending / installed で表す)。
    #[default]
    Idle,
    Checking,
    UpToDate {
        #[serde(rename = "checkedAt")]
        checked_at: u64,
    },
    /// 新しい版がある (notify)。利用者が入れるのを待っている。
    Available {
        version: String,
    },
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
    },
    /// 入れている (終わると再起動する、または次に起動したときに使われる)。
    Installing {
        version: String,
    },
    Error {
        message: String,
    },
}

impl Phase {
    fn busy(&self) -> bool {
        matches!(
            self,
            Phase::Checking | Phase::Downloading { .. } | Phase::Installing { .. }
        )
    }
}

#[derive(Default)]
pub struct UpdaterState {
    /// 問い合わせ先 (接続先のサーバーの更新の URL) と、更新のしかた。
    target: Mutex<Option<(Url, Mode)>>,
    phase: Mutex<Phase>,
    /// 見つかったが、まだ取得していない更新 (notify)。
    available: Mutex<Option<Update>>,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUpdateStatus {
    /// このビルドで本体の自動更新が使えるか (署名の公開鍵を入れてビルドしたか)。
    configured: bool,
    /// いまのアプリ本体の版。
    version: String,
    /// 接続先のサーバーが決めた更新のしかた。まだ決まっていなければ null。
    mode: Option<&'static str>,
    /// いま行っていること。
    phase: Phase,
    /// 取得済みで、終了するときに入る版。
    pending: Option<String>,
    /// 入れ終えて、次に起動したときに使われる版。
    installed: Option<String>,
}

fn snapshot(app: &AppHandle) -> NativeUpdateStatus {
    let state = app.state::<UpdaterState>();
    let mode = state
        .target
        .lock()
        .ok()
        .and_then(|target| target.as_ref().map(|(_, mode)| mode.name()));
    let phase = state
        .phase
        .lock()
        .map(|phase| phase.clone())
        .unwrap_or_default();
    let pending = state
        .pending
        .lock()
        .ok()
        .and_then(|pending| pending.as_ref().map(|(update, _)| update.version.clone()));
    let installed = state.installed.lock().ok().and_then(|value| value.clone());
    NativeUpdateStatus {
        configured: configured(app),
        version: app.package_info().version.to_string(),
        mode,
        phase,
        pending,
        installed,
    }
}

/// 状態を画面へ送る (全部のウィンドウ)。
fn emit(app: &AppHandle) {
    let _ = app.emit(STATUS_EVENT, snapshot(app));
}

fn set_phase(app: &AppHandle, phase: Phase) {
    if let Ok(mut current) = app.state::<UpdaterState>().phase.lock() {
        *current = phase;
    }
    emit(app);
}

fn current_phase(app: &AppHandle) -> Phase {
    app.state::<UpdaterState>()
        .phase
        .lock()
        .map(|phase| phase.clone())
        .unwrap_or_default()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
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
    if changed {
        emit(&app);
    }
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
    snapshot(&app)
}

/// 設定のバージョン情報の「更新を確認」から呼ぶ。結果は STATUS_EVENT で届く。
#[tauri::command]
pub fn native_update_check(app: AppHandle) {
    check(app, true);
}

/// 画面の「更新して再起動」「今すぐ更新」「再起動」から呼ぶ。
/// 取得済みの更新 (pending) があれば入れて再起動し、入れ終えていれば (installed) 再起動するだけ。
/// 見つかっただけの更新 (available) は、取得してから入れて再起動する。
#[tauri::command]
pub async fn native_update_install_now(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    let pending = state
        .pending
        .lock()
        .map_err(|_| "状態を読めません。")?
        .take();
    if let Some((update, bytes)) = pending {
        set_phase(
            &app,
            Phase::Installing {
                version: update.version.clone(),
            },
        );
        if let Err(error) = update.install(bytes) {
            let message = format!("更新を入れられませんでした ({error})");
            set_phase(
                &app,
                Phase::Error {
                    message: message.clone(),
                },
            );
            return Err(message);
        }
        app.restart();
    }
    let installed = state.installed.lock().ok().and_then(|value| value.clone());
    if installed.is_some() {
        app.restart();
    }
    let available = state
        .available
        .lock()
        .map_err(|_| "状態を読めません。")?
        .take();
    let Some(update) = available else {
        return Err("入れる更新がありません。".into());
    };
    let bytes = match download(&app, &update).await {
        Ok(bytes) => bytes,
        Err(error) => {
            let message = format!("更新を取得できませんでした ({error})");
            // もう一度押せるように、見つかった更新に戻しておく。
            if let Ok(mut available) = state.available.lock() {
                *available = Some(update);
            }
            set_phase(
                &app,
                Phase::Error {
                    message: message.clone(),
                },
            );
            return Err(message);
        }
    };
    set_phase(
        &app,
        Phase::Installing {
            version: update.version.clone(),
        },
    );
    if let Err(error) = update.install(bytes) {
        let message = format!("更新を入れられませんでした ({error})");
        set_phase(
            &app,
            Phase::Error {
                message: message.clone(),
            },
        );
        return Err(message);
    }
    app.restart();
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

/// トレイの「更新を確認」。メインウィンドウを出して設定の「バージョン情報」を開かせ、確認する。
pub fn check_from_tray(app: &AppHandle) {
    show_main_window(app);
    let _ = app.emit_to(MAIN_WINDOW, OPEN_EVENT, ());
    check(app.clone(), true);
}

/// 更新を確認する。manual はメニューや設定から確認したとき。
pub fn check(app: AppHandle, manual: bool) {
    if !configured(&app) {
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
            set_phase(
                &app,
                Phase::Error {
                    message:
                        "接続先のサーバーの情報をまだ読み込んでいません。少し待ってからお試しください。"
                            .into(),
                },
            );
        }
        return;
    };
    // 止められているときは、画面がそのことを出す。
    if mode == Mode::Off {
        return;
    }
    // 確認・取得・入れ替えの途中なら、重ねて確認しない。
    if current_phase(&app).busy() {
        return;
    }
    set_phase(&app, Phase::Checking);
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
                if mode == Mode::Auto {
                    auto_install(&app, update).await;
                } else {
                    let version = update.version.clone();
                    if let Ok(mut available) = app.state::<UpdaterState>().available.lock() {
                        *available = Some(update);
                    }
                    set_phase(&app, Phase::Available { version });
                }
            }
            Ok(None) => set_phase(
                &app,
                Phase::UpToDate {
                    checked_at: now_ms(),
                },
            ),
            Err(error) => {
                eprintln!("更新を確認できませんでした: {error}");
                set_phase(
                    &app,
                    Phase::Error {
                        message: format!("更新を確認できませんでした ({error})"),
                    },
                );
            }
        }
    });
}

/// 更新を取得する。進み具合を PROGRESS_INTERVAL ごとに画面へ送る。
async fn download(app: &AppHandle, update: &Update) -> tauri_plugin_updater::Result<Vec<u8>> {
    let version = update.version.clone();
    set_phase(
        app,
        Phase::Downloading {
            version: version.clone(),
            downloaded: 0,
            total: None,
        },
    );
    let handle = app.clone();
    let mut downloaded: u64 = 0;
    let mut last = Instant::now();
    update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                if last.elapsed() >= PROGRESS_INTERVAL || total == Some(downloaded) {
                    last = Instant::now();
                    set_phase(
                        &handle,
                        Phase::Downloading {
                            version: version.clone(),
                            downloaded,
                            total,
                        },
                    );
                }
            },
            || {},
        )
        .await
}

/// 確認せずに取得する。macOS と Linux はその場で入れ (次に起動したときに使われる)、
/// Windows は入れるとアプリが終了するので、終了するときまで取っておく。
async fn auto_install(app: &AppHandle, update: Update) {
    {
        let state = app.state::<UpdaterState>();
        let already = state
            .pending
            .lock()
            .ok()
            .and_then(|pending| pending.as_ref().map(|(u, _)| u.version.clone()));
        let installed = state.installed.lock().ok().and_then(|value| value.clone());
        if already.as_deref() == Some(update.version.as_str())
            || installed.as_deref() == Some(update.version.as_str())
        {
            set_phase(app, Phase::Idle);
            return;
        }
    }
    let bytes = match download(app, &update).await {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("更新を取得できませんでした: {error}");
            set_phase(
                app,
                Phase::Error {
                    message: format!("更新を取得できませんでした ({error})"),
                },
            );
            return;
        }
    };
    let state = app.state::<UpdaterState>();
    if cfg!(windows) {
        if let Ok(mut pending) = state.pending.lock() {
            *pending = Some((update, bytes));
        }
        set_phase(app, Phase::Idle);
    } else {
        let version = update.version.clone();
        set_phase(
            app,
            Phase::Installing {
                version: version.clone(),
            },
        );
        match update.install(bytes) {
            Ok(()) => {
                if let Ok(mut installed) = state.installed.lock() {
                    *installed = Some(version);
                }
                set_phase(app, Phase::Idle);
            }
            Err(error) => {
                eprintln!("更新を入れられませんでした: {error}");
                set_phase(
                    app,
                    Phase::Error {
                        message: format!("更新を入れられませんでした ({error})"),
                    },
                );
            }
        }
    }
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

    #[test]
    fn 状態は画面が読める形で送る() {
        let json = |phase: Phase| serde_json::to_value(phase).unwrap();
        assert_eq!(json(Phase::Idle), serde_json::json!({ "kind": "idle" }));
        assert_eq!(
            json(Phase::UpToDate { checked_at: 5 }),
            serde_json::json!({ "kind": "up-to-date", "checkedAt": 5 })
        );
        assert_eq!(
            json(Phase::Downloading {
                version: "1.2.0".into(),
                downloaded: 10,
                total: Some(100)
            }),
            serde_json::json!({
                "kind": "downloading",
                "version": "1.2.0",
                "downloaded": 10,
                "total": 100
            })
        );
        assert!(Phase::Checking.busy());
        assert!(!Phase::Available {
            version: "1.2.0".into()
        }
        .busy());
    }
}
