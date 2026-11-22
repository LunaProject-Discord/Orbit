//! 未読数の表示。トレイのアイコンとツールチップ、タスクバー (Dock) のバッジに出す。

use tauri::image::Image;
use tauri::{AppHandle, Manager};

use crate::{tray, MAIN_WINDOW};

const DOT: [u8; 4] = [0xef, 0x44, 0x44, 0xff];

/// (cx, cy) を中心とする半径 r の円を、RGBA の画像に塗る。
fn paint_dot(rgba: &mut [u8], width: u32, height: u32, cx: f32, cy: f32, r: f32) {
    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            if dx * dx + dy * dy <= r * r {
                let index = ((y * width + x) * 4) as usize;
                rgba[index..index + 4].copy_from_slice(&DOT);
            }
        }
    }
}

/// アイコンの右上に、未読があることを示す赤い丸を重ねる。
pub fn with_dot(icon: &Image<'_>) -> Image<'static> {
    let (width, height) = (icon.width(), icon.height());
    let mut rgba = icon.rgba().to_vec();
    let r = width.min(height) as f32 * 0.24;
    paint_dot(&mut rgba, width, height, width as f32 - r, r, r);
    Image::new_owned(rgba, width, height)
}

/// タスクバーのアイコンに重ねる赤い丸 (Windows)。
#[cfg(windows)]
fn overlay_dot() -> Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    let half = SIZE as f32 / 2.0;
    paint_dot(&mut rgba, SIZE, SIZE, half, half, half - 4.0);
    Image::new_owned(rgba, SIZE, SIZE)
}

pub fn tooltip(count: u32) -> String {
    if count == 0 {
        "Orbit Mail".to_owned()
    } else {
        format!("Orbit Mail (未読 {count} 件)")
    }
}

pub fn apply(app: &AppHandle, count: u32) {
    tray::show_unread(app, count);
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    // Windows はタスクバーに数を出せないので、赤い丸を重ねる。
    #[cfg(windows)]
    let _ = window.set_overlay_icon(if count > 0 { Some(overlay_dot()) } else { None });
    #[cfg(not(windows))]
    let _ = window.set_badge_count(if count > 0 {
        Some(i64::from(count))
    } else {
        None
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_is_painted_in_the_top_right_corner() {
        let source = Image::new_owned(vec![0u8; 32 * 32 * 4], 32, 32);
        let dotted = with_dot(&source);
        let pixel = |x: u32, y: u32| {
            let index = ((y * 32 + x) * 4) as usize;
            dotted.rgba()[index..index + 4].to_vec()
        };
        assert_eq!(pixel(24, 7), DOT.to_vec());
        assert_eq!(pixel(4, 28), vec![0, 0, 0, 0]);
    }

    #[test]
    fn tooltip_shows_the_unread_count() {
        assert_eq!(tooltip(0), "Orbit Mail");
        assert_eq!(tooltip(3), "Orbit Mail (未読 3 件)");
    }
}
