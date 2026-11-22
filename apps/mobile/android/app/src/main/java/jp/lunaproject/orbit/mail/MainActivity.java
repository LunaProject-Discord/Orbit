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
        // このアプリ専用のプラグインは、画面を作る前に登録する。
        registerPlugin(AppShellPlugin.class);
        super.onCreate(savedInstanceState);
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
