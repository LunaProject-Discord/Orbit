//! 予定の通知 (段取り 9) の、OS の API を使わない部分。
//! 画面から受け取った値の検査、アプリ専用 URL の組み立てと読み取り、Windows のトーストの XML、
//! Windows のトーストの Tag と Id (短い印) を受け持つ。どの OS でもテストできるよう、
//! Windows の API を使う部分は reminders.rs に分けている (toast_xml.rs と同じ流儀)。
// Windows 以外では、一部をテストからだけ使う。
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Url;

use crate::toast_xml::escape;
use crate::APP_URL_SCHEME;

/// 予定の通知の Windows のトーストの Group (apps/web の CALENDAR_TOAST_GROUP と合わせる)。
pub(crate) const CALENDAR_TOAST_GROUP: &str = "calendar";
/// アプリ専用 URL で予定を開くときのホスト (jp.lunaproject.orbit.mail://calendar/events/<id>?o=<回>)。
const CALENDAR_HOST: &str = "calendar";
/// 出欠ボタンの引数の先頭 (後ろに accepted / tentative / declined が付く)。
pub(crate) const RSVP_PREFIX: &str = "rsvp:";
/// 一度に受け付けるリマインダーの数の上限 (画面は 64 件までにする。設計 3.2)。
pub(crate) const MAX_REMINDERS: usize = 64;
/// 題名と本文の長さの上限 (文字数)。画面が切り詰めているはずだが、念のため Rust でも切る。
const MAX_TITLE_CHARS: usize = 200;
const MAX_BODY_CHARS: usize = 400;

/// 出欠のボタン (@orbit/core の RSVP_BUTTONS と同じ並びと文言)。
pub(crate) const RSVP_BUTTONS: [(&str, &str); 3] = [
    ("accepted", "参加"),
    ("tentative", "未定"),
    ("declined", "不参加"),
];

/// 画面から受け取るリマインダー 1 件 (apps/web の ScheduledReminder)。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduledReminder {
    pub tag: String,
    pub fire_at: i64,
    pub expires_at: i64,
    pub title: String,
    pub body: String,
    pub event_id: String,
    pub recurrence_id: Option<String>,
}

/// 画面から受け取る招待・変更の通知 (apps/web の DesktopCalendarNotification)。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalendarNotification {
    pub kind: String,
    pub title: String,
    pub body: String,
    pub tag: String,
    pub event_id: Option<String>,
    pub recurrence_id: Option<String>,
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub rsvp: bool,
}

/// 開く予定 (画面へ送る desktop://open-event の中身)。eventId が null ならカレンダーを開くだけ。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenEventTarget {
    pub event_id: Option<String>,
    pub recurrence_id: Option<String>,
}

/// 予定の ID (UUID) の形かどうか。
pub(crate) fn is_event_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// 回の ID の形かどうか ("2026-10-26T13:00:00Z" か "2026-10-26"。ほかの書き方も少し許す)。
pub(crate) fn is_recurrence_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 40
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '+' | '.'))
}

/// 予定の通知の tag の形かどうか (cal- で始まる、短い、URL や XML に入れても困らない文字だけ)。
pub(crate) fn is_calendar_tag(value: &str) -> bool {
    value.starts_with("cal-")
        && value.len() <= 200
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '+' | '.' | '_'))
}

pub(crate) fn is_rsvp_status(value: &str) -> bool {
    RSVP_BUTTONS.iter().any(|(id, _)| *id == value)
}

fn truncate(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(max - 1).collect();
    cut.push('…');
    cut
}

impl ScheduledReminder {
    /// 形の正しいものだけを通し、長すぎる文言を切る。おかしなものは None (その 1 件だけ捨てる)。
    pub(crate) fn sanitized(mut self) -> Option<Self> {
        if !self.tag.starts_with("cal-rem:")
            || !is_calendar_tag(&self.tag)
            || !is_event_id(&self.event_id)
            || self
                .recurrence_id
                .as_deref()
                .is_some_and(|id| !is_recurrence_id(id))
            || self.fire_at <= 0
            || self.expires_at < self.fire_at
        {
            return None;
        }
        self.title = truncate(&self.title, MAX_TITLE_CHARS);
        self.body = truncate(&self.body, MAX_BODY_CHARS);
        Some(self)
    }

