package jp.lunaproject.orbit.mail;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.util.Map;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 予定の通知 (段取り 9) を組み立てて出す。リマインダー (端末の予約と FCM) と、
 * 招待・変更・取り消し (FCM) の両方をここで出す。
 *
 * 決まり (設計 3.3・3.4・7・9 章):
 *   - 通知は tag で見分け、番号はすべて同じ (MailNotifications と同じ)。同じ tag は置き換わる。
 *   - リマインダーの tag (cal-rem:…) は、端末の予約でも FCM でも同じ値になる。
 *     この 24 時間に出した tag は、鳴らす時刻 (予約) と予定の終了 (FCM) と一緒に覚えておき、
 *     後から来た同じもの (同じ tag で同じ時刻) は出さない (消した通知が出直さない)。
 *     tag は鳴らす時刻を含まないので、予定の時刻が動いたものは別の通知として出す (レビュー H1)。
 *   - 文言は画面 (TypeScript) かサーバーが作る。ここは表示するだけ (出欠の失敗の知らせを除く)。
 *   - 分類は 2 つ: 予定のリマインダー (重要度 高) と、招待と予定の変更 (重要度 標準)。
 *     ロック画面では中身を隠す (新着メールの通知と同じ)。
 */
final class CalendarNotifications {

    /** 通知は tag で見分けるので、番号はすべて同じにする (MailNotifications と同じ)。 */
    static final int NOTIFICATION_ID = 0;
    /** 分類の ID。@orbit/core/calendar-notifications の CALENDAR_CHANNEL_* と合わせる。 */
    static final String CHANNEL_REMINDERS = "calendar-reminders";
    static final String CHANNEL_INVITES = "calendar-invites";
    /** 予定の通知の tag の先頭 (isCalendarTag)。リマインダーは cal-rem:、招待は cal-inv:。 */
    static final String CALENDAR_TAG_PREFIX = "cal-";
    static final String REMINDER_TAG_PREFIX = "cal-rem:";
    static final String INVITE_TAG_PREFIX = "cal-inv:";

    /** 段取り 10 の Calendar アプリ。これが入っていれば、Mail アプリは予定の通知を譲る (設計 3.4)。 */
    static final String CALENDAR_APP_PACKAGE = "jp.lunaproject.orbit.calendar";

    /** 予定を開く URL (画面の lib/native/reminders.ts の nativeEventRoute が読む)。 */
    private static final String EVENT_URL_PATH = "calendar/events/";
    /** 予定の ID の形 (UUID)。ほかの形は URL に入れない (設計 7.5)。 */
    private static final Pattern UUID_PATTERN = Pattern.compile(
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    );
    /** 回の ID (recurrenceId) の長さの上限。ISO 8601 の日時か日付なので、これで足りる。 */
    private static final int MAX_RECURRENCE_ID_LENGTH = 64;

    /** 出した tag を覚えておく期間 (設計 3.3)。 */
    static final long SHOWN_TTL_MS = 24L * 60 * 60 * 1000;
    private static final String SHOWN_PREFERENCES = "orbit_calendar_shown";

    private CalendarNotifications() {}

    // -----------------------------------------------------------------------
    // 出す
    // -----------------------------------------------------------------------

    /** 端末が予約したリマインダーを出す (ReminderReceiver から)。 */
    static void showReminder(Context context, ReminderScheduler.Item item) {
        long now = System.currentTimeMillis();
        NotificationCompat.Builder builder = base(context, CHANNEL_REMINDERS, item.tag, item.eventId, item.recurrenceId)
            .setCategory(NotificationCompat.CATEGORY_EVENT)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentTitle(item.title)
            .setContentText(item.body)
            .setWhen(item.fireAt)
            .setShowWhen(true);
        if (!item.body.isEmpty()) builder.setStyle(new NotificationCompat.BigTextStyle().bigText(item.body));
        if (item.expiresAt > now) builder.setTimeoutAfter(item.expiresAt - now);
        post(context, item.tag, builder);
        rememberShown(context, item.tag, item.fireAt, item.expiresAt, now);
    }

