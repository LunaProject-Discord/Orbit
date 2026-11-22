package jp.lunaproject.orbit.mail;

import android.graphics.fonts.Font;
import android.graphics.fonts.SystemFonts;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 端末に入っているフォントの一覧。設定画面で、ゴシック体・明朝体・等幅などに使うフォントを選ぶために使う。
 *
 * Android には「フォントの名前の一覧」を返す仕組みが無いので、フォントのファイルを開いて名前を読む。
 * WebView は端末のフォントを名前では指定できないことが多いため、画面側はここで返すファイルのパスを
 * @font-face で読み込んで使う (ファイルは Capacitor の _capacitor_file_ の URL で配信される)。
 */
final class FontCatalog {

    private static final int TAG_TTCF = 0x74746366;
    private static final int TAG_NAME = 0x6e616d65;
    private static final int TAG_OS2 = 0x4f532f32;
    private static final int TAG_POST = 0x706f7374;
    private static final int TAG_FVAR = 0x66766172;
    private static final int TAG_WGHT = 0x77676874;
    /** 名前のテーブルとして読む大きさの上限 (壊れたファイルで大量のメモリを使わない)。 */
    private static final int MAX_NAME_TABLE = 1 << 20;

    private FontCatalog() {}

    /** フォントのファイル 1 つから読み取った内容。 */
    static final class Face {

        String path;
        /** CSS に書く名前 (英語の名前)。 */
        String family;
        /** 日本語の名前 (無ければ null)。 */
        String japaneseName;
        boolean monospace;
        boolean italic;
        int weightMin = 400;
        int weightMax = 400;
    }

    /** 端末のフォントを調べ、名前ごとにまとめて返す (名前順)。 */
    static JSArray list() {
        Map<String, List<Face>> families = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        for (String path : fontFiles()) {
            Face face;
            try {
                face = read(path);
            } catch (IOException | RuntimeException error) {
                // 読めないファイルや、形の合わないファイルは飛ばす。
                continue;
            }
            if (face == null) continue;
            List<Face> faces = families.get(face.family);
            if (faces == null) {
                faces = new ArrayList<>();
                families.put(face.family, faces);
            }
            faces.add(face);
        }

        JSArray result = new JSArray();
        for (Map.Entry<String, List<Face>> entry : families.entrySet()) {
            List<Face> faces = entry.getValue();
            String label = null;
            boolean monospace = false;
            JSArray files = new JSArray();
            for (Face face : faces) {
                if (label == null) label = face.japaneseName;
                monospace |= face.monospace;
                JSObject file = new JSObject();
                file.put("path", face.path);
                file.put("weightMin", face.weightMin);
                file.put("weightMax", face.weightMax);
                file.put("italic", face.italic);
                files.put(file);
            }
            String family = faces.get(0).family;
            JSObject item = new JSObject();
            item.put("family", family);
            item.put("label", label != null ? label : family);
            item.put("monospace", monospace);
            item.put("faces", files);
            result.put(item);
        }
        return result;
    }

