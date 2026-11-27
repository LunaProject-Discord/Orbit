package jp.lunaproject.orbit.mail;

import androidx.appcompat.app.AppCompatDelegate;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/** 画面 (Web 側) から呼ぶ、このアプリ専用の小さな機能。 */
@CapacitorPlugin(name = "AppShell")
public class AppShellPlugin extends Plugin {

    /**
     * アプリの中で選んだテーマ (light / dark / system) を Android 側にも伝える。
     * ステータスバーやナビゲーションバーの背景とアイコンの明暗は Android のテーマで決まるので、
     * 伝えないと「アプリはダーク、バーは白」のように食い違う。
     */
    @PluginMethod
    public void setTheme(PluginCall call) {
        String mode = call.getString("mode", "system");
        final int nightMode;
        if ("dark".equals(mode)) {
            nightMode = AppCompatDelegate.MODE_NIGHT_YES;
        } else if ("light".equals(mode)) {
            nightMode = AppCompatDelegate.MODE_NIGHT_NO;
        } else {
            nightMode = AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM;
        }
        getActivity().runOnUiThread(() -> {
            AppCompatDelegate.setDefaultNightMode(nightMode);
            call.resolve();
        });
    }

    /**
     * このアプリが Firebase の設定 (google-services.json) を入れてビルドされているか。
     * 入っていないアプリで通知の登録を呼ぶと Firebase が例外を投げるので、画面側は先にこれを確かめる。
     * 設定があると、ビルド時に google_app_id という文字列リソースが作られる。
     */
    @PluginMethod
    public void isPushConfigured(PluginCall call) {
        int id = getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName());
        JSObject result = new JSObject();
        result.put("configured", id != 0);
        call.resolve(result);
    }

    /**
     * このアプリの接続先サーバーとログインを、ほかの Orbit のアプリ (Calendar、Contacts) が
     * 引き継げるように保存する。ログアウトしたときは sessionToken を空にして呼ぶ。
     * しくみは SharedConfig を参照。
     */
    @PluginMethod
    public void publishSharedConfig(PluginCall call) {
        String sessionToken = call.getString("sessionToken", "");
        String previous = SharedConfig.load(getContext()).sessionToken;
        SharedConfig.save(getContext(), call.getString("serverUrl", ""), sessionToken);
        // ログアウトした・別の利用者でログインし直したら、予定のリマインダーの予約と、出ている
        // 予定の通知をすべて消す (前の利用者の予定が通知に出ないようにする。設計 7.2)。
        // 画面も橋の clear を呼ぶが、画面の処理が途中で終わっても消えるよう、ここでも消す。
        if (sessionToken == null || sessionToken.isEmpty() || (!previous.isEmpty() && !previous.equals(sessionToken))) {
            clearCalendarNotifications();
        }
        call.resolve();
    }

    /**
     * 予定のリマインダーの予約の能力 (画面の ReminderCapabilities)。
     * schedule は、アプリを終了しても鳴る "os"。Calendar アプリ (段取り 10) が入っていれば、
     * Mail アプリは予約しないので "none"。exact は正確なアラームが使えるか (Mail アプリは
     * Android 12 以降 false。その分はサーバーの FCM が補う)。
     */
    @PluginMethod
    public void reminderCapabilities(PluginCall call) {
        JSObject result = new JSObject();
        boolean handled = CalendarNotifications.handledByOtherApp(getContext());
        result.put("schedule", handled ? "none" : "os");
        result.put("exact", !handled && ReminderScheduler.canScheduleExact(getContext()));
        call.resolve(result);
    }

    /**
     * 予定のリマインダーを予約する。items は画面の ScheduledReminder の配列で、毎回「全部の一覧」。
     * 今ある予約との差分は ReminderScheduler が取る。
     */
    @PluginMethod
    public void scheduleReminders(PluginCall call) {
        if (CalendarNotifications.handledByOtherApp(getContext())) {
            ReminderScheduler.clear(getContext());
            call.resolve();
            return;
        }
        JSArray items = call.getArray("items");
        if (items == null) {
            call.reject("items がありません。");
            return;
        }
        CalendarNotifications.ensureChannels(getContext());
        ReminderScheduler.replaceAll(getContext(), ReminderScheduler.parse(items));
        call.resolve();
    }

    /**
     * 予定の通知から起動したときの URL を、1 度だけ返す (無ければ url は null)。
     * 履歴から開き直したとき・画面を作り直したときは null (同じ予定をまた開かない)。
     */
    @PluginMethod
    public void takeLaunchCalendarUrl(PluginCall call) {
        JSObject result = new JSObject();
        String url = null;
        if (getActivity() instanceof MainActivity) url = ((MainActivity) getActivity()).takeLaunchCalendarUrl();
        result.put("url", url == null ? JSONObject.NULL : url);
        call.resolve(result);
    }

    /** 予定のリマインダーの予約をすべて消す (ログアウト・利用者の切り替え・401)。 */
    @PluginMethod
    public void clearReminders(PluginCall call) {
        clearCalendarNotifications();
        call.resolve();
    }

    private void clearCalendarNotifications() {
        ReminderScheduler.clear(getContext());
        CalendarNotifications.cancelAll(getContext());
    }

    /** ほかの Orbit のアプリの接続先サーバーとログインを探す。見つからなければ found は false。 */
    @PluginMethod
    public void findSharedConfig(PluginCall call) {
        SharedConfig found = SharedConfig.findFromSiblings(getContext());
        JSObject result = new JSObject();
        result.put("found", found != null);
        if (found != null) {
            result.put("serverUrl", found.serverUrl);
            result.put("sessionToken", found.sessionToken);
        }
        call.resolve(result);
    }

    /**
     * 端末に入っているフォントの一覧。画面側は、ここで返すファイルを @font-face で読み込んで使う。
     * フォントのファイルを順に開くので少し時間がかかる (プラグインの呼び出しは画面とは別のスレッドで動く)。
     */
    @PluginMethod
    public void listFonts(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("fonts", FontCatalog.list());
            call.resolve(result);
        } catch (RuntimeException error) {
            call.reject("フォントの一覧を取得できませんでした。", error);
        }
    }

    /**
     * Android の自動入力を許すかどうか。画面にログインなどのパスワード欄がある間だけ許す (AppAutofill)。
     */
    @PluginMethod
    public void setAutofillAllowed(PluginCall call) {
        boolean allowed = Boolean.TRUE.equals(call.getBoolean("allowed", false));
        getActivity().runOnUiThread(() -> {
            AppAutofill.apply(getBridge().getWebView(), allowed);
            call.resolve();
        });
    }
}
