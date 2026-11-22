package jp.lunaproject.orbit.mail;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // このアプリ専用のプラグインは、画面を作る前に登録する。
        registerPlugin(AppShellPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
