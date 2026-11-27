//! 予定の通知 (段取り 9、設計 3.2・3.3・3.5)。
//!
//! - リマインダー: 画面 (ReminderAgent) が計算した「これから 7 日の全部の一覧」を schedule_reminders で
//!   受け取り、OS に予約する。差分はここで取る。
//!   - Windows: OS の予約トースト (ScheduledToastNotification)。アプリを終了していても鳴る見込み
//!     (実機で確かめる。出なければ、環境変数 ORBIT_REMINDER_TIMER=1 か WINDOWS_SCHEDULED_TOASTS で
//!     下のタイマー方式に落とせる。予約に失敗したときも自動でタイマー方式に切り替える)。
//!   - macOS / Linux: このプロセスの中のタイマー。アプリを終了すると鳴らない。
//!     画面 (WebView) のタイマーに頼らないのは、隠れた WebView のタイマーが間引かれるおそれがあるため。
//! - 招待・変更・取り消し: 画面が SSE で受けたものを notify_calendar で出す。
//!   Windows は招待に 参加 / 未定 / 不参加 のボタンを付け、押されたら desktop://calendar-action を画面へ送る。
//! - 通知を押したら、launch::open_event でカレンダーを開き、desktop://open-event を画面へ送る。
//!   Windows のトーストは、押すとアプリ専用 URL (jp.lunaproject.orbit.mail://calendar/events/<id>) で開く
//!   (アプリが終了していても URL でアプリが起動する。lib.rs の deep-link の受け口を通る)。
//!
//! どのコマンドも、メインウィンドウから呼ばれたものだけを扱う (メールの通知と同じ決まり)。

use std::collections::{HashMap, HashSet};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::reminder_xml::{CalendarNotification, ScheduledReminder, MAX_REMINDERS};
use crate::MAIN_WINDOW;

/// 時刻を確かめる間隔の上限。スリープ明けでも、この間隔のうちに気付く。
const TICK: Duration = Duration::from_secs(30);
/// 鳴らす時刻をこれより過ぎて見つけたものは鳴らさない (設計 2.1 の 15 分の決まり)。
const LATE_MS: i64 = 15 * 60 * 1000;
/// Windows で OS に予約するのは、これより先のものだけ (間際のものはタイマーで出す)。
#[cfg_attr(not(windows), allow(dead_code))]
const SCHEDULE_LEAD_MS: i64 = 5_000;
/// Windows で OS の予約トーストを使うか。実機で出ないと分かったら false にする (タイマー方式になる)。
#[cfg(windows)]
const WINDOWS_SCHEDULED_TOASTS: bool = true;

/// 画面へ返す予約の能力 (apps/web の ReminderCapabilities)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ReminderCapabilities {
    schedule: &'static str,
    exact: bool,
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 鳴らしたかどうかを覚える印 (同じ tag でも時刻が動けば別の通知として鳴らす)。
fn fire_key(reminder: &ScheduledReminder) -> String {
    format!("{}@{}", reminder.tag, reminder.fire_at)
}

/// 画面から受け取った一覧を整える: 形のおかしなものを捨て、tag の重複を除き、早い順に 64 件まで。
pub(crate) fn normalize(items: Vec<ScheduledReminder>) -> Vec<ScheduledReminder> {
    let mut seen = HashSet::new();
    let mut items: Vec<ScheduledReminder> = items
        .into_iter()
        .filter_map(ScheduledReminder::sanitized)
        .filter(|item| seen.insert(item.tag.clone()))
        .collect();
    items.sort_by_key(|item| item.fire_at);
    items.truncate(MAX_REMINDERS);
    items
}

/// タイマー方式の中身。OS の API を使わないので、どの OS でもテストできる。
#[derive(Default, Debug)]
pub(crate) struct Timer {
    /// まだ鳴らしていないリマインダー。
    items: Vec<ScheduledReminder>,
    /// 鳴らした (または OS に預けた) もの。fire_key → 予定の終了。一覧を組み直しても二度鳴らさないため。
    fired: HashMap<String, i64>,
}

