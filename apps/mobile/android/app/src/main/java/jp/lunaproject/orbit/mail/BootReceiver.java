package jp.lunaproject.orbit.mail;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 電源を入れ直したとき・アプリを更新したとき・時計やタイムゾーンが変わったときに、
 * 保存した一覧からリマインダーを登録し直す (AlarmManager の予約は再起動とアプリの更新で消える)。
 * ログインしていなければ登録し直さず、一覧も消す (設計 7.2)。
 * 終日の予定の時刻 (タイムゾーンで変わる) の計算し直しは、次に画面を開いたときに画面が行う。
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!handles(intent.getAction())) return;
        if (!SharedConfig.load(context).usable() || CalendarNotifications.handledByOtherApp(context)) {
            ReminderScheduler.clear(context);
            return;
        }
        ReminderScheduler.restore(context);
    }

    private static boolean handles(String action) {
        if (action == null) return false;
        switch (action) {
            case Intent.ACTION_BOOT_COMPLETED:
            case Intent.ACTION_MY_PACKAGE_REPLACED:
            case Intent.ACTION_TIME_CHANGED:
            case Intent.ACTION_TIMEZONE_CHANGED:
            case AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED:
                return true;
            default:
                return false;
        }
    }
}
