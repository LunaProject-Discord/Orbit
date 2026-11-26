package jp.lunaproject.orbit.mail;

import android.os.Build;
import android.view.View;
import android.view.autofill.AutofillManager;
import android.webkit.WebView;

/**
 * 画面 (WebView) での Android の自動入力 (Google の自動入力やパスワードマネージャーの候補)。
 * アプリでは、ブラウザー標準の自動入力は出さない。ただし、ログインなどのパスワード欄が
 * 画面にある間だけは、パスワードマネージャーを使えるように許す (画面側の lib/app-autofill.ts が切り替える)。
 * 入力欄の autocomplete="off" だけでは、Android の自動入力は止まらないことがあるので、WebView ごと外す。
 */
final class AppAutofill {

    private AppAutofill() {}

    static void apply(WebView webView, boolean allowed) {
        // 自動入力のしくみは Android 8.0 (API 26) から。それより前は何もしない。
        if (webView == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        webView.setImportantForAutofill(
                allowed ? View.IMPORTANT_FOR_AUTOFILL_AUTO : View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        if (!allowed) {
            // すでに出ている候補があれば閉じる。
            AutofillManager manager = webView.getContext().getSystemService(AutofillManager.class);
            if (manager != null) manager.cancel();
        }
    }
}
