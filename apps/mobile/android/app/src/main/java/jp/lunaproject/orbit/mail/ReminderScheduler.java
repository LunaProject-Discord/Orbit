package jp.lunaproject.orbit.mail;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 予定のリマインダーを AlarmManager に予約する (段取り 9、設計 3.2・3.5)。
 *
 * 画面 (ReminderAgent) が毎回「全部の一覧」を渡し、ここで今ある予約との差分を取る。
 * 一覧はアプリ専用の保存領域 (SharedPreferences) に書き、時刻が来たら ReminderReceiver が
 * そこから中身を読んで出す。電源を入れ直したときは BootReceiver がここから登録し直す。
 *
 * 正確なアラーム: 使えれば setExactAndAllowWhileIdle、使えなければ setAndAllowWhileIdle
 * (Doze 中は遅れ得る。その分はサーバーの FCM が補い、同じ tag で 1 つになる)。
 * Mail アプリは正確なアラームの権限を持たない (Android 12 以降は不正確)。段取り 10 の
 * Calendar アプリがマニフェストに USE_EXACT_ALARM を書けば、canScheduleExact が true になり、
 * このコードのまま正確なアラームに切り替わる (設計 13 章の未決 3)。
 */
final class ReminderScheduler {

    /** 一度に予約する件数の上限 (DEVICE_REMINDER_LIMIT と同じ)。 */
    static final int MAX_ITEMS = 64;
    /** 鳴らす時刻をこれ以上過ぎたものは鳴らさない (REMINDER_LATE_LIMIT_MS と同じ 15 分)。 */
    static final long LATE_LIMIT_MS = 15L * 60 * 1000;
    /** 受け付ける tag の先頭 (reminderTag)。 */
    private static final String TAG_PREFIX = CalendarNotifications.REMINDER_TAG_PREFIX;
    private static final int MAX_TAG_LENGTH = 300;
    private static final int MAX_TITLE_LENGTH = 300;
    private static final int MAX_BODY_LENGTH = 1000;

    static final String ACTION_FIRE = "jp.lunaproject.orbit.mail.REMINDER_FIRE";
    static final String EXTRA_TAG = "tag";
    /** PendingIntent を tag ごとに分けるための URL の形 (orbit-reminder:<tag>)。 */
    private static final String URI_SCHEME = "orbit-reminder";

    private static final String PREFERENCES = "orbit_reminders";
    private static final String KEY_ITEMS = "items";

    private ReminderScheduler() {}

    /** 予約する通知 1 件 (画面の ScheduledReminder と同じ形)。 */
    static final class Item {

        final String tag;
        final long fireAt;
        final long expiresAt;
        final String title;
        final String body;
        final String eventId;
        final String recurrenceId;

        Item(String tag, long fireAt, long expiresAt, String title, String body, String eventId, String recurrenceId) {
            this.tag = tag;
            this.fireAt = fireAt;
            this.expiresAt = expiresAt;
            this.title = title;
            this.body = body;
            this.eventId = eventId;
            this.recurrenceId = recurrenceId;
        }

        /** 画面から渡された JSON を読む。形が違うものは null (予約しない)。 */
        static Item fromJson(JSONObject object) {
            if (object == null) return null;
            String tag = CalendarNotifications.optString(object, "tag");
            String title = CalendarNotifications.optString(object, "title");
            String eventId = CalendarNotifications.validEventId(CalendarNotifications.optString(object, "eventId"));
            long fireAt = object.optLong("fireAt", 0);
            long expiresAt = object.optLong("expiresAt", 0);
            if (tag == null || !tag.startsWith(TAG_PREFIX) || tag.length() > MAX_TAG_LENGTH) return null;
            if (title == null || eventId == null || fireAt <= 0) return null;
            return new Item(
                tag,
                fireAt,
                expiresAt,
                truncate(title, MAX_TITLE_LENGTH),
                truncate(CalendarNotifications.orEmpty(CalendarNotifications.optString(object, "body")), MAX_BODY_LENGTH),
                eventId,
                CalendarNotifications.validRecurrenceId(CalendarNotifications.optString(object, "recurrenceId"))
            );
        }

        JSONObject toJson() throws JSONException {
            JSONObject object = new JSONObject();
            object.put("tag", tag);
            object.put("fireAt", fireAt);
            object.put("expiresAt", expiresAt);
            object.put("title", title);
            object.put("body", body);
            object.put("eventId", eventId);
            object.put("recurrenceId", recurrenceId == null ? JSONObject.NULL : recurrenceId);
            return object;
        }

        /** もう鳴らさなくてよいか (予定が終わった、または鳴らす時刻を 15 分以上過ぎた)。 */
        boolean stale(long now) {
            if (expiresAt > 0 && expiresAt <= now) return true;
            return now - fireAt > LATE_LIMIT_MS;
        }
    }

    /** 予約の能力 (画面の ReminderCapabilities)。 */
    static boolean canScheduleExact(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        return alarms != null && alarms.canScheduleExactAlarms();
    }

