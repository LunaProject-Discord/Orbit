//! タイトルバーを右クリックしたときに出す、OS のシステムメニュー
//! (元のサイズに戻す・移動・サイズ変更・最小化・最大化・閉じる)。
//!
//! Windows では、OS の枠を外していてもウィンドウにはシステムメニューが残っている (tao が WS_SYSMENU を付ける)。
//! 自前のタイトルバーは画面 (WebView) の中にあるので OS は右クリックに気づかない。
//! そこで画面から呼んでもらい、OS のメニューをそのまま出して、選ばれた操作を OS に渡す。
//! 文言は OS の言語のまま出る。macOS と Linux には同じものが無いので、画面側で扱う。

use tauri::WebviewWindow;

/// システムメニューを出す。x / y はウィンドウの中の位置 (物理ピクセル)。無ければカーソルの位置に出す。
#[tauri::command]
pub fn show_system_menu(window: WebviewWindow, x: Option<f64>, y: Option<f64>) -> Result<(), String> {
    show(&window, x.zip(y)).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn show(window: &WebviewWindow, at: Option<(f64, f64)>) -> tauri::Result<()> {
    // HWND はスレッドをまたいで渡せないので、数値にして渡す。
    let raw = window.hwnd()?.0 as isize;
    let resizable = window.is_resizable().unwrap_or(true);
    let maximizable = window.is_maximizable().unwrap_or(true);
    let minimizable = window.is_minimizable().unwrap_or(true);
    let closable = window.is_closable().unwrap_or(true);
    // メニューは、ウィンドウを作ったスレッド (メインスレッド) で出す必要がある。
    window.run_on_main_thread(move || unsafe {
        use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
        use windows::Win32::Graphics::Gdi::ClientToScreen;
        use windows::Win32::UI::WindowsAndMessaging::{
            EnableMenuItem, GetCursorPos, GetSystemMenu, IsIconic, IsZoomed, PostMessageW,
            SetForegroundWindow, SetMenuDefaultItem, TrackPopupMenu, MENU_ITEM_FLAGS,
            MF_BYCOMMAND, MF_ENABLED, MF_GRAYED, SC_CLOSE, SC_MAXIMIZE, SC_MINIMIZE, SC_MOVE,
            SC_RESTORE, SC_SIZE, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_SYSCOMMAND,
        };

        let hwnd = HWND(raw as *mut core::ffi::c_void);
        let menu = GetSystemMenu(hwnd, false);
        if menu.is_invalid() {
            return;
        }
        // いまの状態に合わせて、押せない項目を灰色にする (OS の枠があるときと同じ並び)。
        let zoomed = IsZoomed(hwnd).as_bool();
        let iconic = IsIconic(hwnd).as_bool();
        let normal = !zoomed && !iconic;
        let set = |id: u32, enabled: bool| {
            let state: MENU_ITEM_FLAGS = if enabled { MF_ENABLED } else { MF_GRAYED };
            let _ = EnableMenuItem(menu, id, MF_BYCOMMAND | state);
        };
        set(SC_RESTORE, !normal);
        set(SC_MOVE, normal);
        set(SC_SIZE, normal && resizable);
        set(SC_MINIMIZE, !iconic && minimizable);
        set(SC_MAXIMIZE, !zoomed && maximizable);
        set(SC_CLOSE, closable);
        // 太字の項目 (ダブルクリックで選ばれるもの) は、OS の枠と同じく「閉じる」。
        let _ = SetMenuDefaultItem(menu, SC_CLOSE, 0);

        let mut point = POINT::default();
        match at {
            Some((x, y)) => {
                point.x = x.round() as i32;
                point.y = y.round() as i32;
                let _ = ClientToScreen(hwnd, &mut point);
            }
            None => {
                if GetCursorPos(&mut point).is_err() {
                    return;
                }
            }
        }
        // 前面に出しておかないと、メニューの外を押しても閉じない。
        let _ = SetForegroundWindow(hwnd);
        let command = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            point.x,
            point.y,
            Some(0),
            hwnd,
            None,
        );
        if command.0 > 0 {
            // OS の枠のメニューで選んだときと同じように、ウィンドウに伝える
            // (「閉じる」はウィンドウを閉じる操作として届くので、通知領域へ入る設定も効く)。
            let _ = PostMessageW(
                Some(hwnd),
                WM_SYSCOMMAND,
                WPARAM(command.0 as usize),
                LPARAM(0),
            );
        }
    })
}

#[cfg(not(windows))]
fn show(_window: &WebviewWindow, _at: Option<(f64, f64)>) -> tauri::Result<()> {
    Ok(())
}
