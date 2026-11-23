package jp.lunaproject.orbit.mail;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Process;

/**
 * このアプリの接続先サーバーとログインを、ほかの Orbit のアプリへ公開する窓口 (読み取り専用)。
 * 読めるのは、同じ鍵で署名したアプリだけ。AndroidManifest.xml の権限 (signature) に加えて、
 * ここでも呼び出し元の署名を確かめる。しくみは SharedConfig を参照。
 */
public class SharedConfigProvider extends ContentProvider {

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        Context context = getContext();
        if (context == null) return null;
        int caller = Binder.getCallingUid();
        if (
            caller != Process.myUid() &&
            context.getPackageManager().checkSignatures(caller, Process.myUid()) != PackageManager.SIGNATURE_MATCH
        ) {
            throw new SecurityException("署名の違うアプリには公開しません。");
        }
        SharedConfig config = SharedConfig.load(context);
        MatrixCursor cursor = new MatrixCursor(SharedConfig.COLUMNS, 1);
        cursor.addRow(new Object[] { config.serverUrl, config.sessionToken, config.updatedAt });
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return "vnd.android.cursor.item/vnd.jp.lunaproject.orbit.shared-config";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }
}
