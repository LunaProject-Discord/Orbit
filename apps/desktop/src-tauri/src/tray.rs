//! 通知領域 (トレイ、macOS ではメニューバー) のアイコンとメニュー。

use std::sync::atomic::Ordering;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::{badge, quit, settings, show_main_window, updater, AppState};

const TRAY_ID: &str = "main";

/// メニューバー用の白黒のアイコン (macOS が明暗に合わせて色を付ける)。
#[cfg(target_os = "macos")]
fn base_icon(_app: &AppHandle) -> Option<Image<'static>> {
    Image::from_bytes(include_bytes!("../icons/tray-template.png")).ok()
}

#[cfg(not(target_os = "macos"))]
fn base_icon(app: &AppHandle) -> Option<Image<'static>> {
    app.default_window_icon()
        .map(|icon| icon.clone().to_owned())
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let close_to_tray = state
        .settings
        .lock()
        .map(|s| s.close_to_tray)
        .unwrap_or(true);

    let open = MenuItem::with_id(app, "open", "Orbit Mail を開く", true, None::<&str>)?;
    let keep = CheckMenuItem::with_id(
        app,
        "close_to_tray",
        "ウィンドウを閉じても通知を受け取る",
        true,
        close_to_tray,
        None::<&str>,
    )?;
    let update = MenuItem::with_id(app, "update", "更新を確認…", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Orbit Mail を終了", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &keep,
            &update,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(badge::tooltip(0))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "close_to_tray" => {
                let state = app.state::<AppState>();
                let Ok(mut current) = state.settings.lock() else {
                    return;
                };
                current.close_to_tray = keep.is_checked().unwrap_or(!current.close_to_tray);
                settings::save(app, &current);
            }
            "update" => updater::check(app.clone(), true),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = base_icon(app) {
        builder = builder
            .icon(icon)
            .icon_as_template(cfg!(target_os = "macos"));
    }
    builder.build(app)?;

    show_unread(app, state.unread.load(Ordering::SeqCst));
    Ok(())
}

/// トレイのアイコンに未読の有無を出す。
pub fn show_unread(app: &AppHandle, count: u32) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let _ = tray.set_tooltip(Some(badge::tooltip(count)));

    // macOS はメニューバーのアイコンの横に数を出す (アイコンは白黒のまま)。
    #[cfg(target_os = "macos")]
    let _ = tray.set_title((count > 0).then(|| count.to_string()));

    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = base_icon(app) {
        let _ = tray.set_icon(Some(if count > 0 {
            badge::with_dot(&icon)
        } else {
            icon
        }));
    }
}
