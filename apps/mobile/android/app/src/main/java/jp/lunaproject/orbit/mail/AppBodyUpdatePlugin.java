package jp.lunaproject.orbit.mail;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.InstallSourceInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
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
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * アプリ本体の自動更新 (docs/updates.md)。接続先のサーバーが配る APK を取得して、OS のインストーラーで入れ替える。
 * - 入れ替えのたびに OS の確認が出る (Android の仕様)。初回は「この提供元のアプリを許可」も要る。
 * - Google Play から入れたアプリでは使わない (Play の規約で、Play 以外からの自己更新は禁止されている)。
 * - APK は、サーバーが示した SHA-256、このアプリと同じパッケージ名・同じ署名、より新しい versionCode であることを
 *   確かめてから入れる (署名が違えば OS も入れ替えを拒むが、先に分かりやすく断る)。
 */
@CapacitorPlugin(name = "AppBodyUpdate")
public class AppBodyUpdatePlugin extends Plugin {

    private static final long MAX_APK_BYTES = 300L * 1024 * 1024;
    private static final String PLAY_STORE = "com.android.vending";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean(false);

    private static long currentVersionCode(Context context) throws PackageManager.NameNotFoundException {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    @SuppressWarnings("deprecation")
    private static String installer(Context context) {
        PackageManager pm = context.getPackageManager();
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                InstallSourceInfo source = pm.getInstallSourceInfo(context.getPackageName());
                return source.getInstallingPackageName();
            }
            return pm.getInstallerPackageName(context.getPackageName());
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean canInstall(Context context) {
        return Build.VERSION.SDK_INT < 26 || context.getPackageManager().canRequestPackageInstalls();
    }

    private static File apkFile(Context context, long versionCode) {
        return new File(new File(context.getCacheDir(), "app-body-update"), versionCode + ".apk");
    }

    @PluginMethod
    public void info(PluginCall call) {
        Context context = getContext();
        try {
            JSObject result = new JSObject();
            result.put("versionCode", currentVersionCode(context));
            result.put("versionName", WebBundles.versionName(context));
            result.put("fromPlayStore", PLAY_STORE.equals(installer(context)));
            result.put("canInstall", canInstall(context));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("アプリの情報を読めません。");
        }
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    @SuppressWarnings("deprecation")
    private static Set<String> signers(PackageInfo info) throws Exception {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= 28) {
            if (info.signingInfo == null) return new HashSet<>();
            signatures = info.signingInfo.hasMultipleSigners()
                ? info.signingInfo.getApkContentsSigners()
                : info.signingInfo.getSigningCertificateHistory();
        } else {
            signatures = info.signatures;
        }
        Set<String> result = new HashSet<>();
        if (signatures == null) return result;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (Signature signature : signatures) {
            result.add(Arrays.toString(digest.digest(signature.toByteArray())));
        }
        return result;
    }

    @SuppressWarnings("deprecation")
    private static void verifyApk(Context context, File file, long expectedCode) throws Exception {
        PackageManager pm = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = pm.getPackageArchiveInfo(file.getPath(), flags);
        if (archive == null) throw new IOException("APK を読めません。");
        if (!context.getPackageName().equals(archive.packageName)) throw new IOException("別のアプリの APK です。");
        long code = Build.VERSION.SDK_INT >= 28 ? archive.getLongVersionCode() : archive.versionCode;
        if (code != expectedCode) throw new IOException("APK の版がサーバーの情報と一致しません。");
        if (code <= currentVersionCode(context)) throw new IOException("いまのアプリより新しくありません。");
        PackageInfo installed = pm.getPackageInfo(context.getPackageName(), flags);
        Set<String> mine = signers(installed);
        Set<String> theirs = signers(archive);
        // 署名の鍵を引き継いだ (鍵の更新をした) 場合は、新しい APK の履歴にいまの鍵が含まれる。
        boolean match = !mine.isEmpty() && !theirs.isEmpty() && (theirs.containsAll(mine) || mine.containsAll(theirs));
        if (!match) {
            throw new IOException("APK の署名がいまのアプリと違うので入れ替えられません (配布用の鍵で署名した APK が必要です)。");
        }
    }

    /** https だけ (同じ端末での確認用に、localhost の http は許す)。 */
    private static URL allowedUrl(String text) throws IOException {
        URL url = new URL(text);
        String host = url.getHost();
        boolean local = "localhost".equals(host) || "127.0.0.1".equals(host);
        if ("https".equals(url.getProtocol()) || ("http".equals(url.getProtocol()) && local)) return url;
        throw new IOException("https の URL だけを使えます。");
    }

    /** APK を取得して確かめる。取得済みで中身が正しければ取り直さない。 */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url", "");
        String expectedSha = call.getString("sha256", "");
        Long versionCode = call.getLong("versionCode");
        if (versionCode == null || !expectedSha.matches("[0-9a-f]{64}")) {
            call.reject("更新の情報が正しくありません。");
            return;
        }
        if (PLAY_STORE.equals(installer(getContext()))) {
            call.reject("Google Play から入れたアプリは、Google Play で更新してください。");
            return;
        }
        if (!busy.compareAndSet(false, true)) {
            call.reject("ほかの取得が進んでいます。");
            return;
        }
        Context context = getContext();
        executor.execute(() -> {
            File file = apkFile(context, versionCode);
            File temp = new File(file.getPath() + ".part");
            try {
                if (!(file.isFile() && sha256(file).equals(expectedSha))) {
                    File dir = file.getParentFile();
                    if (dir != null) {
                        // 古い版の APK は消す。
                        File[] old = dir.listFiles();
                        if (old != null) for (File f : old) f.delete();
                        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("保存先を作れません。");
                    }
                    HttpURLConnection connection = (HttpURLConnection) allowedUrl(url).openConnection();
                    connection.setConnectTimeout(15_000);
                    connection.setReadTimeout(60_000);
                    try {
                        int status = connection.getResponseCode();
                        if (status < 200 || status >= 300) throw new IOException("APK を取得できません (" + status + ")。");
                        long total = 0;
                        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(temp)) {
                            byte[] buffer = new byte[64 * 1024];
                            int read;
                            while ((read = in.read(buffer)) != -1) {
                                total += read;
                                if (total > MAX_APK_BYTES) throw new IOException("APK が大きすぎます。");
                                out.write(buffer, 0, read);
                            }
                        }
                    } finally {
                        connection.disconnect();
                    }
                    if (!sha256(temp).equals(expectedSha)) throw new IOException("APK の中身がサーバーの情報と一致しません。");
                    if (!temp.renameTo(file)) throw new IOException("APK を保存できません。");
                }
                verifyApk(context, file, versionCode);
                call.resolve();
            } catch (Exception e) {
                temp.delete();
                call.reject(e.getMessage() == null ? "APK を取得できませんでした。" : e.getMessage());
            } finally {
                busy.set(false);
            }
        });
    }

    /**
     * 取得済みの APK を入れる。OS の確認画面が出る。
     * 「この提供元のアプリを許可」がまだなら設定の画面を開き、status: "permission" を返す (許可してからもう一度呼ぶ)。
     */
    @PluginMethod
    public void install(PluginCall call) {
        Context context = getContext();
        Long versionCode = call.getLong("versionCode");
        if (versionCode == null) {
            call.reject("更新の情報が正しくありません。");
            return;
        }
        File file = apkFile(context, versionCode);
        if (!file.isFile()) {
            call.reject("先に APK を取得してください。");
            return;
        }
        if (!canInstall(context)) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            JSObject result = new JSObject();
            result.put("status", "permission");
            call.resolve(result);
            return;
        }
        executor.execute(() -> {
            PackageInstaller.Session session = null;
            try {
                verifyApk(context, file, versionCode);
                PackageInstaller packageInstaller = context.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(context.getPackageName());
                if (Build.VERSION.SDK_INT >= 31) {
                    // このアプリ自身が前に入れた場合は、OS が確認を省けることがある (省けなければ確認が出る)。
                    params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                }
                int id = packageInstaller.createSession(params);
                session = packageInstaller.openSession(id);
                try (InputStream in = new FileInputStream(file); OutputStream out = session.openWrite("base.apk", 0, file.length())) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                    session.fsync(out);
                }
                Intent intent = new Intent(context, AppBodyInstallReceiver.class);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                PendingIntent pending = PendingIntent.getBroadcast(context, id, intent, flags);
                session.commit(pending.getIntentSender());
                session.close();
                session = null;
                JSObject result = new JSObject();
                result.put("status", "started");
                call.resolve(result);
            } catch (Exception e) {
                if (session != null) session.abandon();
                call.reject(e.getMessage() == null ? "入れ替えを始められませんでした。" : e.getMessage());
            }
        });
    }
}
