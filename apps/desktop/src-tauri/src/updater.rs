//! 自動更新。更新の配布元と署名の公開鍵はビルド時の設定 (plugins.updater) で渡す。
//! 設定の無いビルド (開発中、鍵を用意する前) では何もしない。

use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::AppState;

/// 起動してから最初に確認するまでの時間と、その後の間隔。
const FIRST_CHECK: Duration = Duration::from_secs(20);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

fn configured(app: &AppHandle) -> bool {
    app.config().plugins.0.contains_key("updater")
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
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

fn info(app: &AppHandle, message: impl Into<String>) {
    app.dialog()
        .message(message)
        .title("Orbit Mail の更新")
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

/// 更新を確認する。manual はメニューから確認したとき (結果を必ず知らせる)。
pub fn check(app: AppHandle, manual: bool) {
    if !configured(&app) {
        if manual {
            info(&app, "このビルドには自動更新が設定されていません。");
        }
        return;
    }
    tauri::async_runtime::spawn(async move {
        let result = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(error) => Err(error),
        };
        match result {
            Ok(Some(update)) => prompt(&app, update, manual),
            Ok(None) if manual => info(
                &app,
                format!("最新のバージョンです ({})。", app.package_info().version),
            ),
            Err(error) if manual => info(&app, format!("更新を確認できませんでした。\n{error}")),
            _ => {}
        }
    });
}

fn prompt(app: &AppHandle, update: Update, manual: bool) {
    {
        let state = app.state::<AppState>();
        let Ok(mut prompted) = state.prompted_update.lock() else {
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
        .title("Orbit Mail の更新")
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