    /**
     * サーバーから FCM で届いた予定の通知を出す。data は @orbit/core の toCalendarFcmData の形:
     * kind、title、body、tag、eventId (まとめた通知では空)、recurrenceId?、expiresAt?、calendarId?、
     * channel、rsvpUrl?、rsvpToken? (招待の出欠ボタン)。
     */
    static void showPush(Context context, Map<String, String> data) {
        // ログインしていなければ出さない (401 のあとに FCM の登録を外せなかったとき、
        // 前の利用者の予定が出ないようにする。レビュー L8)。
        if (!SharedConfig.load(context).usable()) return;
        String kind = orEmpty(data.get("kind"));
        String title = orEmpty(data.get("title"));
        String body = orEmpty(data.get("body"));
        String tag = orEmpty(data.get("tag"));
        if (title.isEmpty() || !tag.startsWith(CALENDAR_TAG_PREFIX)) return;
        String eventId = validEventId(data.get("eventId"));
        String recurrenceId = validRecurrenceId(data.get("recurrenceId"));
        long now = System.currentTimeMillis();
        long expiresAt = parseLong(data.get("expiresAt"));
        // 鳴らす時刻 (新しいサーバーだけが送る。無ければ 0)。
        long fireAt = parseLong(data.get("fireAt"));
        // 予定がもう終わっていれば出さない (電源を入れ直した端末に、昨日の通知を出さない)。
        if (expiresAt > 0 && expiresAt <= now) return;

        boolean reminder = "event-reminder".equals(kind) || tag.startsWith(REMINDER_TAG_PREFIX);
        if (reminder) {
            // 端末の予約で既に出した (消した) 通知は、出し直さない。鳴らす時刻 (fireAt) が届けばそれで、
            // 古いサーバーで無ければ予定の終了 (expiresAt) で同じ通知かを比べる。
            if (wasPushShown(context, tag, fireAt, expiresAt, now)) {
                ReminderScheduler.cancelOne(context, tag);
                return;
            }
            // FCM が先に来たら、同じ tag の予約は取り消す (設計 3.3)。
            ReminderScheduler.cancelOne(context, tag);
        }
        // 取り消しは、招待の通知も消す (招待のボタンが残らないようにする)。
        if ("event-cancel".equals(kind) && eventId != null) cancel(context, INVITE_TAG_PREFIX + eventId);

        String channel = reminder ? CHANNEL_REMINDERS : CHANNEL_INVITES;
        NotificationCompat.Builder builder = base(context, channel, tag, eventId, recurrenceId)
            .setCategory(NotificationCompat.CATEGORY_EVENT)
            .setPriority(reminder ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
            .setContentTitle(title)
            .setContentText(body);
        if (!body.isEmpty()) builder.setStyle(new NotificationCompat.BigTextStyle().bigText(body));
        if (expiresAt > now) builder.setTimeoutAfter(expiresAt - now);

        String rsvpUrl = data.get("rsvpUrl");
        String rsvpToken = data.get("rsvpToken");
        // 出欠の送り先が自分の API の受け口でなければ、ボタンを付けない (レビュー M4)。
        if (
            "event-invite".equals(kind) &&
            eventId != null &&
            EventActionReceiver.allowedUrl(context, rsvpUrl) &&
            notEmpty(rsvpToken)
        ) {
            addRsvpActions(context, builder, tag, eventId, recurrenceId, rsvpUrl, rsvpToken, title);
        }
        post(context, tag, builder);
        if (reminder) rememberShown(context, tag, fireAt, expiresAt, now);
    }

    /** 出欠をサーバーへ反映できなかったことを知らせる。押すと、その予定を開く (設計 2.4・9 章)。 */
    static void showRsvpFailure(Context context, String tag, String eventId, String recurrenceId, String title) {
        NotificationCompat.Builder builder = base(context, CHANNEL_INVITES, tag, eventId, recurrenceId)
            .setCategory(NotificationCompat.CATEGORY_EVENT)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentTitle(context.getString(R.string.calendar_rsvp_failed))
            .setContentText(orEmpty(title));
        post(context, tag, builder);
    }

    /** 招待の通知に 参加 / 未定 / 不参加 を付ける (RSVP_BUTTONS と同じ順と値)。 */
    private static void addRsvpActions(
        Context context,
        NotificationCompat.Builder builder,
        String tag,
        String eventId,
        String recurrenceId,
        String url,
        String token,
        String title
    ) {
        String[] statuses = { "accepted", "tentative", "declined" };
        int[] labels = { R.string.calendar_rsvp_accepted, R.string.calendar_rsvp_tentative, R.string.calendar_rsvp_declined };
        for (int index = 0; index < statuses.length; index++) {
            Intent intent = new Intent(context, EventActionReceiver.class);
            intent.setAction(EventActionReceiver.ACTION);
            intent.putExtra(EventActionReceiver.EXTRA_TAG, tag);
            intent.putExtra(EventActionReceiver.EXTRA_EVENT_ID, eventId);
            intent.putExtra(EventActionReceiver.EXTRA_RECURRENCE_ID, recurrenceId);
            intent.putExtra(EventActionReceiver.EXTRA_STATUS, statuses[index]);
            intent.putExtra(EventActionReceiver.EXTRA_URL, url);
            intent.putExtra(EventActionReceiver.EXTRA_TOKEN, token);
            intent.putExtra(EventActionReceiver.EXTRA_TITLE, title);
            PendingIntent pending = PendingIntent.getBroadcast(
                context,
                (tag + ":" + statuses[index]).hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            builder.addAction(
                new NotificationCompat.Action.Builder(0, context.getString(labels[index]), pending)
                    .setShowsUserInterface(false)
                    .build()
            );
        }
    }

    private static NotificationCompat.Builder base(
        Context context,
        String channel,
        String tag,
        String eventId,
        String recurrenceId
    ) {
        ensureChannels(context);
        PendingIntent content = PendingIntent.getActivity(
            context,
            tag.hashCode(),
            openIntent(context, eventId, recurrenceId),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_mail)
            .setColor(ContextCompat.getColor(context, R.color.brand))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(content);
    }

    /**
     * 通知を押したときに、アプリを開いて予定を表示する Intent。
     * アプリ専用の URL (jp.lunaproject.orbit.mail://calendar/events/<id>?o=<回>) を VIEW で渡すと、
     * Capacitor の App プラグインが画面へ appUrlOpen (起動中) か getLaunchUrl (起動時) で伝える。
     * 宛先は明示した MainActivity なので、マニフェストに calendar の受け口は足さない
     * (ほかのアプリからこの URL で開かれることはない)。予定が分からない通知はカレンダーを開く。
     */
    static Intent openIntent(Context context, String eventId, String recurrenceId) {
        Intent open = new Intent(Intent.ACTION_VIEW, eventUri(context, eventId, recurrenceId), context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return open;
    }

    static Uri eventUri(Context context, String eventId, String recurrenceId) {
        String scheme = context.getString(R.string.custom_url_scheme);
        String id = validEventId(eventId);
        if (id == null) return Uri.parse(scheme + "://calendar");
        Uri.Builder uri = Uri.parse(scheme + "://" + EVENT_URL_PATH + id).buildUpon();
        String occurrence = validRecurrenceId(recurrenceId);
        if (occurrence != null) uri.appendQueryParameter("o", occurrence);
        return uri.build();
    }

    // -----------------------------------------------------------------------
    // 消す
    // -----------------------------------------------------------------------

    static void cancel(Context context, String tag) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(tag, NOTIFICATION_ID);
    }

    /** 出ている予定の通知をすべて消し、出した tag の記録も消す (ログアウト・利用者の切り替え)。 */
    static void cancelAll(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            for (StatusBarNotification active : manager.getActiveNotifications()) {
                String tag = active.getTag();
                if (tag != null && tag.startsWith(CALENDAR_TAG_PREFIX)) manager.cancel(tag, active.getId());
            }
        }
        shown(context).edit().clear().apply();
    }

    // -----------------------------------------------------------------------
    // 出した tag の記録 (設計 3.3)
    // -----------------------------------------------------------------------

    /**
     * 出した記録 1 件。値は "出した時刻|鳴らす時刻|予定の終了" (鳴らす時刻は FCM で出したとき 0 = 不明)。
     * 前の版の記録 (出した時刻だけの Long) は、tag だけで同じものとみなす。
     */
    static final class Shown {

        final long shownAt;
        final long fireAt;
        final long expiresAt;
        final boolean legacy;

        Shown(long shownAt, long fireAt, long expiresAt, boolean legacy) {
            this.shownAt = shownAt;
            this.fireAt = fireAt;
            this.expiresAt = expiresAt;
            this.legacy = legacy;
        }

        static Shown parse(Object value) {
            if (value instanceof Long) return new Shown((Long) value, 0, 0, true);
            if (!(value instanceof String)) return null;
            String[] parts = ((String) value).split("\\|");
            if (parts.length != 3) return null;
            try {
                return new Shown(Long.parseLong(parts[0]), Long.parseLong(parts[1]), Long.parseLong(parts[2]), false);
            } catch (NumberFormatException e) {
                return null;
            }
        }

        String format() {
            return shownAt + "|" + fireAt + "|" + expiresAt;
        }

        boolean fresh(long now) {
            return shownAt > 0 && now - shownAt < SHOWN_TTL_MS;
        }

        /** 端末の予約 (鳴らす時刻と予定の終了が分かる) が、この記録と同じ通知か。 */
        boolean matchesScheduled(long otherFireAt, long otherExpiresAt) {
            if (legacy) return true;
            if (fireAt > 0) return fireAt == otherFireAt;
            // FCM で出した記録 (鳴らす時刻が不明) は、予定の終了で比べる。
            return expiresAt == otherExpiresAt;
        }

        /** FCM が、この記録と同じ通知か。鳴らす時刻が両方で分かればそれで、無ければ予定の終了で比べる。 */
        boolean matchesPush(long otherFireAt, long otherExpiresAt) {
            if (legacy) return true;
            if (fireAt > 0 && otherFireAt > 0) return fireAt == otherFireAt;
            return expiresAt == otherExpiresAt;
        }
    }

    private static Shown shownRecord(Context context, String tag, long now) {
        Shown record = Shown.parse(shown(context).getAll().get(tag));
        return record != null && record.fresh(now) ? record : null;
    }

    /** 端末の予約したリマインダーを、もう出したか (同じ tag で同じ時刻)。 */
    static boolean wasShownRecently(Context context, ReminderScheduler.Item item, long now) {
        Shown record = shownRecord(context, item.tag, now);
        return record != null && record.matchesScheduled(item.fireAt, item.expiresAt);
    }

    /** FCM で届いたリマインダーを、もう出したか (同じ tag で同じ鳴らす時刻、無ければ同じ予定の終了)。 */
    static boolean wasPushShown(Context context, String tag, long fireAt, long expiresAt, long now) {
        Shown record = shownRecord(context, tag, now);
        return record != null && record.matchesPush(fireAt, expiresAt);
    }

    private static void rememberShown(Context context, String tag, long fireAt, long expiresAt, long now) {
        SharedPreferences preferences = shown(context);
        SharedPreferences.Editor editor = preferences.edit();
        // 24 時間を過ぎた記録と読めない記録は捨てる (増え続けないようにする)。
        for (Map.Entry<String, ?> entry : preferences.getAll().entrySet()) {
            Shown record = Shown.parse(entry.getValue());
            if (record == null || !record.fresh(now)) editor.remove(entry.getKey());
        }
        editor.putString(tag, new Shown(now, fireAt, expiresAt, false).format()).apply();
    }

    private static SharedPreferences shown(Context context) {
        return context.getSharedPreferences(SHOWN_PREFERENCES, Context.MODE_PRIVATE);
    }

    // -----------------------------------------------------------------------
    // 分類と、ほかのアプリへの譲り
    // -----------------------------------------------------------------------

    /**
     * 予定の通知の分類を作る。すでにある分類は名前と説明だけが新しくなる
     * (利用者が変えた音やオン / オフは残る)。
     */
    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        createChannel(
            manager,
            CHANNEL_REMINDERS,
            context.getString(R.string.channel_calendar_reminders_name),
            context.getString(R.string.channel_calendar_reminders_description),
            NotificationManager.IMPORTANCE_HIGH
        );
        createChannel(
            manager,
            CHANNEL_INVITES,
            context.getString(R.string.channel_calendar_invites_name),
            context.getString(R.string.channel_calendar_invites_description),
            NotificationManager.IMPORTANCE_DEFAULT
        );
    }

