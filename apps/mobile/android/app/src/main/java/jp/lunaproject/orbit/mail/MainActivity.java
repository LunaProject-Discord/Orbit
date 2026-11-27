package jp.lunaproject.orbit.mail;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** 画面が見えているか。見えている間は、新着メールを通知せず一覧に反映する。 */
    private static volatile boolean visible = false;

    static boolean isVisible() {
        return visible;
    }

    /**
     * 予定の通知から起動したときの URL (…://calendar/events/<id>)。画面が takeLaunchCalendarUrl で
     * 1 度だけ受け取る。履歴から開き直したとき・画面を作り直したときは渡さない
     * (Capacitor の getLaunchUrl は Activity を作ったときの Intent を返し続けるため。レビュー L7)。
     */
    private String launchCalendarUrl = null;

    /** 起動時の予定の URL を受け取る (2 度目からは null)。 */
    synchronized String takeLaunchCalendarUrl() {
        String url = launchCalendarUrl;
        launchCalendarUrl = null;
        return url;
    }

    private void rememberLaunchCalendarUrl(Intent intent, Bundle savedInstanceState) {
        // 作り直し (画面の回転、プロセスが止められたあとの復元) では渡さない。
        if (savedInstanceState != null || intent == null) return;
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        if (!Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data == null) return;
        String scheme = getString(R.string.custom_url_scheme);
        if (scheme.equals(data.getScheme()) && "calendar".equals(data.getHost())) {
            launchCalendarUrl = data.toString();
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 画面の自動更新で取得した画面があれば、どれを使うか決めて Capacitor の設定に書く (WebBundles)。
        // Capacitor は super.onCreate の中でこの設定を読むので、先に行う。
        WebBundles.prepare(this);
        // このアプリ専用のプラグインは、画面を作る前に登録する。
        registerPlugin(AppShellPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        rememberLaunchCalendarUrl(getIntent(), savedInstanceState);
        super.onCreate(savedInstanceState);
        // ブラウザー標準の自動入力は出さない (パスワード欄がある間だけ、画面側から許す)。
        AppAutofill.apply(getBridge().getWebView(), false);
        prepareCalendarNotifications();
    }

    /**
     * 予定の通知 (段取り 9) の準備。分類を作っておき (Android の設定に最初から並ぶ)、
     * Calendar アプリ (段取り 10) が入っていれば、このアプリの予約を消して通知を譲る (設計 3.4)。
     * 予定の通知を押したときは、アプリ専用の URL (…://calendar/events/<id>) の VIEW で開く
     * (CalendarNotifications.openIntent)。起動中は Capacitor の App プラグインが appUrlOpen で渡し、
     * 通知から起動したときは、このクラスが覚えた URL を画面が 1 度だけ受け取る。
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