    /**
     * 予約を items にそろえる。items に無くなった予約は取り消し、残りは登録し直す
     * (同じ tag の PendingIntent は置き換わるので、何度呼んでも同じ結果になる)。
     *
     * 今ある予約のうち「時刻を過ぎたが、まだ鳴っていない」もの (不正確なアラームが遅れている) は、
     * items に同じ tag が無ければ残す。画面は過ぎたものを 1 度しか渡さないため (レビュー M5)。
     */
    static synchronized void replaceAll(Context context, List<Item> items) {
        long now = System.currentTimeMillis();
        List<Item> wanted = new ArrayList<>();
        Set<String> tags = new HashSet<>();
        for (Item item : items) {
            if (item == null || item.stale(now) || !tags.add(item.tag)) continue;
            // 既に出した (利用者が消したかもしれない) 通知は、もう一度は予約しない。
            // 同じ tag でも鳴らす時刻が動いたもの (予定の延期) は、別の通知として予約する (H1)。
            if (CalendarNotifications.wasShownRecently(context, item, now)) continue;
            wanted.add(item);
        }
        for (Item old : load(context)) {
            if (old.fireAt > now || old.stale(now) || tags.contains(old.tag)) continue;
            if (CalendarNotifications.wasShownRecently(context, old, now)) continue;
            tags.add(old.tag);
            wanted.add(old);
        }
        Collections.sort(wanted, (a, b) -> Long.compare(a.fireAt, b.fireAt));
        if (wanted.size() > MAX_ITEMS) wanted = new ArrayList<>(wanted.subList(0, MAX_ITEMS));

        Set<String> keep = new HashSet<>();
        for (Item item : wanted) keep.add(item.tag);
        for (Item old : load(context)) {
            if (!keep.contains(old.tag)) cancelAlarm(context, old.tag);
        }
        boolean exact = canScheduleExact(context);
        for (Item item : wanted) setAlarm(context, item, exact, now);
        save(context, wanted);
    }

    /** 予約をすべて取り消し、保存した一覧も消す (ログアウト・利用者の切り替え)。 */
    static synchronized void clear(Context context) {
        for (Item old : load(context)) cancelAlarm(context, old.tag);
        preferences(context).edit().clear().apply();
    }

    /** 保存した一覧から登録し直す (再起動・アプリの更新・時計の変更のあと)。古いものは捨てる。 */
    static synchronized void restore(Context context) {
        replaceAll(context, load(context));
    }

    /** 1 件の予約を取り消す (同じ tag の FCM が先に届いたとき)。 */
    static synchronized void cancelOne(Context context, String tag) {
        List<Item> items = load(context);
        List<Item> rest = new ArrayList<>();
        boolean found = false;
        for (Item item : items) {
            if (item.tag.equals(tag)) found = true;
            else rest.add(item);
        }
        if (!found) return;
        cancelAlarm(context, tag);
        save(context, rest);
    }

    /** 時刻が来た予約を取り出す (一覧から外す)。無ければ null (取り消された、ログアウトした)。 */
    static synchronized Item take(Context context, String tag) {
        List<Item> items = load(context);
        Item hit = null;
        List<Item> rest = new ArrayList<>();
        for (Item item : items) {
            if (hit == null && item.tag.equals(tag)) hit = item;
            else rest.add(item);
        }
        if (hit != null) save(context, rest);
        return hit;
    }

    // -----------------------------------------------------------------------

    private static void setAlarm(Context context, Item item, boolean exact, long now) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        // 時刻を少し過ぎたもの (15 分以内) は、すぐに鳴らす。
        long at = Math.max(item.fireAt, now + 1000);
        PendingIntent pending = pendingIntent(context, item.tag, PendingIntent.FLAG_UPDATE_CURRENT);
        if (pending == null) return;
        try {
            if (exact) {
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            } else {
                alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            }
        } catch (SecurityException e) {
            // 正確なアラームの許可が途中で外された。不正確な予約に落とす。
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        }
    }

    private static void cancelAlarm(Context context, String tag) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pending = pendingIntent(context, tag, PendingIntent.FLAG_NO_CREATE);
        if (pending == null) return;
        if (alarms != null) alarms.cancel(pending);
        pending.cancel();
    }

    /**
     * tag ごとの PendingIntent。tag を URL に入れて Intent を分ける
     * (番号 = hashCode だけで分けると、たまたま同じ値の 2 件が置き換わってしまう)。
     */
    private static PendingIntent pendingIntent(Context context, String tag, int flags) {
        Intent intent = new Intent(context, ReminderReceiver.class);
        intent.setAction(ACTION_FIRE);
        intent.setData(Uri.fromParts(URI_SCHEME, tag, null));
        intent.putExtra(EXTRA_TAG, tag);
        return PendingIntent.getBroadcast(context, 0, intent, flags | PendingIntent.FLAG_IMMUTABLE);
    }

    static List<Item> load(Context context) {
        List<Item> items = new ArrayList<>();
        String stored = preferences(context).getString(KEY_ITEMS, null);
        if (stored == null) return items;
        try {
            JSONArray array = new JSONArray(stored);
            for (int index = 0; index < array.length(); index++) {
                Item item = Item.fromJson(array.optJSONObject(index));
                if (item != null) items.add(item);
            }
        } catch (JSONException e) {
            // 読めない一覧は捨てる (次に画面が開いたときに作り直される)。
        }
        return items;
    }

    private static void save(Context context, List<Item> items) {
        JSONArray array = new JSONArray();
        try {
            for (Item item : items) array.put(item.toJson());
        } catch (JSONException e) {
            return;
        }
        // commit (同期) で書く。直後にプロセスが終わっても一覧が残るように。
        preferences(context).edit().putString(KEY_ITEMS, array.toString()).commit();
    }

    /** 画面から渡された items (JSON の配列) を読む。 */
    static List<Item> parse(JSONArray array) {
        List<Item> items = new ArrayList<>();
        if (array == null) return items;
        for (int index = 0; index < array.length(); index++) {
            Item item = Item.fromJson(array.optJSONObject(index));
            if (item != null) items.add(item);
        }
        return items;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static String truncate(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max);
    }
}
