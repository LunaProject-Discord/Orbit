package jp.lunaproject.orbit.mail;

import android.content.ContentProviderClient;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;

/**
 * Orbit のアプリどうし (Mail、Calendar、Contacts) で共有する設定。接続先サーバーとログイン。
 *
 * スマホでは機能ごとに別のアプリにするので、どれか 1 つでサーバーを決めてログインすれば、
 * ほかのアプリでは入力し直さずに使えるようにする。しくみ:
 *   - それぞれのアプリが、自分の設定を SharedConfigProvider で公開する。
 *   - 読めるのは、同じ鍵で署名したアプリだけ (signature の権限 PERMISSION)。
 *   - 起動時にログインしていなければ、ほかのアプリの設定を探して引き継ぐ。
 * ログイン (セッションのトークン) を渡すので、署名の違うアプリには決して公開しない。
 */
final class SharedConfig {

    /** 同じ鍵で署名したアプリだけが持てる権限。AndroidManifest.xml の定義と合わせる。 */
    static final String PERMISSION = "jp.lunaproject.orbit.permission.SHARED_CONFIG";
    /** Orbit のアプリのパッケージ名。AndroidManifest.xml の queries と合わせる。 */
    static final String[] PACKAGES = {
        "jp.lunaproject.orbit.mail",
        "jp.lunaproject.orbit.calendar",
        "jp.lunaproject.orbit.contacts",
    };
    /** 公開する内容の列。 */
    static final String COLUMN_SERVER_URL = "server_url";
    static final String COLUMN_SESSION_TOKEN = "session_token";
    static final String COLUMN_UPDATED_AT = "updated_at";
    static final String[] COLUMNS = { COLUMN_SERVER_URL, COLUMN_SESSION_TOKEN, COLUMN_UPDATED_AT };

    private static final String PREFERENCES = "orbit_shared_config";

    final String serverUrl;
    final String sessionToken;
    final long updatedAt;

    SharedConfig(String serverUrl, String sessionToken, long updatedAt) {
        this.serverUrl = serverUrl == null ? "" : serverUrl;
        this.sessionToken = sessionToken == null ? "" : sessionToken;
        this.updatedAt = updatedAt;
    }

    /** ほかのアプリが引き継げる内容か (接続先とログインの両方がある)。 */
    boolean usable() {
        return !serverUrl.isEmpty() && !sessionToken.isEmpty();
    }

    /** SharedConfigProvider の宛先 (authority)。 */
    static String authority(String packageName) {
        return packageName + ".shared";
    }

    /** このアプリの設定を保存する (画面でログインやログアウトをしたときに呼ぶ)。 */
    static void save(Context context, String serverUrl, String sessionToken) {
        SharedConfig current = load(context);
        String url = serverUrl == null ? "" : serverUrl;
        String token = sessionToken == null ? "" : sessionToken;
        // 変わっていなければ、更新の時刻を進めない (新しいほうを選ぶ判断を狂わせない)。
        if (current.serverUrl.equals(url) && current.sessionToken.equals(token)) return;
        preferences(context)
            .edit()
            .putString(COLUMN_SERVER_URL, url)
            .putString(COLUMN_SESSION_TOKEN, token)
            .putLong(COLUMN_UPDATED_AT, System.currentTimeMillis())
            .apply();
    }

    /** このアプリの設定。 */
    static SharedConfig load(Context context) {
        SharedPreferences stored = preferences(context);
        return new SharedConfig(
            stored.getString(COLUMN_SERVER_URL, ""),
            stored.getString(COLUMN_SESSION_TOKEN, ""),
            stored.getLong(COLUMN_UPDATED_AT, 0)
        );
    }

    /**
     * ほかの Orbit のアプリの設定のうち、引き継げるもので最も新しいもの。無ければ null。
     * 入っていないアプリや、署名の違うアプリ (権限が無くて読めない) は飛ばす。
     */
    static SharedConfig findFromSiblings(Context context) {
        SharedConfig newest = null;
        for (String packageName : PACKAGES) {
            if (packageName.equals(context.getPackageName())) continue;
            SharedConfig found = query(context, packageName);
            if (found == null || !found.usable()) continue;
            if (newest == null || found.updatedAt > newest.updatedAt) newest = found;
        }
        return newest;
    }

    private static SharedConfig query(Context context, String packageName) {
        Uri uri = new Uri.Builder().scheme("content").authority(authority(packageName)).build();
        ContentProviderClient client = null;
        try {
            client = context.getContentResolver().acquireUnstableContentProviderClient(uri);
            if (client == null) return null;
            try (Cursor cursor = client.query(uri, COLUMNS, null, null, null)) {
                if (cursor == null || !cursor.moveToFirst()) return null;
                return new SharedConfig(
                    cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_SERVER_URL)),
                    cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_SESSION_TOKEN)),
                    cursor.getLong(cursor.getColumnIndexOrThrow(COLUMN_UPDATED_AT))
                );
            }
        } catch (Exception error) {
            // 読めないアプリ (署名が違う、古い版、止まっている) は、無いものとして扱う。
            return null;
        } finally {
            if (client != null) client.close();
        }
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
