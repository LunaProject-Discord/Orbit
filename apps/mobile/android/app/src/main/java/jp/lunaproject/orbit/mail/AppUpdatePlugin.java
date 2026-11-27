package jp.lunaproject.orbit.mail;

import android.content.Context;
import android.os.SystemClock;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/**
 * 画面の自動更新 (docs/app-update.md) で、画面 (apps/web/src/lib/app-update) から呼ぶ機能。
 * 一覧の署名は画面側が確かめ、ここでは一覧に書かれた SHA-256 とファイルの中身が一致するかを確かめる。
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    private static final int MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
    private static final long MAX_FILE_BYTES = 64L * 1024 * 1024;

    // 取得は時間がかかるので、ほかのプラグインの呼び出しを止めないよう別のスレッドで行う。
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean downloading = new AtomicBoolean(false);
    /** 取得の進み具合を送る間隔。 */
    private static final long PROGRESS_INTERVAL_MS = 100;

    @PluginMethod
    public void info(PluginCall call) {
        Context context = getContext();
        WebBundles.State state = WebBundles.load(context);
        JSObject result = new JSObject();
        result.put("nativeVersion", WebBundles.versionName(context));
        result.put("nativeApi", WebBundles.NATIVE_API);
        String key = BuildConfig.APP_UPDATE_PUBLIC_KEY;
        result.put("publicKey", key == null || key.trim().isEmpty() ? "" : key.trim());
        String serving = WebBundles.serving();
        result.put("running", serving == null ? "" : serving);
        result.put("pending", state.pending == null ? "" : state.pending);
        call.resolve(result);
    }

    /** https だけ (同じ端末での確認用に、localhost の http は許す)。 */
    private static URL allowedUrl(String text) throws IOException {
        URL url = new URL(text);
        String host = url.getHost();
        boolean local = "localhost".equals(host) || "127.0.0.1".equals(host);
        if ("https".equals(url.getProtocol()) || ("http".equals(url.getProtocol()) && local)) return url;
        throw new IOException("https の URL だけを使えます。");
    }

    private static byte[] fetch(URL url, long limit) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(60_000);
        connection.setRequestProperty("Cache-Control", "no-cache");
        connection.setUseCaches(false);
        try {
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IOException(url + ": " + status);
            if (connection.getContentLengthLong() > limit) throw new IOException(url + ": 大きすぎます");
            try (InputStream in = connection.getInputStream()) {
                return WebBundles.readAll(in, limit);
            }
        } finally {
            connection.disconnect();
        }
    }

    @PluginMethod
    public void fetchManifest(PluginCall call) {
        String url = call.getString("url", "");
        executor.execute(() -> {
            try {
                byte[] bytes = fetch(allowedUrl(url), MAX_MANIFEST_BYTES);
                JSObject result = new JSObject();
                result.put("text", new String(bytes, StandardCharsets.UTF_8));
                call.resolve(result);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "一覧を取得できませんでした。" : e.getMessage());
            }
        });
    }

    /** 中身が同じファイルを、同梱の画面か、いま使っている取得済みの画面から探す。 */
    private byte[] reuse(Context context, String path, String sha256) {
        String serving = WebBundles.serving();
        if (serving != null) {
            File file = new File(WebBundles.dir(context, serving), path.substring(1));
            if (file.isFile()) {
                try (InputStream in = new FileInputStream(file)) {
                    byte[] bytes = WebBundles.readAll(in, MAX_FILE_BYTES);
                    if (WebBundles.sha256(bytes).equals(sha256)) return bytes;
                } catch (IOException ignored) {
                    // 読めなければ取得する。
                }
            }
        }
        // Capacitor は apps/web/out をアプリの assets/public に入れている。
        try (InputStream in = context.getAssets().open("public" + path)) {
            byte[] bytes = WebBundles.readAll(in, MAX_FILE_BYTES);
            if (WebBundles.sha256(bytes).equals(sha256)) return bytes;
        } catch (IOException ignored) {
            // 同梱されていなければ取得する。
        }
        return null;
    }

    @PluginMethod
    public void download(PluginCall call) {
        String version = call.getString("version", "");
        String baseUrl = call.getString("baseUrl", "");
        JSArray files = call.getArray("files");
        if (!WebBundles.isVersion(version) || files == null) {
            call.reject("一覧の内容が正しくありません。");
            return;
        }
        if (!downloading.compareAndSet(false, true)) {
            call.reject("ほかの取得が進んでいます。");
            return;
        }
        Context context = getContext();
        executor.execute(() -> {
            File temp = new File(WebBundles.root(context), ".tmp-" + version);
            try {
                WebBundles.State state = WebBundles.load(context);
                if (state.bad.contains(version)) throw new IOException("この版は前に起動できなかったので使いません。");
                if (version.equals(state.pending)) {
                    call.resolve();
                    return;
                }
                // パスは "/" で始まるので、取得元 (末尾は /) からの相対にして組み立てる。
                URL base = allowedUrl(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
                WebBundles.deleteRecursively(temp);
                boolean hasIndex = false;
                // 進み具合 (一覧の大きさの合計に対する、済んだファイルの大きさ) を画面へ送る。
                long total = 0;
                for (int i = 0; i < files.length(); i++) {
                    total += Math.max(0, files.getJSONObject(i).optLong("size", 0));
                }
                long done = 0;
                long lastSent = 0;
                sendProgress(version, 0, total);
                for (int i = 0; i < files.length(); i++) {
                    JSONObject file = files.getJSONObject(i);
                    String path = file.getString("path");
                    String sha256 = file.getString("sha256");
                    long size = file.getLong("size");
                    if (!WebBundles.isSafePath(path) || !sha256.matches("[0-9a-f]{64}") || size > MAX_FILE_BYTES) {
                        throw new IOException(path + ": 一覧の内容が正しくありません");
                    }
                    hasIndex |= "/index.html".equals(path);
                    byte[] bytes = reuse(context, path, sha256);
                    if (bytes == null) {
                        bytes = fetch(new URL(base, path.substring(1)), MAX_FILE_BYTES);
                        if (!WebBundles.sha256(bytes).equals(sha256)) {
                            throw new IOException(path + ": 内容が一覧と一致しません");
                        }
                    }
                    File target = new File(temp, path.substring(1));
                    File parent = target.getParentFile();
                    if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                        throw new IOException("フォルダを作れません: " + parent);
                    }
                    try (FileOutputStream out = new FileOutputStream(target)) {
                        out.write(bytes);
                    }
                    done += Math.max(0, size);
                    long now = SystemClock.elapsedRealtime();
                    if (done >= total || now - lastSent >= PROGRESS_INTERVAL_MS) {
                        lastSent = now;
                        sendProgress(version, done, total);
                    }
                }
                if (!hasIndex) throw new IOException("一覧に index.html がありません。");

                File target = WebBundles.dir(context, version);
                if (!version.equals(WebBundles.serving())) {
                    WebBundles.deleteRecursively(target);
                    if (!temp.renameTo(target)) throw new IOException("保存できません: " + target);
                } else {
                    WebBundles.deleteRecursively(temp);
                }
                state = WebBundles.load(context);
                state.pending = version;
                WebBundles.save(context, state);
                // 次に起動したときに使う (起動時に WebBundles.prepare が試す版として扱う)。
                WebBundles.clean(context, state);
                call.resolve();
            } catch (Exception e) {
                WebBundles.deleteRecursively(temp);
                call.reject(e.getMessage() == null ? "取得できませんでした。" : e.getMessage());
            } finally {
                downloading.set(false);
            }
        });
    }

    /** 取得の進み具合を画面へ送る (apps/web/src/lib/app-update/native.ts の onProgress)。 */
    private void sendProgress(String version, long done, long total) {
        JSObject progress = new JSObject();
        progress.put("version", version);
        progress.put("done", done);
        progress.put("total", total);
        notifyListeners("progress", progress);
    }

    /** 画面が問題なく起動した。試している版なら、これからはその版を使う。 */
    @PluginMethod
    public void ready(PluginCall call) {
        Context context = getContext();
        try {
            WebBundles.State state = WebBundles.load(context);
            String serving = WebBundles.serving();
            if (state.trying != null && state.trying.equals(serving)) {
                state.current = state.trying;
                state.trying = null;
                WebBundles.save(context, state);
                WebBundles.clean(context, state);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** 取得済みの版に、画面を読み込み直して切り替える。 */
    @PluginMethod
    public void apply(PluginCall call) {
        Context context = getContext();
        try {
            WebBundles.State state = WebBundles.load(context);
            String next = state.pending;
            if (next == null || !new File(WebBundles.dir(context, next), "index.html").isFile()) {
                call.reject("切り替える版がありません。");
                return;
            }
            // 起動したときと同じく、試している版として扱う (ready が来なければ次の起動で戻す)。
            state.pending = null;
            state.trying = next;
            WebBundles.save(context, state);
            WebBundles.setServerPath(context, next);
            WebBundles.markServing(next);
            call.resolve();
            getBridge().setServerBasePath(WebBundles.dir(context, next).getAbsolutePath());
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }
}