    private static void createChannel(NotificationManager manager, String id, String name, String description, int importance) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(id, name, importance);
        channel.setDescription(description);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(channel);
    }

    /**
     * このアプリが予定の通知を受け持たないか。Mail アプリは、Calendar アプリ (段取り 10) が
     * 入っていれば予定の通知を出さず、予約もしない (同じ端末で 2 回鳴らさない。設計 3.4)。
     * Calendar アプリ自身では常に false。
     */
    static boolean handledByOtherApp(Context context) {
        if (CALENDAR_APP_PACKAGE.equals(context.getPackageName())) return false;
        try {
            context.getPackageManager().getPackageInfo(CALENDAR_APP_PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // 小物
    // -----------------------------------------------------------------------

    private static void post(Context context, String tag, NotificationCompat.Builder builder) {
        // 利用者が通知を許可していなければ出さない (Android 13 以降は許可が要る)。
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        manager.notify(tag, NOTIFICATION_ID, builder.build());
    }

    /** UUID の形の予定の ID。それ以外は null。 */
    static String validEventId(String value) {
        return value != null && UUID_PATTERN.matcher(value).matches() ? value : null;
    }

    /** 回の ID。空・長すぎる・制御文字を含むものは null。 */
    static String validRecurrenceId(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_RECURRENCE_ID_LENGTH) return null;
        for (int index = 0; index < value.length(); index++) {
            if (Character.isISOControl(value.charAt(index))) return null;
        }
        return value;
    }

    static long parseLong(String value) {
        if (value == null || value.isEmpty()) return 0;
        try {
            return (long) Double.parseDouble(value);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static boolean notEmpty(String value) {
        return value != null && !value.isEmpty();
    }

    static String orEmpty(String value) {
        return value == null ? "" : value;
    }

    /** JSON の文字列の項目 (null や無いときは null)。 */
    static String optString(JSONObject object, String key) {
        if (object == null || !object.has(key) || object.isNull(key)) return null;
        try {
            return object.getString(key);
        } catch (JSONException e) {
            return null;
        }
    }
}