impl Timer {
    /// 一覧を入れ替える。鳴らしたものは入れない。
    pub(crate) fn replace(&mut self, items: Vec<ScheduledReminder>) {
        self.items = items
            .into_iter()
            .filter(|item| !self.fired.contains_key(&fire_key(item)))
            .collect();
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    /// OS に預けた (予約した) ものとして覚える。あとで時刻を過ぎて一覧に残っていても、タイマーでは鳴らさない。
    pub(crate) fn mark_fired(&mut self, item: &ScheduledReminder) {
        self.fired.insert(fire_key(item), item.expires_at);
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) fn was_fired(&self, item: &ScheduledReminder) -> bool {
        self.fired.contains_key(&fire_key(item))
    }

    pub(crate) fn clear(&mut self) {
        self.items.clear();
        self.fired.clear();
    }

    /// 時刻の来たものを取り出す。遅れすぎたもの・終わった予定のものは鳴らさずに捨てる。
    pub(crate) fn take_due(&mut self, now: i64) -> Vec<ScheduledReminder> {
        self.fired
            .retain(|_, expires_at| *expires_at > now - LATE_MS);
        let mut due = Vec::new();
        let mut rest = Vec::new();
        for item in std::mem::take(&mut self.items) {
            if item.fire_at > now {
                rest.push(item);
                continue;
            }
            if now - item.fire_at <= LATE_MS && now < item.expires_at {
                self.fired.insert(fire_key(&item), item.expires_at);
                due.push(item);
            }
        }
        self.items = rest;
        due
    }

    /// 次に確かめるまで待つ時間 (次の時刻か TICK の短いほう)。
    pub(crate) fn next_wait(&self, now: i64) -> Duration {
        self.items
            .iter()
            .map(|item| item.fire_at)
            .min()
            .map(|next| Duration::from_millis((next - now).max(0) as u64).min(TICK))
            .unwrap_or(TICK)
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
/// Windows の予約トースト 1 件の印 (Tag と Id。どちらも reminder_xml::short_hash の 16 文字)。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ScheduledEntry {
    pub tag: String,
    pub id: String,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl ScheduledEntry {
    pub(crate) fn of(item: &ScheduledReminder) -> Self {
        ScheduledEntry {
            tag: crate::reminder_xml::toast_tag(&item.tag),
            id: item.content_key(),
        }
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
/// Windows の予約の突き合わせの結果。
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct SchedulePlan {
    /// 予約から外すもの (existing の添字。一覧から消えた、内容が変わった、重複)。
    pub remove: Vec<usize>,
    /// 新しく予約するもの。
    pub add: Vec<ScheduledReminder>,
    /// 時刻が間際か過ぎていて、OS に予約できないもの (タイマーで出す候補)。
    pub due: Vec<ScheduledReminder>,
}

#[cfg_attr(not(windows), allow(dead_code))]
/// 今ある予約 (existing) と、受け取った一覧を突き合わせる。増減だけを反映するため。
pub(crate) fn plan_schedule(
    items: &[ScheduledReminder],
    existing: &[ScheduledEntry],
    now: i64,
) -> SchedulePlan {
    let mut plan = SchedulePlan::default();
    let mut wanted: HashMap<ScheduledEntry, &ScheduledReminder> = HashMap::new();
    for item in items {
        if item.fire_at <= now + SCHEDULE_LEAD_MS {
            plan.due.push(item.clone());
        } else {
            wanted.insert(ScheduledEntry::of(item), item);
        }
    }
    let mut kept = HashSet::new();
    for (index, entry) in existing.iter().enumerate() {
        if wanted.contains_key(entry) && kept.insert(entry.clone()) {
            continue;
        }
        plan.remove.push(index);
    }
    plan.add = items
        .iter()
        .filter(|item| {
            let entry = ScheduledEntry::of(item);
            wanted.contains_key(&entry) && !kept.contains(&entry)
        })
        .cloned()
        .collect();
    plan
}

/// アプリの状態に置く、リマインダーの状態。
#[derive(Default)]
pub(crate) struct Reminders {
    timer: Mutex<Timer>,
    wake: Condvar,
    /// Windows で予約トーストが使えず、タイマー方式に切り替えた。
    #[cfg(windows)]
    use_timer: std::sync::atomic::AtomicBool,
}

impl Reminders {
    pub(crate) fn new() -> Self {
        let reminders = Reminders::default();
        #[cfg(windows)]
        {
            let forced = std::env::var("ORBIT_REMINDER_TIMER").is_ok_and(|value| value == "1");
            reminders.use_timer.store(
                forced || !WINDOWS_SCHEDULED_TOASTS,
                std::sync::atomic::Ordering::SeqCst,
            );
        }
        reminders
    }

    fn capabilities(&self) -> ReminderCapabilities {
        #[cfg(windows)]
        if !self.use_timer.load(std::sync::atomic::Ordering::SeqCst) {
            return ReminderCapabilities {
                schedule: "os",
                exact: true,
            };
        }
        ReminderCapabilities {
            schedule: "process",
            exact: true,
        }
    }

    fn with_timer<T>(&self, f: impl FnOnce(&mut Timer) -> T) -> T {
        let mut timer = self.timer.lock().unwrap_or_else(|e| e.into_inner());
        let result = f(&mut timer);
        self.wake.notify_all();
        result
    }
}

/// タイマーを動かす (アプリの起動時に 1 度)。
pub(crate) fn start(app: &AppHandle) {
    app.manage(Reminders::new());
    let handle = app.clone();
    std::thread::Builder::new()
        .name("orbit-reminders".into())
        .spawn(move || loop {
            let reminders = handle.state::<Reminders>();
            let due = {
                let mut timer = reminders.timer.lock().unwrap_or_else(|e| e.into_inner());
                let now = now_ms();
                let due = timer.take_due(now);
                if due.is_empty() {
                    let wait = timer.next_wait(now);
                    let _ = reminders.wake.wait_timeout(timer, wait);
                }
                due
            };
            for item in due {
                show_reminder(&handle, &item);
            }
        })
        .expect("リマインダーのタイマーを動かせませんでした");
}

/// 時刻の来たリマインダーを、いま出す (タイマー方式)。
fn show_reminder(app: &AppHandle, item: &ScheduledReminder) {
    #[cfg(windows)]
    {
        let _ = windows_toast::show_reminder_now(app, item);
    }
    #[cfg(not(windows))]
    {
        let _ = show_plugin_notification(app, &item.tag, &item.title, &item.body, &item.target());
    }
}

/// macOS / Linux の通知 (通知のプラグイン)。押されたら lib.rs の on_action が予定を開く。
#[cfg(not(windows))]
fn show_plugin_notification(
    app: &AppHandle,
    tag: &str,
    title: &str,
    body: &str,
    target: &crate::reminder_xml::OpenEventTarget,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    // 同じ tag の通知は同じ番号にする (番号での置き換えに対応している OS では置き換わる)。
    let digest = crate::reminder_xml::short_hash(tag);
    let id = i32::from_str_radix(&digest[..7], 16).unwrap_or(1);
    let mut builder = app
        .notification()
        .builder()
        .id(id)
        .title(title)
        .body(body)
        .extra(CALENDAR_EXTRA, true);
    if let Some(event_id) = &target.event_id {
        builder = builder.extra("eventId", event_id.clone());
    }
    if let Some(recurrence_id) = &target.recurrence_id {
        builder = builder.extra("recurrenceId", recurrence_id.clone());
    }
    builder.show().map_err(|error| error.to_string())
}

/// macOS / Linux の通知のプラグインに付ける、予定の通知の印 (lib.rs の on_action が見分ける)。
pub(crate) const CALENDAR_EXTRA: &str = "orbitCalendar";

/// プラグインの通知の追加の値から、開く予定を読む。予定の通知でなければ None。
pub(crate) fn target_from_extra(
    extra: &HashMap<String, serde_json::Value>,
) -> Option<crate::reminder_xml::OpenEventTarget> {
    use crate::reminder_xml::{is_event_id, is_recurrence_id, OpenEventTarget};
    extra.get(CALENDAR_EXTRA)?;
    let event_id = extra
        .get("eventId")
        .and_then(|value| value.as_str())
        .filter(|id| is_event_id(id))
        .map(str::to_owned);
    let recurrence_id = event_id.as_ref().and_then(|_| {
        extra
            .get("recurrenceId")
            .and_then(|value| value.as_str())
            .filter(|id| is_recurrence_id(id))
            .map(str::to_owned)
    });
    Some(OpenEventTarget {
        event_id,
        recurrence_id,
    })
}

/// 予約の能力を返す。
#[tauri::command]
pub(crate) fn reminder_capabilities(app: AppHandle) -> ReminderCapabilities {
    app.state::<Reminders>().capabilities()
}

/// リマインダーの全部の一覧を受け取り、予約を入れ替える。
#[tauri::command]
pub(crate) fn schedule_reminders(
    app: AppHandle,
    window: WebviewWindow,
    items: Vec<ScheduledReminder>,
) -> Result<(), String> {
    if window.label() != MAIN_WINDOW {
        return Ok(());
    }
    let items = normalize(items);
    let reminders = app.state::<Reminders>();
    #[cfg(windows)]
    if !reminders
        .use_timer
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        match windows_toast::schedule(&app, &reminders, &items) {
            Ok(()) => return Ok(()),
            Err(_) => {
                // 予約トーストが使えない (OS が受け付けない)。以後はタイマー方式にする。
                reminders
                    .use_timer
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                let _ = windows_toast::clear_scheduled(&app);
            }
        }
    }
    reminders.with_timer(|timer| timer.replace(items));
    Ok(())
}

/// すべての予約と、出ている予定の通知を消す (ログアウト・利用者の切り替え)。
/// 前の利用者の予定が次の利用者に出ないよう、どのウィンドウからでも受け付ける。
#[tauri::command]
pub(crate) fn clear_reminders(app: AppHandle) -> Result<(), String> {
    app.state::<Reminders>().with_timer(Timer::clear);
    #[cfg(windows)]
    {
        windows_toast::clear_scheduled(&app).map_err(|error| error.to_string())?;
        windows_toast::clear_shown(&app).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 招待・変更・取り消しの通知を出す。
#[tauri::command]
pub(crate) fn notify_calendar(
    app: AppHandle,
    window: WebviewWindow,
    notification: CalendarNotification,
) -> Result<(), String> {
    if window.label() != MAIN_WINDOW {
        return Ok(());
    }
    let Some(notification) = notification.sanitized() else {
        return Err("予定の通知の形が違います。".into());
    };
    #[cfg(windows)]
    {
        windows_toast::show_calendar(&app, notification).map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        // macOS と Linux は、押すと予定を開くだけ (出欠のボタンは Windows のみ)。
        show_plugin_notification(
            &app,
            &notification.tag,
            &notification.title,
            &notification.body,
            &notification.target(),
        )
    }
}

#[cfg(windows)]
mod windows_toast {
    //! Windows のトースト (予約とその場の表示)。
    use serde::Serialize;
    use tauri::{AppHandle, Emitter};
    use windows::core::{Interface, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::{DateTime, IReference, PropertyValue, TypedEventHandler};
    use windows::UI::Notifications::{
        ScheduledToastNotification, ToastActivatedEventArgs, ToastNotification,
        ToastNotificationManager, ToastNotifier,
    };

    use super::{now_ms, plan_schedule, Reminders, ScheduledEntry};
    use crate::reminder_xml::{
        calendar_toast_xml, is_rsvp_status, reminder_toast_xml, toast_tag, windows_ticks,
        CalendarNotification, ScheduledReminder, CALENDAR_TOAST_GROUP, RSVP_PREFIX,
    };
    use crate::toast::app_id;
    use crate::MAIN_WINDOW;

    /// 出欠のボタンが押されたときに画面へ送るイベント (apps/web の DESKTOP_CALENDAR_EVENTS.calendarAction)。
    const CALENDAR_ACTION_EVENT: &str = "desktop://calendar-action";

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CalendarAction {
        event_id: String,
        status: String,
    }

    fn notifier(app: &AppHandle) -> windows::core::Result<ToastNotifier> {
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id(app)))
    }

    fn document(xml: &str) -> windows::core::Result<XmlDocument> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(xml))?;
        Ok(doc)
    }

    fn date_time(epoch_ms: i64) -> DateTime {
        DateTime {
            UniversalTime: windows_ticks(epoch_ms),
        }
    }

    fn date_time_reference(epoch_ms: i64) -> windows::core::Result<IReference<DateTime>> {
        PropertyValue::CreateDateTime(date_time(epoch_ms))?.cast()
    }

    /// 予約トーストのうち、予定の通知のもの。
    fn scheduled(
        notifier: &ToastNotifier,
    ) -> windows::core::Result<Vec<ScheduledToastNotification>> {
        let group = HSTRING::from(CALENDAR_TOAST_GROUP);
        Ok(notifier
            .GetScheduledToastNotifications()?
            .into_iter()
            .filter(|toast| toast.Group().is_ok_and(|g| g == group))
            .collect())
    }

    /// 通知センターに出ている予定の通知の Tag。
    fn shown_tags(app: &AppHandle) -> windows::core::Result<std::collections::HashSet<String>> {
        let group = HSTRING::from(CALENDAR_TOAST_GROUP);
        Ok(ToastNotificationManager::History()?
            .GetHistoryWithId(&HSTRING::from(app_id(app)))?
            .into_iter()
            .filter(|toast| toast.Group().is_ok_and(|g| g == group))
            .filter_map(|toast| toast.Tag().ok().map(|tag| tag.to_string()))
            .collect())
    }

    /// 予約を、受け取った一覧に合わせる (増減だけ反映する)。
    pub(super) fn schedule(
        app: &AppHandle,
        reminders: &Reminders,
        items: &[ScheduledReminder],
    ) -> windows::core::Result<()> {
        let notifier = notifier(app)?;
        let existing = scheduled(&notifier)?;
        let entries: Vec<ScheduledEntry> = existing
            .iter()
            .map(|toast| ScheduledEntry {
                tag: toast.Tag().map(|t| t.to_string()).unwrap_or_default(),
                id: toast.Id().map(|t| t.to_string()).unwrap_or_default(),
            })
            .collect();
        let now = now_ms();
        let plan = plan_schedule(items, &entries, now);
        for index in &plan.remove {
            notifier.RemoveFromSchedule(&existing[*index])?;
        }
        for item in &plan.add {
            let toast = ScheduledToastNotification::CreateScheduledToastNotification(
                &document(&reminder_toast_xml(item))?,
                date_time(item.fire_at),
            )?;
            let entry = ScheduledEntry::of(item);
            toast.SetTag(&HSTRING::from(entry.tag))?;
            toast.SetGroup(&HSTRING::from(CALENDAR_TOAST_GROUP))?;
            toast.SetId(&HSTRING::from(entry.id))?;
            // 予定が終わったら通知センターから消える。
            toast.SetExpirationTime(&date_time_reference(item.expires_at)?)?;
            notifier.AddToSchedule(&toast)?;
        }
        // OS に預けたものは、時刻を過ぎたあとに一覧へ残っていてもタイマーでは出さない。
        // 間際・過ぎたもので、まだ出ていないものだけをタイマーに渡す (起動し直したあとは、
        // 通知センターに同じ Tag があれば OS が出したものとみなす)。
        let shown = shown_tags(app).unwrap_or_default();
        reminders.with_timer(|timer| {
            for item in &plan.add {
                timer.mark_fired(item);
            }
            let due: Vec<ScheduledReminder> = plan
                .due
                .iter()
                .filter(|item| !timer.was_fired(item) && !shown.contains(&toast_tag(&item.tag)))
                .cloned()
                .collect();
            timer.replace(due);
        });
        Ok(())
    }

    /// 予定の通知の予約をすべて外す。
    pub(super) fn clear_scheduled(app: &AppHandle) -> windows::core::Result<()> {
        let notifier = notifier(app)?;
        for toast in scheduled(&notifier)? {
            notifier.RemoveFromSchedule(&toast)?;
        }
        Ok(())
    }

    /// 通知センターに出ている予定の通知をすべて消す。
    pub(super) fn clear_shown(app: &AppHandle) -> windows::core::Result<()> {
        ToastNotificationManager::History()?.RemoveGroupWithId(
            &HSTRING::from(CALENDAR_TOAST_GROUP),
            &HSTRING::from(app_id(app)),
        )
    }

    fn show(
        app: &AppHandle,
        toast: &ToastNotification,
        tag: &str,
        expires_at: Option<i64>,
    ) -> windows::core::Result<()> {
        toast.SetTag(&HSTRING::from(toast_tag(tag)))?;
        toast.SetGroup(&HSTRING::from(CALENDAR_TOAST_GROUP))?;
        if let Some(expires_at) = expires_at.filter(|at| *at > now_ms()) {
            toast.SetExpirationTime(&date_time_reference(expires_at)?)?;
        }
        notifier(app)?.Show(toast)
    }

    /// リマインダーを、いま出す (タイマー方式と、間際のもの)。
    pub(super) fn show_reminder_now(
        app: &AppHandle,
        item: &ScheduledReminder,
    ) -> windows::core::Result<()> {
        let toast =
            ToastNotification::CreateToastNotification(&document(&reminder_toast_xml(item))?)?;
        show(app, &toast, &item.tag, Some(item.expires_at))
    }

    /// 招待・変更・取り消しのトーストを出す。
    pub(super) fn show_calendar(
        app: &AppHandle,
        notification: CalendarNotification,
    ) -> windows::core::Result<()> {
        if notification.kind == "event-cancel" {
            // 取り消しは、同じ予定の招待の通知も消す (設計 4.3)。
            if let Some(event_id) = &notification.event_id {
                let _ = ToastNotificationManager::History()?.RemoveGroupedTagWithId(
                    &HSTRING::from(toast_tag(&format!("cal-inv:{event_id}"))),
                    &HSTRING::from(CALENDAR_TOAST_GROUP),
                    &HSTRING::from(app_id(app)),
                );
            }
        }
        let toast = ToastNotification::CreateToastNotification(&document(&calendar_toast_xml(
            &notification,
        ))?)?;
        if let (true, Some(event_id)) = (notification.rsvp, notification.event_id.clone()) {
            let handle = app.clone();
            toast.Activated(&TypedEventHandler::<
                ToastNotification,
                windows::core::IInspectable,
            >::new(move |_, args| {
                let arguments = args
                    .as_ref()
                    .and_then(|args| args.cast::<ToastActivatedEventArgs>().ok())
                    .and_then(|args| args.Arguments().ok())
                    .map(|value| value.to_string())
                    .unwrap_or_default();
                if let Some(status) = arguments
                    .strip_prefix(RSVP_PREFIX)
                    .filter(|status| is_rsvp_status(status))
                {
                    // ウィンドウを出さずに画面へ渡す。画面が既存の経路 (client.respond) で返事をする。
                    let _ = handle.emit_to(
                        MAIN_WINDOW,
                        CALENDAR_ACTION_EVENT,
                        CalendarAction {
                            event_id: event_id.clone(),
                            status: status.to_owned(),
                        },
                    );
                }
                Ok(())
            }))?;
        }
        show(app, &toast, &notification.tag, notification.expires_at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "019aa0c2-7b3e-7c11-9d2f-0123456789ab";
    const NOW: i64 = 1_764_290_400_000;
    const MINUTE: i64 = 60_000;

    fn item(name: &str, fire_at: i64) -> ScheduledReminder {
        ScheduledReminder {
            tag: format!("cal-rem:{ID}:{name}:10"),
            fire_at,
            expires_at: fire_at + 70 * MINUTE,
            title: name.into(),
            body: String::new(),
            event_id: ID.into(),
            recurrence_id: None,
        }
    }

    #[test]
    fn 一覧を整える() {
        let items = normalize(vec![
            item("b", NOW + 2 * MINUTE),
            item("a", NOW + MINUTE),
            item("b", NOW + 3 * MINUTE),
            ScheduledReminder {
                event_id: "x".into(),
                ..item("c", NOW)
            },
        ]);
        let names: Vec<_> = items.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(names, ["a", "b"]);
        let many: Vec<_> = (0..100)
            .map(|n| item(&n.to_string(), NOW + n * MINUTE))
            .collect();
        assert_eq!(normalize(many).len(), MAX_REMINDERS);
    }

    #[test]
    fn 時刻の来たものだけを一度だけ鳴らす() {
        let mut timer = Timer::default();
        timer.replace(vec![item("a", NOW), item("b", NOW + 5 * MINUTE)]);
        assert!(timer.take_due(NOW - 1).is_empty());
        let due = timer.take_due(NOW);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].title, "a");
        // 画面が同じ一覧で組み直しても、鳴らしたものは鳴らさない。
        timer.replace(vec![item("a", NOW), item("b", NOW + 5 * MINUTE)]);
        assert!(timer.take_due(NOW + MINUTE).is_empty());
        assert_eq!(timer.take_due(NOW + 5 * MINUTE)[0].title, "b");
        // 時刻が動けば、別の通知として鳴らす。
        timer.replace(vec![item("a", NOW + 10 * MINUTE)]);
        assert_eq!(timer.take_due(NOW + 10 * MINUTE).len(), 1);
    }

    #[test]
    fn 遅れすぎたものと終わった予定は鳴らさない() {
        let mut timer = Timer::default();
        let mut ended = item("ended", NOW - MINUTE);
        ended.expires_at = NOW;
        timer.replace(vec![
            item("late", NOW - 16 * MINUTE),
            item("ok", NOW - 14 * MINUTE),
            ended,
        ]);
        let due = timer.take_due(NOW);
        let names: Vec<_> = due.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(names, ["ok"]);
        assert!(timer.take_due(NOW + MINUTE).is_empty());
    }

    #[test]
    fn 次に確かめるまでの時間() {
        let mut timer = Timer::default();
        assert_eq!(timer.next_wait(NOW), TICK);
        timer.replace(vec![item("a", NOW + 1_000)]);
        assert_eq!(timer.next_wait(NOW), Duration::from_millis(1_000));
        timer.replace(vec![item("a", NOW + 10 * MINUTE)]);
        assert_eq!(timer.next_wait(NOW), TICK);
    }

    #[test]
    fn 消すと覚えていたものも忘れる() {
        let mut timer = Timer::default();
        timer.replace(vec![item("a", NOW)]);
        assert_eq!(timer.take_due(NOW).len(), 1);
        timer.clear();
        timer.replace(vec![item("a", NOW)]);
        assert_eq!(timer.take_due(NOW).len(), 1);
    }

    #[test]
    fn 予約の突き合わせは増減だけ() {
        let keep = item("keep", NOW + 10 * MINUTE);
        let moved_before = item("moved", NOW + 20 * MINUTE);
        let moved_after = item("moved", NOW + 25 * MINUTE);
        let gone = item("gone", NOW + 30 * MINUTE);
        let new = item("new", NOW + 40 * MINUTE);
        let soon = item("soon", NOW + 1_000);
        let existing = vec![
            ScheduledEntry::of(&keep),
            ScheduledEntry::of(&keep),
            ScheduledEntry::of(&moved_before),
            ScheduledEntry::of(&gone),
        ];
        let plan = plan_schedule(
            &[keep.clone(), moved_after.clone(), new.clone(), soon.clone()],
            &existing,
            NOW,
        );
        // 重複した 2 つめ、内容の変わったもの、一覧から消えたもの。
        assert_eq!(plan.remove, vec![1, 2, 3]);
        assert_eq!(plan.add, vec![moved_after, new]);
        assert_eq!(plan.due, vec![soon]);
    }

    #[test]
    fn 同じ一覧をもう一度渡しても何もしない() {
        let items = vec![item("a", NOW + MINUTE * 10), item("b", NOW + MINUTE * 20)];
        let existing: Vec<_> = items.iter().map(ScheduledEntry::of).collect();
        assert_eq!(
            plan_schedule(&items, &existing, NOW),
            SchedulePlan::default()
        );
    }

    #[test]
    fn プラグインの通知から予定を読む() {
        let mut extra = HashMap::new();
        extra.insert("messageId".to_owned(), serde_json::json!(ID));
        assert_eq!(target_from_extra(&extra), None);
        extra.insert(CALENDAR_EXTRA.to_owned(), serde_json::json!(true));
        extra.insert("eventId".to_owned(), serde_json::json!(ID));
        extra.insert("recurrenceId".to_owned(), serde_json::json!("2026-11-28"));
        let target = target_from_extra(&extra).unwrap();
        assert_eq!(target.event_id.as_deref(), Some(ID));
        assert_eq!(target.recurrence_id.as_deref(), Some("2026-11-28"));
        extra.insert("eventId".to_owned(), serde_json::json!("../x"));
        assert_eq!(target_from_extra(&extra).unwrap().event_id, None);
    }
}