    pub(crate) fn target(&self) -> OpenEventTarget {
        OpenEventTarget {
            event_id: Some(self.event_id.clone()),
            recurrence_id: self.recurrence_id.clone(),
        }
    }

    /// 内容の印。同じ tag で時刻や文言が変わったら別の値になる (Windows の予約の突き合わせに使う)。
    pub(crate) fn content_key(&self) -> String {
        short_hash(&format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.tag,
            self.fire_at,
            self.expires_at,
            self.title,
            self.body,
            self.event_id,
            self.recurrence_id.as_deref().unwrap_or("-")
        ))
    }
}

impl CalendarNotification {
    pub(crate) fn sanitized(mut self) -> Option<Self> {
        if !is_calendar_tag(&self.tag)
            || !self.kind.starts_with("event-")
            || self.kind.len() > 40
            || self.event_id.as_deref().is_some_and(|id| !is_event_id(id))
            || self
                .recurrence_id
                .as_deref()
                .is_some_and(|id| !is_recurrence_id(id))
        {
            return None;
        }
        if self.event_id.is_none() {
            // まとめた通知などは、開く予定が無いので出欠のボタンも付けない。
            self.recurrence_id = None;
            self.rsvp = false;
        }
        self.title = truncate(&self.title, MAX_TITLE_CHARS);
        self.body = truncate(&self.body, MAX_BODY_CHARS);
        Some(self)
    }

    pub(crate) fn target(&self) -> OpenEventTarget {
        OpenEventTarget {
            event_id: self.event_id.clone(),
            recurrence_id: self.recurrence_id.clone(),
        }
    }
}

/// Windows のトーストの Tag と Id に使う短い印 (16 文字の 16 進)。
/// tag は 64 文字を超えることがあり (cal-rem:<UUID>:<回>:<分>)、Windows の Tag の上限に収まらないため、
/// ハッシュにして長さをそろえる。同じ tag は必ず同じ印になるので、置き換えはそのまま効く。
pub(crate) fn short_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// tag から Windows のトーストの Tag を作る。
pub(crate) fn toast_tag(tag: &str) -> String {
    short_hash(tag)
}

