package jp.lunaproject.orbit.mail;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import androidx.core.app.RemoteInput;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;

/**
 * 通知のボタン (既読にする、アーカイブなど) が押されたときと、返信欄から送ったときの処理。
 * アプリを開かずに、サーバーへ操作や返信を送る。ログインの情報は使わず、
 * 通知に付いていた合言葉 (そのメール 1 通だけを操作できる) で操作する。
 */
public class NotificationActionReceiver extends BroadcastReceiver {

    static final String ACTION = "jp.lunaproject.orbit.mail.NOTIFICATION_ACTION";
    static final String ACTION_REPLY = "jp.lunaproject.orbit.mail.NOTIFICATION_REPLY";
    /** 返信欄に書いた文章の受け取り口の名前。 */
    static final String KEY_REPLY_TEXT = "replyText";
    /** 返信を受け付ける送り先は、ボタンの送り先の後ろにこれを付けたもの (サーバーの NOTIFICATION_REPLY_PATH)。 */
    private static final String REPLY_PATH_SUFFIX = "/reply";
    static final String EXTRA_TAG = "tag";
    static final String EXTRA_MESSAGE_ID = "messageId";
    static final String EXTRA_ACTION = "action";
    static final String EXTRA_URL = "url";
    static final String EXTRA_TOKEN = "token";
    static final String EXTRA_TITLE = "title";

    /** 合言葉を送ってよい受け口のパス (API の URL のパスの後ろ。サーバーの NOTIFICATION_ACTION_PATH)。 */
    static final String ACTION_PATH = "/v1/notification-actions";

    /** 通知のボタンの処理に使える時間は短いので、通信は早めに打ち切る。 */
    private static final int TIMEOUT_MS = 8000;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (ACTION_REPLY.equals(intent.getAction())) {
            onReply(context, intent);
            return;
        }
        if (!ACTION.equals(intent.getAction())) return;
        final String tag = intent.getStringExtra(EXTRA_TAG);
        final String messageId = intent.getStringExtra(EXTRA_MESSAGE_ID);
        final String action = intent.getStringExtra(EXTRA_ACTION);
        final String url = intent.getStringExtra(EXTRA_URL);
        final String token = intent.getStringExtra(EXTRA_TOKEN);
        final String title = intent.getStringExtra(EXTRA_TITLE);
        if (tag == null || messageId == null || action == null || url == null || token == null) return;
        // 自分の API の受け口でなければ送らない (通知を作るときにも確かめている)。
        if (!allowedUrl(context, url)) return;

        // 押したらすぐに通知を片付ける。送れなかったときは、改めて知らせる。
        MailNotifications.cancel(context, tag);
        final Context app = context.getApplicationContext();
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                if (!send(url, messageId, action, token)) {
                    MailNotifications.showFailure(app, tag, messageId, title);
                }
            } finally {
                pending.finish();
            }
        })
            .start();
    }

    /** 返信欄から送られた文章を、サーバーへ返信として届ける。 */
    private void onReply(Context context, Intent intent) {
        final String tag = intent.getStringExtra(EXTRA_TAG);
        final String messageId = intent.getStringExtra(EXTRA_MESSAGE_ID);
        final String url = intent.getStringExtra(EXTRA_URL);
        final String token = intent.getStringExtra(EXTRA_TOKEN);
        final String title = intent.getStringExtra(EXTRA_TITLE);
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence input = results == null ? null : results.getCharSequence(KEY_REPLY_TEXT);
        final String text = input == null ? "" : input.toString();
        if (tag == null || messageId == null || url == null || token == null) return;
        // 自分の API の受け口でなければ送らない。返信の送り先は、確かめた送り先 + "/reply"。
        if (!allowedUrl(context, url)) return;
        // Android は空のままでは送れないが、念のため何も書かれていなければ送らない。
        if (text.trim().isEmpty()) return;

        // 送ったらすぐに通知を片付ける (入力欄の「送信中」の表示を残さない)。送れなかったときは、改めて知らせる。
        MailNotifications.cancel(context, tag);
        final Context app = context.getApplicationContext();
        final PendingResult pending = goAsync();
        // 同じ返信を二重に送らないための ID (サーバーは同じ ID の返信を 1 回だけ送る)。
        final String idempotencyKey = UUID.randomUUID().toString();
        new Thread(() -> {
            try {
                if (!sendReply(url + REPLY_PATH_SUFFIX, messageId, token, text, idempotencyKey)) {
                    MailNotifications.showReplyFailure(app, tag, messageId, title, text);
                }
            } finally {
                pending.finish();
            }
        })
            .start();
    }

    /** サーバーへ返信を送る。受け付けられたか。 */
    private static boolean sendReply(String url, String messageId, String token, String text, String idempotencyKey) {
        try {
            JSONObject body = new JSONObject();
            body.put("messageId", messageId);
            body.put("token", token);
            body.put("text", text);
            body.put("idempotencyKey", idempotencyKey);
            int status = post(url, body);
            return status >= 200 && status < 300;
        } catch (Exception e) {
            return false;
        }
    }

    /** サーバーへ操作を送る。受け付けられたか (すでに無いメールも、済んだものとして true)。 */
    private static boolean send(String url, String messageId, String action, String token) {
        try {
            JSONObject body = new JSONObject();
            body.put("messageId", messageId);
            body.put("action", action);
            body.put("token", token);
            int status = post(url, body);
            // 404 は、ほかの端末ですでに削除や移動をしたメール。
            return (status >= 200 && status < 300) || status == 404;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * メールのボタンと返信の送り先として許す URL か。接続先サーバー (SharedConfig.serverUrl) の
     * 「API のパス + /v1/notification-actions」だけ (出欠の EventActionReceiver.allowedUrl と同じ決まり)。
     */
    static boolean allowedUrl(Context context, String url) {
        return allowedUrl(SharedConfig.load(context).serverUrl, url);
    }

    static boolean allowedUrl(String serverUrl, String url) {
        return EventActionReceiver.allowedApiUrl(serverUrl, url, ACTION_PATH);
    }

    /** JSON を POST して、応答の状態コードを返す。つながらなければ例外。https と http だけを受け付ける。 */
    private static int post(String url, JSONObject body) throws Exception {
        URL target = new URL(url);
        String protocol = target.getProtocol();
        if (!"https".equals(protocol) && !"http".equals(protocol)) throw new IllegalArgumentException(protocol);
        HttpURLConnection connection = null;
        try {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);

            connection = (HttpURLConnection) target.openConnection();
            // 転送先へ合言葉を持ち出さない (30x は失敗として扱う)。
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(bytes);
            }
            return connection.getResponseCode();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
