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
        registerPlugin(AppBodyUpdatePlugin.class);
        super.onCreate(savedInstanceState);
        // ブラウザー標準の自動入力は出さない (パスワード欄がある間だけ、画面側から許す)。
        AppAutofill.apply(getBridge().getWebView(), false);
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
