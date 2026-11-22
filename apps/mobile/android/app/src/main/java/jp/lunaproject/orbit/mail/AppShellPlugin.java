package jp.lunaproject.orbit.mail;

import androidx.appcompat.app.AppCompatDelegate;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
}
