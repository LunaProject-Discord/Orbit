package jp.lunaproject.orbit.mail;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 予約したリマインダーの時刻が来たときの受け口 (ReminderScheduler が AlarmManager に登録する)。
 * 中身は Intent ではなく保存した一覧から読む。取り消し・ログアウトのあとに残ったアラームが
 * 来ても、一覧に無ければ何も出さない。
 */
public class ReminderReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ReminderScheduler.ACTION_FIRE.equals(intent.getAction())) return;
        String tag = intent.getStringExtra(ReminderScheduler.EXTRA_TAG);
        if (tag == null) return;
        ReminderScheduler.Item item = ReminderScheduler.take(context, tag);
        if (item == null) return;
        // ログアウトしていれば出さない (予約は clear で消えているはずだが、念のため)。
        if (!SharedConfig.load(context).usable()) {
            ReminderScheduler.clear(context);
            return;
        }
        if (CalendarNotifications.handledByOtherApp(context)) return;
        long now = System.currentTimeMillis();
        // Doze などで大きく遅れたもの・予定が終わったものは出さない (設計 2.1)。
        if (item.stale(now)) return;
        // 同じ tag の FCM が先に届いて出ていれば、出し直さない。
        if (CalendarNotifications.wasShownRecently(context, item, now)) return;
        CalendarNotifications.showReminder(context, item);
    }
}
