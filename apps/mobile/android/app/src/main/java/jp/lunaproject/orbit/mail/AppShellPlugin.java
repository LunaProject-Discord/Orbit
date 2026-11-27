package jp.lunaproject.orbit.mail;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 画面 (Web 側) から呼ぶ、このアプリ専用の小さな機能。 */
@CapacitorPlugin(name = "AppShell")
public class AppShellPlugin extends Plugin {

    // 添付の保存先への書き写しは、保存先を選んだ結果 (UI スレッドで届く) から始まるので、別のスレッドで行う。
    private final ExecutorService fileExecutor = Executors.newSingleThreadExecutor();

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

    /*
     * 添付ファイルを「端末に保存する」「別のアプリで開く」(しくみは AttachmentFiles)。
     * 画面は beginFile → appendFile (小分けの base64 を順に) → saveFile か openFile の順に呼ぶ。
     * プラグインの呼び出しは画面とは別の 1 本のスレッドで順に動くので、追記などの小さな読み書きはそのまま行う。
     */

    /** 空の一時ファイルを作る。 */
    @PluginMethod
    public void beginFile(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("id", AttachmentFiles.begin(getContext()));
            call.resolve(result);
        } catch (IOException | RuntimeException error) {
            call.reject("一時ファイルを作れませんでした。", error);
        }
    }

    /** 一時ファイルの後ろに、base64 の中身を足す。 */
    @PluginMethod
    public void appendFile(PluginCall call) {
        try {
            AttachmentFiles.append(getContext(), call.getString("id"), call.getString("data", ""));
            call.resolve();
        } catch (IOException | RuntimeException error) {
            call.reject(messageOf(error, "ファイルを準備できませんでした。"), error);
        }
    }

    /** 利用者に保存先を選んでもらい、一時ファイルを書き写す。結果は saveFileResult で受け取る。 */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String id = call.getString("id");
        if (!AttachmentFiles.exists(getContext(), id)) {
            AttachmentFiles.discard(getContext(), id);
            call.reject("一時ファイルが見つかりません。");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(AttachmentFiles.safeMimeType(call.getString("mimeType")));
        intent.putExtra(Intent.EXTRA_TITLE, AttachmentFiles.safeFileName(call.getString("name")));
        try {
            startActivityForResult(call, intent, "saveFileResult");
        } catch (ActivityNotFoundException error) {
            // 保存先を選ぶ画面 (ファイル アプリ) が無い端末。
            getBridge().releaseCall(call);
            AttachmentFiles.discard(getContext(), id);
            call.reject("この端末では保存先を選べません。", error);
        }
    }

    /** 保存先を選ぶ画面から戻ったとき (UI スレッド)。成功・取り消し・失敗のいずれでも一時ファイルは消す。 */
    @ActivityCallback
    private void saveFileResult(PluginCall call, ActivityResult result) {
        // アプリが一度終了されてから戻ったときなど、呼び出しが残っていないことがある。
        if (call == null) return;
        Context context = getContext();
        String id = call.getString("id");
        Intent data = result.getData();
        Uri target = result.getResultCode() == Activity.RESULT_OK && data != null ? data.getData() : null;
        if (target == null) {
            AttachmentFiles.discard(context, id);
            resolveFlag(call, "saved", false);
            getBridge().releaseCall(call);
            return;
        }
        fileExecutor.execute(() -> {
            try {
                AttachmentFiles.copyTo(context, id, target);
                resolveFlag(call, "saved", true);
            } catch (IOException | RuntimeException error) {
                call.reject(messageOf(error, "保存できませんでした。"), error);
            } finally {
                AttachmentFiles.discard(context, id);
                getBridge().releaseCall(call);
            }
        });
    }

    /**
     * 一時ファイルを添付の名前に改名し、ほかのアプリ (PDF ビューアーなど) で開く。
     * 開けるアプリが無ければ opened は false。開けたときは、相手が読み終わるまで消せないのでファイルを残す
     * (次の beginFile で、24 時間より古いものを消す)。
     * Android 11 以降は、queries に書いていないアプリは resolveActivity で見えない。事前に確かめると
     * 「開けるのに無いと判断する」ことになるので、そのまま startActivity して例外で判断する。
     */
    @PluginMethod
    public void openFile(PluginCall call) {
        Context context = getContext();
        String id = call.getString("id");
        String mimeType = AttachmentFiles.safeMimeType(call.getString("mimeType"));
        Uri uri;
        try {
            File file = AttachmentFiles.rename(context, id, AttachmentFiles.safeFileName(call.getString("name")));
            uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
        } catch (IOException | RuntimeException error) {
            AttachmentFiles.discard(context, id);
            call.reject(messageOf(error, "ファイルを開けませんでした。"), error);
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, mimeType);
        // 相手のアプリに、この 1 つのファイルだけを読む許可を渡す。
        // Activity から開くので FLAG_ACTIVITY_NEW_TASK は付けない (このアプリの上に開き、戻るでメールに戻る)。
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(intent);
                resolveFlag(call, "opened", true);
            } catch (ActivityNotFoundException error) {
                AttachmentFiles.discard(context, id);
                resolveFlag(call, "opened", false);
            } catch (RuntimeException error) {
                AttachmentFiles.discard(context, id);
                call.reject("ファイルを開けませんでした。", error);
            }
        });
    }

    private static void resolveFlag(PluginCall call, String key, boolean value) {
        JSObject result = new JSObject();
        result.put(key, value);
        call.resolve(result);
    }

    /** AttachmentFiles が投げた日本語の説明があればそれを、無ければ (Android の英語の説明は見せず) 既定の説明を返す。 */
    private static String messageOf(Exception error, String fallback) {
        return error instanceof AttachmentFiles.FileError ? error.getMessage() : fallback;
    }
}