/// URL の問い合わせ (?o=) に入れられるようにする。
fn encode_query_value(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// 予定を開くアプリ専用 URL。event_id が無ければカレンダーを開くだけの URL。
pub(crate) fn event_url(target: &OpenEventTarget) -> String {
    let Some(event_id) = &target.event_id else {
        return format!("{APP_URL_SCHEME}://{CALENDAR_HOST}");
    };
    let mut url = format!("{APP_URL_SCHEME}://{CALENDAR_HOST}/events/{event_id}");
    if let Some(recurrence_id) = &target.recurrence_id {
        url.push_str("?o=");
        url.push_str(&encode_query_value(recurrence_id));
    }
    url
}

/// アプリ専用 URL が予定を開くものなら、開く予定を読む。予定の URL でなければ None
/// (ログインからの戻りなど。今までどおり desktop://app-url で画面へ渡す)。
/// 外から誰でも開ける URL なので、形の違う ID は受け付けない (カレンダーを開くだけにする)。
pub(crate) fn parse_event_url(url: &Url) -> Option<OpenEventTarget> {
    if url.scheme() != APP_URL_SCHEME || url.host_str() != Some(CALENDAR_HOST) {
        return None;
    }
    let mut segments = url
        .path_segments()
        .map(|segments| segments.filter(|s| !s.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter();
    let event_id = match (segments.next(), segments.next(), segments.next()) {
        (Some("events"), Some(id), None) if is_event_id(id) => Some(id.to_ascii_lowercase()),
        _ => None,
    };
    let recurrence_id = event_id.as_ref().and_then(|_| {
        url.query_pairs()
            .find(|(key, _)| key == "o")
            .map(|(_, value)| value.into_owned())
            .filter(|value| is_recurrence_id(value))
    });
    Some(OpenEventTarget {
        event_id,
        recurrence_id,
    })
}

/// リマインダーのトーストの XML。押すとアプリ専用 URL (protocol) でアプリを開く。
/// アプリが終了していても OS が URL でアプリを起動するので、予約したトーストにも使える
/// (メールのトーストの Activated の受け口は、プロセスが無いと受け取れない)。
pub(crate) fn reminder_toast_xml(reminder: &ScheduledReminder) -> String {
    let url = event_url(&reminder.target());
    let mut xml = format!(
        "<toast launch=\"{}\" activationType=\"protocol\" scenario=\"reminder\"><visual><binding template=\"ToastGeneric\"><text>{}</text>",
        escape(&url),
        escape(&reminder.title)
    );
    if !reminder.body.is_empty() {
        xml.push_str(&format!("<text>{}</text>", escape(&reminder.body)));
    }
    xml.push_str("</binding></visual>");
    // scenario="reminder" は、ボタンが 1 つ以上ないと普通のトーストとして扱われる。
    // 「閉じる」(dismiss) を置き、利用者が閉じるまで画面に残す。
    xml.push_str(
        "<actions><action activationType=\"system\" arguments=\"dismiss\" content=\"\"/></actions>",
    );
    xml.push_str("</toast>");
    xml
}

/// 招待・変更・取り消しのトーストの XML。
/// 通知そのものを押したときはアプリ専用 URL (protocol) で予定を開く (通知センターから押しても届く)。
/// rsvp が true なら 参加 / 未定 / 不参加 のボタンを付ける。ボタンはトーストの受け口 (Activated) で受け、
/// 画面へ desktop://calendar-action で渡す (メールのボタンと同じく、通知センターに移ったあとは届かないことがある)。
pub(crate) fn calendar_toast_xml(notification: &CalendarNotification) -> String {
    let url = event_url(&notification.target());
    let mut xml = format!(
        "<toast launch=\"{}\" activationType=\"protocol\"><visual><binding template=\"ToastGeneric\"><text>{}</text>",
        escape(&url),
        escape(&notification.title)
    );
    if !notification.body.is_empty() {
        xml.push_str(&format!("<text>{}</text>", escape(&notification.body)));
    }
    xml.push_str("</binding></visual>");
    if notification.rsvp && notification.event_id.is_some() {
        xml.push_str("<actions>");
        for (id, title) in RSVP_BUTTONS {
            xml.push_str(&format!(
                "<action content=\"{title}\" arguments=\"{RSVP_PREFIX}{id}\" activationType=\"foreground\"/>"
            ));
        }
        xml.push_str("</actions>");
    }
    xml.push_str("</toast>");
    xml
}

/// epoch ms を Windows の DateTime (1601-01-01 からの 100 ナノ秒) にする。
pub(crate) fn windows_ticks(epoch_ms: i64) -> i64 {
    const EPOCH_DIFFERENCE_MS: i64 = 11_644_473_600_000;
    epoch_ms
        .saturating_add(EPOCH_DIFFERENCE_MS)
        .saturating_mul(10_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "019aa0c2-7b3e-7c11-9d2f-0123456789ab";

    fn reminder() -> ScheduledReminder {
        ScheduledReminder {
            tag: format!("cal-rem:{ID}:2026-11-28T01:00:00Z:10"),
            fire_at: 1_764_290_400_000,
            expires_at: 1_764_295_200_000,
            title: "定例会議".into(),
            body: "10:00〜11:00 · 会議室 A".into(),
            event_id: ID.into(),
            recurrence_id: Some("2026-11-28T01:00:00Z".into()),
        }
    }

    #[test]
    fn 予定の_url_を組み立てて読み戻せる() {
        let target = reminder().target();
        let url = event_url(&target);
        assert_eq!(
            url,
            format!("jp.lunaproject.orbit.mail://calendar/events/{ID}?o=2026-11-28T01%3A00%3A00Z")
        );
        assert_eq!(parse_event_url(&Url::parse(&url).unwrap()), Some(target));

        let all_day = OpenEventTarget {
            event_id: Some(ID.into()),
            recurrence_id: Some("2026-11-28".into()),
        };
        assert_eq!(
            parse_event_url(&Url::parse(&event_url(&all_day)).unwrap()),
            Some(all_day)
        );
        let plain = OpenEventTarget {
            event_id: Some(ID.into()),
            recurrence_id: None,
        };
        assert_eq!(
            parse_event_url(&Url::parse(&event_url(&plain)).unwrap()),
            Some(plain)
        );
    }

    #[test]
    fn 予定でない_url_とおかしな_id_は受け付けない() {
        let parse = |value: &str| parse_event_url(&Url::parse(value).unwrap());
        // ログインからの戻りは、予定の URL ではない。
        assert_eq!(parse("jp.lunaproject.orbit.mail://oauth?code=x"), None);
        assert_eq!(parse(&format!("https://calendar/events/{ID}")), None);
        // カレンダーを開くだけ。
        let none = Some(OpenEventTarget {
            event_id: None,
            recurrence_id: None,
        });
        assert_eq!(parse("jp.lunaproject.orbit.mail://calendar"), none);
        assert_eq!(
            parse("jp.lunaproject.orbit.mail://calendar/events/../../x"),
            none
        );
        assert_eq!(
            parse("jp.lunaproject.orbit.mail://calendar/events/not-a-uuid?o=1"),
            none
        );
        assert_eq!(
            parse(&format!(
                "jp.lunaproject.orbit.mail://calendar/events/{ID}/x"
            )),
            none
        );
        // 回の ID がおかしければ、予定だけを開く。
        assert_eq!(
            parse(&format!(
                "jp.lunaproject.orbit.mail://calendar/events/{ID}?o=%3Cscript%3E"
            )),
            Some(OpenEventTarget {
                event_id: Some(ID.into()),
                recurrence_id: None,
            })
        );
    }

    #[test]
    fn リマインダーの_xml() {
        let xml = reminder_toast_xml(&reminder());
        assert_eq!(
            xml,
            format!(
                "<toast launch=\"jp.lunaproject.orbit.mail://calendar/events/{ID}?o=2026-11-28T01%3A00%3A00Z\" \
                 activationType=\"protocol\" scenario=\"reminder\"><visual><binding template=\"ToastGeneric\">\
                 <text>定例会議</text><text>10:00〜11:00 · 会議室 A</text></binding></visual>\
                 <actions><action activationType=\"system\" arguments=\"dismiss\" content=\"\"/></actions></toast>"
            )
        );
    }

    #[test]
    fn 文言はエスケープし_空の本文は出さない() {
        let mut item = reminder();
        item.title = "A & <B> \"c\"\u{1}".into();
        item.body = String::new();
        let xml = reminder_toast_xml(&item);
        assert!(xml.contains("<text>A &amp; &lt;B&gt; &quot;c&quot;</text></binding>"));
        assert!(!xml.contains("<text></text>"));
    }

    fn invite(rsvp: bool, event_id: Option<&str>) -> CalendarNotification {
        CalendarNotification {
            kind: "event-invite".into(),
            title: "招待: 定例会議".into(),
            body: "山田 太郎 さんから".into(),
            tag: format!("cal-inv:{ID}"),
            event_id: event_id.map(str::to_owned),
            recurrence_id: None,
            expires_at: None,
            rsvp,
        }
    }

    #[test]
    fn 招待の_xml_は出欠のボタンを付ける() {
        let xml = calendar_toast_xml(&invite(true, Some(ID)));
        assert!(xml.starts_with(&format!(
            "<toast launch=\"jp.lunaproject.orbit.mail://calendar/events/{ID}\" activationType=\"protocol\">"
        )));
        assert!(xml.contains(
            "<actions><action content=\"参加\" arguments=\"rsvp:accepted\" activationType=\"foreground\"/>\
             <action content=\"未定\" arguments=\"rsvp:tentative\" activationType=\"foreground\"/>\
             <action content=\"不参加\" arguments=\"rsvp:declined\" activationType=\"foreground\"/></actions>"
        ));
        assert!(!calendar_toast_xml(&invite(false, Some(ID))).contains("<actions>"));
    }

    #[test]
    fn まとめた通知はカレンダーを開き_ボタンを付けない() {
        let mut notification = invite(true, None);
        notification.tag = format!("cal-inv-batch:{ID}:{ID}");
        let notification = notification.sanitized().unwrap();
        assert!(!notification.rsvp);
        let xml = calendar_toast_xml(&notification);
        assert!(xml.starts_with(
            "<toast launch=\"jp.lunaproject.orbit.mail://calendar\" activationType=\"protocol\">"
        ));
        assert!(!xml.contains("<actions>"));
    }

    #[test]
    fn 受け取った値を確かめる() {
        assert_eq!(reminder().sanitized(), Some(reminder()));
        let broken = [
            ScheduledReminder {
                tag: format!("cal-inv:{ID}"),
                ..reminder()
            },
            ScheduledReminder {
                tag: "cal-rem:<x>".into(),
                ..reminder()
            },
            ScheduledReminder {
                event_id: "../x".into(),
                ..reminder()
            },
            ScheduledReminder {
                recurrence_id: Some("a b".into()),
                ..reminder()
            },
            ScheduledReminder {
                expires_at: 1,
                ..reminder()
            },
        ];
        for item in broken {
            assert_eq!(item.sanitized(), None);
        }
        let long = ScheduledReminder {
            title: "あ".repeat(500),
            ..reminder()
        }
        .sanitized()
        .unwrap();
        assert_eq!(long.title.chars().count(), MAX_TITLE_CHARS);
        assert!(long.title.ends_with('…'));

        assert!(invite(true, Some("x")).sanitized().is_none());
        let mut mail = invite(false, Some(ID));
        mail.tag = "mail:x".into();
        assert!(mail.sanitized().is_none());
    }

    #[test]
    fn 印は短く_同じ値なら同じ() {
        let tag = reminder().tag;
        assert!(tag.len() > 64);
        assert_eq!(toast_tag(&tag).len(), 16);
        assert_eq!(toast_tag(&tag), toast_tag(&tag.clone()));
        assert_ne!(toast_tag(&tag), toast_tag(&format!("{tag}0")));

        let moved = ScheduledReminder {
            fire_at: reminder().fire_at + 60_000,
            ..reminder()
        };
        assert_ne!(moved.content_key(), reminder().content_key());
        assert_eq!(reminder().content_key(), reminder().content_key());
    }

    #[test]
    fn windows_の時刻() {
        assert_eq!(windows_ticks(0), 116_444_736_000_000_000);
        assert_eq!(windows_ticks(1), 116_444_736_000_010_000);
    }

    #[test]
    fn 画面から届く_json_を読める() {
        let item: ScheduledReminder = serde_json::from_str(&format!(
            r#"{{"tag":"cal-rem:{ID}:-:10","fireAt":1764290400000,"expiresAt":1764295200000,
               "title":"t","body":"b","eventId":"{ID}","recurrenceId":null}}"#
        ))
        .unwrap();
        assert_eq!(item.recurrence_id, None);
        let notification: CalendarNotification = serde_json::from_str(&format!(
            r#"{{"kind":"event-cancel","title":"t","body":"b","tag":"cal-upd:{ID}",
               "eventId":"{ID}","recurrenceId":null,"expiresAt":null,"rsvp":false}}"#
        ))
        .unwrap();
        assert_eq!(notification.kind, "event-cancel");
    }
}
