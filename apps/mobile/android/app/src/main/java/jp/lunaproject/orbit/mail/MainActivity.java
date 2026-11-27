package jp.lunaproject.orbit.mail;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** 画面が見えているか。見えている間は、新着メールを通知せず一覧に反映する。 */
    private static volatile boolean visible = false;

    static boolean isVisible() {
        return visible;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 画面の自動更新で取得した画面があれば、どれを使うか決めて Capacitor の設定に書く (WebBundles)。
        // Capacitor は super.onCreate の中でこの設定を読むので、先に行う。
        WebBundles.prepare(this);
        // このアプリ専用のプラグインは、画面を作る前に登録する。
        registerPlugin(AppShellPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        super.onCreate(savedInstanceState);
        // ブラウザー標準の自動入力は出さない (パスワード欄がある間だけ、画面側から許す)。
        AppAutofill.apply(getBridge().getWebView(), false);
        prepareCalendarNotifications();
    }

    /**
     * 予定の通知 (段取り 9) の準備。分類を作っておき (Android の設定に最初から並ぶ)、
     * Calendar アプリ (段取り 10) が入っていれば、このアプリの予約を消して通知を譲る (設計 3.4)。
     * 予定の通知を押したときは、アプリ専用の URL (…://calendar/events/<id>) の VIEW で開く
     * (CalendarNotifications.openIntent)。URL は Capacitor の App プラグインが画面へ渡すので、
     * ここでは受け取らない。
     */
    private void prepareCalendarNotifications() {
        if (CalendarNotifications.handledByOtherApp(this)) {
            ReminderScheduler.clear(this);
        } else {
            CalendarNotifications.ensureChannels(this);
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        visible = true;
    }

    @Override
    public void onStop() {
        visible = false;
        super.onStop();
    }
}
