package jp.lunaproject.orbit.mail;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * メールの添付ファイルを「端末に保存する」「別のアプリで開く」ための一時ファイル (AppShellPlugin から使う)。
 * WebView は blob の URL の &lt;a download&gt; を保存できず、PDF も表示できない。そこで画面は中身を
 * 小分けの base64 で渡し (beginFile → appendFile …)、ここでキャッシュの一時ファイルに組み立てる。
 * 置き場所は getCacheDir()/attachments/&lt;id&gt;/。キャッシュなので、容量が足りなければ Android も消せる。
 */
final class AttachmentFiles {

    private AttachmentFiles() {}

    /** 一時ファイルを残しておく長さ。外部アプリで開いたファイルは、相手が読み終わるまで消せないので残す。 */
    private static final long KEEP_MS = 24L * 60 * 60 * 1000;
    /** 1 つの添付の上限。画面の不具合などで端末の容量を使い切らないように。 */
    static final long MAX_BYTES = 256L * 1024 * 1024;
    /** id は beginFile が作る UUID だけ。画面から来た値でパスを作るので、形を必ず確かめる (パスの横断を防ぐ)。 */
    private static final Pattern ID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    /** type/subtype の形。normalizeMimeType で小文字にし、;charset= などの付け足しを外したあとに確かめる。 */
    private static final Pattern MIME = Pattern.compile("[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}");
    private static final String FALLBACK_MIME = "application/octet-stream";
    private static final String FALLBACK_NAME = "attachment";
    /** ファイル名の長さの上限。ファイルシステムの上限 (多くは 255 バイト) より十分に短くする。 */
    private static final int MAX_NAME_CHARS = 120;
    private static final int MAX_NAME_BYTES = 200;
    /** 拡張子として残す長さの上限 (長い名前を切り詰めるときに、拡張子は残すため)。 */
    private static final int MAX_EXTENSION_CHARS = 16;
    private static final String DATA = "data";

    /** 画面にそのまま見せてよい、日本語の短い説明つきの失敗。 */
    static final class FileError extends IOException {
        FileError(String message) {
            super(message);
        }
    }

    static File root(Context context) {
        return new File(context.getCacheDir(), "attachments");
    }

    /** 空の一時ファイルを作って、その id を返す。ついでに 24 時間より古いものを消す。 */
    static String begin(Context context) throws IOException {
        cleanOld(context);
        String id = UUID.randomUUID().toString();
        File dir = new File(root(context), id);
        if (!dir.mkdirs()) throw new FileError("一時ファイルを作れませんでした。");
        File data = new File(dir, DATA);
        if (!data.createNewFile()) throw new FileError("一時ファイルを作れませんでした。");
        return id;
    }

