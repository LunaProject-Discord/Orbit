// Windows のリリース版で、コンソールのウィンドウを出さない。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mail_desktop_lib::run()
}
