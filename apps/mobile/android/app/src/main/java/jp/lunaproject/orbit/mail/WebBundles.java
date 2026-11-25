package jp.lunaproject.orbit.mail;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 画面の自動更新 (docs/app-update.md) で取得した画面の置き場と、起動時にどれを使うかの判断。
 *
 * <p>取得した画面は files/web-bundle/&lt;版&gt;/ に置く。Capacitor は起動時に、設定
 * (CapWebViewSettings の serverBasePath) にフォルダがあればそこから画面を配信する。
 * URL は https://localhost のままなので、ログインの状態や IndexedDB はそのまま使える。
 *
 * <p>新しい版で起動して、画面から「問題なく起動した」(AppUpdatePlugin.ready) と伝えられないまま終わったら、
 * 次に起動したときはその版を使わずに前の版へ戻す。アプリ本体の版が変わったら、取得した画面は消す。
 * デスクトップ版の apps/desktop/src-tauri/src/web_bundle.rs と同じ考え方。
 */
final class WebBundles {

    /** アプリ側の機能の版。apps/web/app-update.json の minNativeApi と合わせる。 */
    static final int NATIVE_API = 1;

    // Capacitor (com.getcapacitor.plugin.WebView) が読む設定の名前。
    private static final String CAP_PREFS = "CapWebViewSettings";
    private static final String CAP_SERVER_PATH = "serverBasePath";
    private static final String STATE_FILE = "state.json";

    /** この起動で配信している版。null は同梱の画面。 */
    private static volatile String serving = null;

    static final class State {
        String nativeVersion = "";
        String current;
        String pending;
        String trying;
        List<String> bad = new ArrayList<>();

        JSONObject toJson() throws JSONException {
            JSONObject json = new JSONObject();
            json.put("native", nativeVersion);
            json.put("current", current == null ? JSONObject.NULL : current);
            json.put("pending", pending == null ? JSONObject.NULL : pending);
            json.put("trying", trying == null ? JSONObject.NULL : trying);
            json.put("bad", new JSONArray(bad));
            return json;
        }

        static State fromJson(JSONObject json) {
            State state = new State();
            state.nativeVersion = json.optString("native", "");
            state.current = optString(json, "current");
            state.pending = optString(json, "pending");
            state.trying = optString(json, "trying");
            JSONArray bad = json.optJSONArray("bad");
            if (bad != null) {
                for (int i = 0; i < bad.length(); i++) {
                    String version = bad.optString(i, null);
                    if (version != null) state.bad.add(version);
                }
            }
            return state;
        }

        private static String optString(JSONObject json, String key) {
            if (json.isNull(key)) return null;
            String value = json.optString(key, "");
            return value.isEmpty() ? null : value;
        }
    }

    private WebBundles() {}

    static boolean isVersion(String value) {
        return value != null && value.matches("\\d{14}");
    }

    /** 一覧のパス ("/" で始まり、"." や ".." を含まない) か。 */
    static boolean isSafePath(String path) {
        if (path == null || !path.startsWith("/") || path.length() > 512) return false;
        if (!path.matches("[A-Za-z0-9._\\-/@+~%()\\[\\]]+")) return false;
        String[] parts = path.substring(1).split("/", -1);
        for (String part : parts) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        }
        return true;
    }

    static File root(Context context) {
        return new File(context.getFilesDir(), "web-bundle");
    }

    static File dir(Context context, String version) {
        return new File(root(context), version);
    }

    static String serving() {
        return serving;
    }

    /** アプリ本体の版 (versionName と versionCode)。変わったら取得した画面を消す。 */
    static String nativeVersion(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
            return info.versionName + "+" + code;
        } catch (Exception e) {
            return "";
        }
    }

    static String versionName(Context context) {
        try {
            String name = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
            return name == null ? "" : name;
        } catch (Exception e) {
            return "";
        }
    }

    static synchronized State load(Context context) {
        File file = new File(root(context), STATE_FILE);
        try {
            byte[] bytes;
            try (InputStream in = new FileInputStream(file)) {
                bytes = readAll(in, 1024 * 1024);
            }
            return State.fromJson(new JSONObject(new String(bytes, StandardCharsets.UTF_8)));
        } catch (Exception e) {
            return new State();
        }
    }

    static synchronized void save(Context context, State state) throws IOException {
        File root = root(context);
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("フォルダを作れません: " + root);
        File temp = new File(root, STATE_FILE + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(state.toJson().toString().getBytes(StandardCharsets.UTF_8));
        } catch (JSONException e) {
            throw new IOException(e);
        }
        File target = new File(root, STATE_FILE);
        if (!temp.renameTo(target)) throw new IOException("保存できません: " + target);
    }

    private static boolean exists(Context context, String version) {
        return isVersion(version) && new File(dir(context, version), "index.html").isFile();
    }

    /** 起動するときに、どの版を配信するか決める。null は同梱の画面。 */
    static String select(State state, String nativeVersion, java.util.function.Predicate<String> exists) {
        if (!nativeVersion.equals(state.nativeVersion)) {
            state.nativeVersion = nativeVersion;
            state.current = null;
            state.pending = null;
            state.trying = null;
            state.bad.clear();
            return null;
        }
        // 前回試した版が、問題なく起動したと伝えられないまま終わった。
        if (state.trying != null) {
            if (!state.bad.contains(state.trying)) state.bad.add(state.trying);
            state.trying = null;
        }
        if (state.pending != null) {
            String next = state.pending;
            state.pending = null;
            if (exists.test(next)) {
                state.trying = next;
                return next;
            }
        }
        if (state.current != null && exists.test(state.current)) return state.current;
        state.current = null;
        return null;
    }

    /**
     * 画面を作る前 (MainActivity.onCreate の super より前) に呼ぶ。
     * 使う版を決めて、Capacitor の設定に書く。
     */
    static void prepare(Context context) {
        State state = load(context);
        String chosen = select(state, nativeVersion(context), version -> exists(context, version));
        serving = chosen;
        try {
            save(context, state);
        } catch (IOException e) {
            // 保存できなくても、この起動は決めた版で開く。
        }
        clean(context, state);
        setServerPath(context, chosen);
    }

    /** Capacitor が次に起動したときに読む、画面の置き場を書く。null で同梱の画面。 */
    static void setServerPath(Context context, String version) {
        SharedPreferences prefs = context.getSharedPreferences(CAP_PREFS, Activity.MODE_PRIVATE);
        String path = version == null ? "" : dir(context, version).getAbsolutePath();
        prefs.edit().putString(CAP_SERVER_PATH, path).apply();
    }

    static void markServing(String version) {
        serving = version;
    }

    /** 記録に無い版のフォルダ (古い版、取得の途中で止まったもの) を消す。 */
    static void clean(Context context, State state) {
        Set<String> keep = new HashSet<>();
        for (String version : new String[] { state.current, state.pending, state.trying, serving }) {
            if (version != null) keep.add(version);
        }
        File[] entries = root(context).listFiles();
        if (entries == null) return;
        for (File entry : entries) {
            if (entry.isDirectory() && !keep.contains(entry.getName())) deleteRecursively(entry);
        }
    }

    static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    /** 上限 (バイト) までを読み切る。超えたら IOException。 */
    static byte[] readAll(InputStream in, long limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        int read;
        while ((read = in.read(buffer)) != -1) {
            total += read;
            if (total > limit) throw new IOException("大きすぎます");
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }

    static String sha256(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
