//! Windows の新着メールの通知 (トースト) の中身。XML の組み立てだけを受け持つ
//! (どの OS でもテストできるよう、Windows の API を使う部分は toast.rs に分けている)。
// Windows 以外では、テストからだけ使う。
#![cfg_attr(not(windows), allow(dead_code))]

/// 返信欄の入力の ID。
pub(crate) const REPLY_INPUT: &str = "reply";
/// 通知そのものを押したときの引数。
pub(crate) const TAP: &str = "tap";
/// ボタンの引数の先頭 (後ろにボタンの ID が付く)。
pub(crate) const ACTION_PREFIX: &str = "action:";
/// 返信の「送信」ボタンの引数。
pub(crate) const SEND_REPLY: &str = "reply";
/// Windows のトーストに並べられるボタンの数の上限 (返信の送信ボタンも含む)。
pub(crate) const MAX_TOAST_ACTIONS: usize = 5;

/// 通知に付けるボタン 1 つ。画面が利用者の設定から渡す。
#[derive(Clone, Debug, serde::Deserialize)]
pub(crate) struct ToastButton {
    pub id: String,
    pub title: String,
}

/// ボタンの ID として受け付けるもの (画面の設定で選べるボタン。apps/web の lib/notification-actions.ts)。
pub(crate) fn is_button_id(id: &str) -> bool {
    matches!(id, "read" | "star" | "archive" | "delete" | "junk")
}

/// XML の文字列・属性に入れられるようにする。
fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            // XML に入れられない制御文字は落とす (改行とタブは残す)。
            c if (c as u32) < 0x20 && !matches!(c, '\n' | '\r' | '\t') => {}
            c => escaped.push(c),
        }
    }
    escaped
}

/// トーストの XML。message_id があるときだけ、ボタンと返信欄を付ける。
/// send_icon (送信ボタンの絵の file:/// の URL) があれば、送信ボタンを絵にして入力欄の右側に置く。
/// 無ければ、ほかのボタンと同じ列に「送信」の文字で置く。
pub(crate) fn toast_xml(
    title: &str,
    body: &str,
    message_id: Option<&str>,
    buttons: &[ToastButton],
    reply: bool,
    send_icon: Option<&str>,
) -> String {
    let mut xml = format!(
        "<toast launch=\"{TAP}\" activationType=\"foreground\"><visual><binding template=\"ToastGeneric\"><text>{}</text>",
        escape(title)
    );
    if !body.is_empty() {
        xml.push_str(&format!("<text>{}</text>", escape(body)));
    }
    xml.push_str("</binding></visual>");
    if message_id.is_some() {
        let mut actions = String::new();
        let mut count = 0;
        if reply {
            actions.push_str(&format!(
                "<input id=\"{REPLY_INPUT}\" type=\"text\" placeHolderContent=\"返信を入力\"/>"
            ));
            // hint-inputId を付けたボタンは、入力欄の右側に並ぶ (絵が要る)。
            let beside = send_icon
                .map(|icon| {
                    format!(
                        " hint-inputId=\"{REPLY_INPUT}\" imageUri=\"{}\"",
                        escape(icon)
                    )
                })
                .unwrap_or_default();
            actions.push_str(&format!(
                "<action content=\"送信\" arguments=\"{SEND_REPLY}\" activationType=\"foreground\"{beside}/>"
            ));
            count += 1;
        }
        for button in buttons {
            if count >= MAX_TOAST_ACTIONS {
                break;
            }
            if !is_button_id(&button.id) || button.title.trim().is_empty() {
                continue;
            }
            actions.push_str(&format!(
                "<action content=\"{}\" arguments=\"{ACTION_PREFIX}{}\" activationType=\"foreground\"/>",
                escape(button.title.trim()),
                button.id
            ));
            count += 1;
        }
        if !actions.is_empty() {
            xml.push_str("<actions>");
            xml.push_str(&actions);
            xml.push_str("</actions>");
        }
    }
    xml.push_str("</toast>");
    xml
}

#[cfg(test)]
mod tests {
    use super::*;

    fn button(id: &str, title: &str) -> ToastButton {
        ToastButton {
            id: id.to_owned(),
            title: title.to_owned(),
        }
    }

    #[test]
    fn 返信欄と選んだボタンを並べる() {
        let xml = toast_xml(
            "山田",
            "打ち合わせ",
            Some("01a1fcb1-b4bb-71cc-9452-cd6f31df8724"),
            &[
                button("read", "既読にする"),
                button("archive", "アーカイブ"),
            ],
            true,
            None,
        );
        assert_eq!(
            xml,
            "<toast launch=\"tap\" activationType=\"foreground\"><visual><binding template=\"ToastGeneric\">\
             <text>山田</text><text>打ち合わせ</text></binding></visual><actions>\
             <input id=\"reply\" type=\"text\" placeHolderContent=\"返信を入力\"/>\
             <action content=\"送信\" arguments=\"reply\" activationType=\"foreground\"/>\
             <action content=\"既読にする\" arguments=\"action:read\" activationType=\"foreground\"/>\
             <action content=\"アーカイブ\" arguments=\"action:archive\" activationType=\"foreground\"/>\
             </actions></toast>"
        );
    }

    #[test]
    fn メールの決まっていない通知にはボタンを付けない() {
        let xml = toast_xml(
            "新着メール 5 件",
            "",
            None,
            &[button("read", "既読にする")],
            true,
            None,
        );
        assert!(!xml.contains("<actions>"));
        assert!(!xml.contains("<text></text>"));
    }

    #[test]
    fn 知らないボタンは付けず_文字はエスケープする() {
        let xml = toast_xml(
            "A & <B>",
            "\"x\"\u{1}",
            Some("01a1fcb1-b4bb-71cc-9452-cd6f31df8724"),
            &[
                button("evil\" onclick=\"", "x"),
                button("star", "スター <付ける>"),
            ],
            false,
            None,
        );
        assert!(xml.contains("<text>A &amp; &lt;B&gt;</text><text>&quot;x&quot;</text>"));
        assert!(!xml.contains("evil"));
        assert!(!xml.contains("<input"));
        assert!(xml.contains("content=\"スター &lt;付ける&gt;\" arguments=\"action:star\""));
    }

    #[test]
    fn ボタンは上限まで() {
        let many: Vec<ToastButton> = ["read", "star", "archive", "delete", "junk", "read"]
            .iter()
            .map(|id| button(id, id))
            .collect();
        let xml = toast_xml(
            "t",
            "b",
            Some("01a1fcb1-b4bb-71cc-9452-cd6f31df8724"),
            &many,
            true,
            None,
        );
        assert_eq!(xml.matches("<action ").count(), MAX_TOAST_ACTIONS);
    }

    #[test]
    fn 送信ボタンの絵があれば入力欄の右側に置く() {
        let xml = toast_xml(
            "t",
            "b",
            Some("01a1fcb1-b4bb-71cc-9452-cd6f31df8724"),
            &[button("read", "既読にする")],
            true,
            Some("file:///C:/Users/a&b/AppData/send.png"),
        );
        assert!(xml.contains(
            "<action content=\"送信\" arguments=\"reply\" activationType=\"foreground\" \
             hint-inputId=\"reply\" imageUri=\"file:///C:/Users/a&amp;b/AppData/send.png\"/>"
        ));
        // ほかのボタンは、入力欄の下の列に並ぶ。
        assert!(xml.contains(
            "<action content=\"既読にする\" arguments=\"action:read\" activationType=\"foreground\"/>"
        ));
    }
}