    /** 端末のフォントのファイル。Android 10 以降は OS に尋ね、それより前は決まった場所を見る。 */
    private static TreeSet<String> fontFiles() {
        TreeSet<String> paths = new TreeSet<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            for (Font font : SystemFonts.getAvailableFonts()) {
                File file = font.getFile();
                if (file != null) paths.add(file.getAbsolutePath());
            }
        }
        if (paths.isEmpty()) {
            File[] files = new File("/system/fonts").listFiles();
            if (files != null) {
                for (File file : files) {
                    String name = file.getName().toLowerCase(java.util.Locale.ROOT);
                    if (name.endsWith(".ttf") || name.endsWith(".otf") || name.endsWith(".ttc")) {
                        paths.add(file.getAbsolutePath());
                    }
                }
            }
        }
        return paths;
    }

    /**
     * フォントのファイルを読む。複数のフォントをまとめたファイル (.ttc) は、先頭のフォントだけを読む
     * (WebView が @font-face で読み込めるのは先頭のフォントだけ)。
     */
    static Face read(String path) throws IOException {
        // パスは画面側で CSS の URL に入れるので、決まった文字だけのものに限る。
        if (!path.matches("/[A-Za-z0-9_./-]+") || path.contains("..")) return null;
        try (RandomAccessFile file = new RandomAccessFile(path, "r")) {
            long start = 0;
            if (file.readInt() == TAG_TTCF) {
                file.skipBytes(4);
                if (file.readInt() < 1) return null;
                start = file.readInt() & 0xffffffffL;
            }
            file.seek(start + 4);
            int tables = file.readUnsignedShort();
            file.skipBytes(6);
            long name = -1;
            long nameLength = 0;
            long os2 = -1;
            long post = -1;
            long fvar = -1;
            for (int i = 0; i < tables; i++) {
                int tag = file.readInt();
                file.skipBytes(4);
                long offset = file.readInt() & 0xffffffffL;
                long length = file.readInt() & 0xffffffffL;
                if (tag == TAG_NAME) {
                    name = offset;
                    nameLength = length;
                } else if (tag == TAG_OS2) {
                    os2 = offset;
                } else if (tag == TAG_POST) {
                    post = offset;
                } else if (tag == TAG_FVAR) {
                    fvar = offset;
                }
            }
            if (name < 0 || nameLength < 6 || nameLength > MAX_NAME_TABLE) return null;

            Face face = new Face();
            face.path = path;
            byte[] names = new byte[(int) nameLength];
            file.seek(name);
            file.readFully(names);
            readNames(names, face);
            // 名前が . で始まるのは OS の内部用のフォント。
            if (face.family == null || face.family.isEmpty() || face.family.startsWith(".")) return null;

            if (os2 >= 0) {
                file.seek(os2 + 4);
                int weight = file.readUnsignedShort();
                if (weight >= 1 && weight <= 1000) {
                    face.weightMin = weight;
                    face.weightMax = weight;
                }
                file.seek(os2 + 62);
                face.italic = (file.readUnsignedShort() & 1) != 0;
            }
            if (post >= 0) {
                file.seek(post + 12);
                face.monospace = file.readInt() != 0;
            }
            if (fvar >= 0) readWeightAxis(file, fvar, face);
            return face;
        }
    }

    /** 名前のテーブルから、フォントの名前 (英語と日本語) を読む。 */
    private static void readNames(byte[] table, Face face) {
        int count = u16(table, 2);
        int strings = u16(table, 4);
        // 優先順位: 書体としての名前 (ID 16) > ふつうの名前 (ID 1)。
        int englishRank = 0;
        int japaneseRank = 0;
        for (int i = 0; i < count; i++) {
            int record = 6 + i * 12;
            if (record + 12 > table.length) break;
            int platform = u16(table, record);
            int encoding = u16(table, record + 2);
            int language = u16(table, record + 4);
            int id = u16(table, record + 6);
            int length = u16(table, record + 8);
            int offset = strings + u16(table, record + 10);
            if (id != 1 && id != 16) continue;
            if (offset + length > table.length) continue;
            int rank = id == 16 ? 2 : 1;

            Charset charset;
            boolean english;
            boolean japanese = false;
            if (platform == 3 && (encoding == 1 || encoding == 10)) {
                charset = encoding == 1 ? StandardCharsets.UTF_16BE : Charset.forName("UTF-32BE");
                english = language == 0x0409;
                japanese = language == 0x0411;
            } else if (platform == 0) {
                charset = StandardCharsets.UTF_16BE;
                english = true;
            } else if (platform == 1 && encoding == 0) {
                charset = StandardCharsets.ISO_8859_1;
                english = language == 0;
            } else {
                continue;
            }
            if (!english && !japanese) continue;
            String value = new String(table, offset, length, charset).trim();
            if (value.isEmpty()) continue;
            if (english && rank > englishRank) {
                face.family = value;
                englishRank = rank;
            } else if (japanese && rank > japaneseRank) {
                face.japaneseName = value;
                japaneseRank = rank;
            }
        }
    }

    /** 太さを変えられるフォント (バリアブルフォント) なら、使える太さの範囲を読む。 */
    private static void readWeightAxis(RandomAccessFile file, long fvar, Face face) throws IOException {
        file.seek(fvar + 4);
        int axes = file.readUnsignedShort();
        file.skipBytes(2);
        int count = file.readUnsignedShort();
        int size = file.readUnsignedShort();
        if (size < 20) return;
        for (int i = 0; i < count && i < 64; i++) {
            file.seek(fvar + axes + (long) i * size);
            if (file.readInt() != TAG_WGHT) continue;
            // 値は 16.16 の固定小数点。
            int min = file.readInt() >> 16;
            file.skipBytes(4);
            int max = file.readInt() >> 16;
            if (min >= 1 && max <= 1000 && min <= max) {
                face.weightMin = min;
                face.weightMax = max;
            }
            return;
        }
    }

    private static int u16(byte[] data, int offset) {
        return ((data[offset] & 0xff) << 8) | (data[offset + 1] & 0xff);
    }
}