    /** base64 の中身を一時ファイルの後ろに足す。 */
    static void append(Context context, String id, String base64) throws IOException {
        File data = dataFile(context, id);
        byte[] bytes;
        try {
            bytes = Base64.decode(base64 == null ? "" : base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            throw new FileError("ファイルの中身が正しくありません。");
        }
        if (data.length() + bytes.length > MAX_BYTES) {
            discard(context, id);
            throw new FileError("ファイルが大きすぎます。");
        }
        try (FileOutputStream out = new FileOutputStream(data, true)) {
            out.write(bytes);
        }
    }

    /** 一時ファイルを、利用者が選んだ保存先 (ACTION_CREATE_DOCUMENT で得た Uri) へ書き写す。 */
    static void copyTo(Context context, String id, Uri target) throws IOException {
        File data = dataFile(context, id);
        try (InputStream in = new FileInputStream(data);
                OutputStream out = context.getContentResolver().openOutputStream(target, "w")) {
            if (out == null) throw new FileError("保存先を開けませんでした。");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        }
    }

    /**
     * 一時ファイルを、添付の名前に改名して返す。開いた先のアプリは、Uri の最後の部分を
     * ファイル名として表示したり拡張子で種類を判断したりするので、data のままにしない。
     */
    static File rename(Context context, String id, String safeName) throws IOException {
        File data = dataFile(context, id);
        File named = new File(data.getParentFile(), safeName);
        if (named.equals(data)) return data;
        if (!data.renameTo(named)) throw new FileError("一時ファイルの名前を変えられませんでした。");
        return named;
    }

    /** 一時ファイルを消す。id の形が正しくなければ何もしない。 */
    static void discard(Context context, String id) {
        if (!isId(id)) return;
        WebBundles.deleteRecursively(new File(root(context), id));
    }

    /** 組み立て中の一時ファイルがあるか (保存や改名をする前の確認)。 */
    static boolean exists(Context context, String id) {
        return isId(id) && new File(new File(root(context), id), DATA).isFile();
    }

    static boolean isId(String id) {
        return id != null && ID.matcher(id).matches();
    }

    private static File dataFile(Context context, String id) throws IOException {
        if (!isId(id)) throw new FileError("ファイルの指定が正しくありません。");
        File data = new File(new File(root(context), id), DATA);
        if (!data.isFile()) throw new FileError("一時ファイルが見つかりません。");
        return data;
    }

    /**
     * 24 時間より古いものを消す。外部アプリで開いたファイルは開いた時点では消せない
     * (相手がまだ読んでいるかもしれない) ので、次に添付を扱うときにここで片付ける。
     */
    private static void cleanOld(Context context) {
        File[] children = root(context).listFiles();
        if (children == null) return;
        long cutoff = System.currentTimeMillis() - KEEP_MS;
        for (File child : children) {
            if (newest(child) < cutoff) WebBundles.deleteRecursively(child);
        }
    }

    /** フォルダの中でいちばん新しい更新時刻 (追記中のファイルを消さないように、中身も見る)。 */
    private static long newest(File file) {
        long time = file.lastModified();
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) time = Math.max(time, child.lastModified());
        }
        return time;
    }

    /** 種類 (MIME タイプ) が空や不正なら application/octet-stream にする。 */
    static String safeMimeType(String mimeType) {
        if (mimeType == null) return FALLBACK_MIME;
        String normalized = Intent.normalizeMimeType(mimeType.trim());
        if (normalized == null || !MIME.matcher(normalized).matches()) return FALLBACK_MIME;
        return normalized;
    }

    /**
     * 添付の名前は差出人が自由に決められるので、そのままファイル名に使わない。
     * パス区切りや Windows で使えない文字、制御文字、見た目を偽れる書式文字 (右から左への切り替えなど) を除き、
     * 先頭のドット (隠しファイルや ".." になる) と前後の空白を外す。長すぎれば拡張子を残して切り詰める。
     */
    static String safeFileName(String name) {
        if (name == null) return FALLBACK_NAME;
        StringBuilder builder = new StringBuilder();
        name.codePoints().forEach(c -> {
            if (c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|') {
                builder.append('_');
            } else if (Character.isISOControl(c)
                    || Character.getType(c) == Character.FORMAT
                    || Character.getType(c) == Character.LINE_SEPARATOR
                    || Character.getType(c) == Character.PARAGRAPH_SEPARATOR) {
                // 除く。
            } else {
                builder.appendCodePoint(c);
            }
        });
        String cleaned = trimDotsAndSpaces(builder.toString());
        if (cleaned.isEmpty()) return FALLBACK_NAME;
        if (fits(cleaned)) return cleaned;

        // 長すぎる。拡張子 (短いものだけ) を残して、名前の部分を切り詰める。
        String base = cleaned;
        String extension = "";
        int dot = cleaned.lastIndexOf('.');
        if (dot > 0 && cleaned.codePointCount(dot, cleaned.length()) <= MAX_EXTENSION_CHARS + 1) {
            base = cleaned.substring(0, dot);
            extension = cleaned.substring(dot);
        }
        int[] points = base.codePoints().toArray();
        int length = Math.min(points.length, MAX_NAME_CHARS);
        while (length > 0) {
            String trimmed = trimDotsAndSpaces(new String(points, 0, length));
            String candidate = (trimmed.isEmpty() ? FALLBACK_NAME : trimmed) + extension;
            if (fits(candidate)) return candidate;
            length--;
        }
        return FALLBACK_NAME;
    }

    private static boolean fits(String name) {
        return name.codePointCount(0, name.length()) <= MAX_NAME_CHARS
                && name.getBytes(StandardCharsets.UTF_8).length <= MAX_NAME_BYTES;
    }

    private static String trimDotsAndSpaces(String text) {
        int start = 0;
        int end = text.length();
        while (start < end && (text.charAt(start) == '.' || Character.isWhitespace(text.charAt(start)))) start++;
        // 末尾のドットと空白も外す (Windows へ移したときに扱えない名前になるため)。
        while (end > start && (text.charAt(end - 1) == '.' || Character.isWhitespace(text.charAt(end - 1)))) end--;
        return text.substring(start, end);
    }
}
