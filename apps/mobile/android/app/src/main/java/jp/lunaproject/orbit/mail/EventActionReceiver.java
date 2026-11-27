package jp.lunaproject.orbit.mail;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import org.json.JSONObject;

/**
 * 招待の通知の 参加 / 未定 / 不参加 が押されたときの処理 (設計 2.4)。
 * アプリを開かずに、サーバーの POST /v1/notification-actions/event へ出欠を送る。
 * ログインの情報は使わず、通知に付いていた合言葉 (その利用者のその予定 1 件の出欠だけを
 * 7 日間変えられる。FCM の data の rsvpToken) で操作する。送り先は data の rsvpUrl。
 * 送り先は、このアプリの接続先サーバー (SharedConfig.serverUrl) の
 * POST /v1/notification-actions/event だけを許す (レビュー M4。画面の action-url.ts と同じ決まり)。
 */
public class EventActionReceiver extends BroadcastReceiver {

    static final String ACTION = "jp.lunaproject.orbit.mail.EVENT_ACTION";
    static final String EXTRA_TAG = "tag";
    static final String EXTRA_EVENT_ID = "eventId";
    static final String EXTRA_RECURRENCE_ID = "recurrenceId";
    static final String EXTRA_STATUS = "status";
    static final String EXTRA_URL = "url";
    static final String EXTRA_TOKEN = "token";
    static final String EXTRA_TITLE = "title";

    /**
     * 通知のボタンの処理 (goAsync) に使える時間は約 10 秒。接続と読み取りの合計をその中に収め、
     * 失敗したときに「出欠を反映できませんでした」を出す時間を残す (レビュー M7)。
     */
    private static final int CONNECT_TIMEOUT_MS = 4000;
    private static final int READ_TIMEOUT_MS = 4000;
    /** 合言葉を送ってよい受け口のパス (API の URL のパスの後ろ)。 */
    static final String ACTION_PATH = "/v1/notification-actions/event";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION.equals(intent.getAction())) return;
        final String tag = intent.getStringExtra(EXTRA_TAG);
        final String eventId = CalendarNotifications.validEventId(intent.getStringExtra(EXTRA_EVENT_ID));
        final String recurrenceId = intent.getStringExtra(EXTRA_RECURRENCE_ID);
        final String status = intent.getStringExtra(EXTRA_STATUS);
        final String url = intent.getStringExtra(EXTRA_URL);
        final String token = intent.getStringExtra(EXTRA_TOKEN);
        final String title = intent.getStringExtra(EXTRA_TITLE);
        if (tag == null || eventId == null || !validStatus(status) || url == null || token == null) return;
        // 自分の API の受け口でなければ送らない (通知を作るときにも確かめている)。
        if (!allowedUrl(context, url)) return;

        // 押したらすぐに通知を片付ける。送れなかったときは、同じ tag で改めて知らせる。
        CalendarNotifications.cancel(context, tag);
        final Context app = context.getApplicationContext();
        final PendingResult pending = goAsync();
        // 同じ要求の再送を 1 回として扱ってもらうための鍵。
        final String idempotencyKey = UUID.randomUUID().toString();
        final String respondedAt = isoNow();
        new Thread(() -> {
            try {
                if (!send(url, eventId, status, token, respondedAt, idempotencyKey)) {
                    CalendarNotifications.showRsvpFailure(app, tag, eventId, recurrenceId, title);
                }
            } finally {
                pending.finish();
            }
        })
            .start();
    }

    private static boolean validStatus(String status) {
        return "accepted".equals(status) || "tentative".equals(status) || "declined".equals(status);
    }

    /**
     * サーバーへ出欠を送る。受け付けられたか。
     * 404 は予定がもう無い (済んだ扱い)。403 (合言葉の期限切れ) と 409 (取り消された予定など) は失敗。
     */
    private static boolean send(String url, String eventId, String status, String token, String respondedAt, String key) {
        try {
            JSONObject body = new JSONObject();
            body.put("eventId", eventId);
            body.put("status", status);
            body.put("token", token);
            body.put("respondedAt", respondedAt);
            body.put("idempotencyKey", key);
            int code = post(url, body);
            return (code >= 200 && code < 300) || code == 404;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 出欠の送り先として許す URL か。接続先サーバー (画面の apiUrl()) と同じ origin で、
     * パスが「API のパス + /v1/notification-actions/event」、問い合わせ・ユーザー情報・# が無いもの。
     */
    static boolean allowedUrl(Context context, String url) {
        return allowedUrl(SharedConfig.load(context).serverUrl, url);
    }

    static boolean allowedUrl(String serverUrl, String url) {
        if (serverUrl == null || serverUrl.isEmpty() || url == null || url.isEmpty()) return false;
        try {
            URI target = new URI(url);
            URI api = new URI(serverUrl);
            String scheme = target.getScheme();
            if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)) return false;
            if (target.getRawUserInfo() != null || target.getRawQuery() != null || target.getRawFragment() != null) return false;
            if (!origin(target).equals(origin(api))) return false;
            String base = api.getRawPath() == null ? "" : api.getRawPath().replaceAll("/+$", "");
            return (base + ACTION_PATH).equals(target.getRawPath());
        } catch (URISyntaxException e) {
            return false;
        }
    }

    /** scheme://host:port (既定のポートは省いた形にそろえる)。 */
    private static String origin(URI uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        int port = uri.getPort();
        if (("https".equals(scheme) && port == 443) || ("http".equals(scheme) && port == 80)) port = -1;
        return scheme + "://" + host + (port < 0 ? "" : ":" + port);
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
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
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

    private static String isoNow() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }
}
