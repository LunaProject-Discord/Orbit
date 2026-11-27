package jp.lunaproject.orbit.mail;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.RemoteInput;
import androidx.core.content.ContextCompat;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** 新着メールの通知を組み立てて出す。返信欄とボタン (既読にする、アーカイブなど) もここで付ける。 */
final class MailNotifications {

    /** 通知に並べるボタンの数の上限 (Android が表示できる数)。 */
    private static final int MAX_ACTIONS = 3;
    /** 通知は tag で見分けるので、番号はすべて同じにする。 */
    private static final int NOTIFICATION_ID = 0;
    /** アカウントごとの通知の分類 (チャンネル) の ID の先頭。画面側 (lib/native/push.ts) と合わせる。 */
    private static final String ACCOUNT_CHANNEL_PREFIX = "new-mail-";
    /** アカウントごとの通知のまとまり (グループ) の名前の先頭。 */
    private static final String GROUP_PREFIX = "orbit-account-";
    /** まとまりの見出しになる通知の tag の先頭。 */
    private static final String SUMMARY_TAG_PREFIX = "summary:";

    private MailNotifications() {}

    /**
     * サーバーから届いた内容で通知を出す。
     * data: title、body、preview (本文の冒頭。無いこともある)、tag、messageId (まとめた通知では空)、
     * actions (ボタンの JSON)、actionUrl、actionToken (ボタンか返信欄があるとき)、
     * actionReply ("1" なら返信欄を出す)、
     * accountId、accountName (届いたアカウント。古いサーバーでは無い)。
     * アカウントが分かるときは、アカウントごとの分類 (音やオン / オフを Android の設定で
     * 別々に変えられる) と、アカウントごとのまとまりに分けて出す。
     */
    static void show(Context context, String fcmMessageId, Map<String, String> data) {
        String title = data.get("title");
        String body = orEmpty(data.get("body"));
        String messageId = orEmpty(data.get("messageId"));
        String tag = data.get("tag");
        if (tag == null || tag.isEmpty()) tag = "mail:" + messageId;

        String preview = orEmpty(data.get("preview"));
        String accountId = orEmpty(data.get("accountId"));
        String accountName = orEmpty(data.get("accountName"));
        String channel = channel(context, accountId, accountName);

        // 閉じた通知には件名を出し、広げると件名の下に本文の冒頭を出す。
        NotificationCompat.Builder builder = base(context, channel, tag, fcmMessageId, messageId)
            .setContentTitle(title)
            .setContentText(body);
        if (!accountName.isEmpty()) builder.setSubText(accountName);
        if (!accountId.isEmpty()) builder.setGroup(GROUP_PREFIX + accountId);
        String expanded = body.isEmpty() ? preview : preview.isEmpty() ? body : body + "\n" + preview;
        if (!expanded.isEmpty()) {
            builder.setStyle(new NotificationCompat.BigTextStyle().bigText(expanded));
        }

        String url = data.get("actionUrl");
        String token = data.get("actionToken");
        String actions = data.get("actions");
        boolean reply = "1".equals(data.get("actionReply"));
        // 送り先が自分の API の受け口でなければ、ボタンも返信欄も付けない (合言葉をよそへ送らない)。
        if (!messageId.isEmpty() && NotificationActionReceiver.allowedUrl(context, url) && token != null) {
            int buttons = MAX_ACTIONS;
            if (reply) {
                addReply(context, builder, tag, messageId, url, token, title);
                buttons -= 1;
            }
            if (actions != null) addActions(context, builder, actions, tag, messageId, url, token, title, buttons);
        }
        post(context, tag, builder);
        if (!accountId.isEmpty()) showSummary(context, channel, accountId, accountName);
    }

    /**
     * アカウントごとのまとまりの見出し。同じアカウントの通知は、この下に束ねて表示される。
     * 音や振動は 1 通ずつの通知が鳴らすので、見出しでは鳴らさない。
     */
    private static void showSummary(Context context, String channel, String accountId, String accountName) {
        String tag = SUMMARY_TAG_PREFIX + accountId;
        NotificationCompat.Builder builder = base(context, channel, tag, null, "")
            .setContentTitle(accountName.isEmpty() ? context.getString(R.string.channel_new_mail_name) : accountName)
            .setContentText(context.getString(R.string.channel_new_mail_name))
            .setStyle(new NotificationCompat.InboxStyle().setSummaryText(accountName))
            .setGroup(GROUP_PREFIX + accountId)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN);
        post(context, tag, builder);
    }

    /** ボタンの操作をサーバーへ送れなかったことを知らせる。押すと、そのメールを開く。 */
    static void showFailure(Context context, String tag, String messageId, String title) {
        NotificationCompat.Builder builder = base(context, channel(context, "", ""), tag, null, messageId)
            .setContentTitle(context.getString(R.string.notification_action_failed))
            .setContentText(orEmpty(title));
        post(context, tag, builder);
    }

    /**
     * 返信を送れなかったことを知らせる。書いた文章は失わないよう本文に出す (長押しでコピーできる)。
     * 押すと、そのメールを開く (アプリの返信欄から送り直せる)。
     */
    static void showReplyFailure(Context context, String tag, String messageId, String title, String text) {
        NotificationCompat.Builder builder = base(context, channel(context, "", ""), tag, null, messageId)
            .setContentTitle(context.getString(R.string.notification_reply_failed))
            .setContentText(orEmpty(title))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(orEmpty(title) + "\n\n" + orEmpty(text)));
        post(context, tag, builder);
    }

    static void cancel(Context context, String tag) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        String group = groupOf(manager, tag);
        manager.cancel(tag, NOTIFICATION_ID);
        if (group != null) cancelEmptySummary(manager, group, tag);
    }

    /** 出ている通知が属するまとまり。属していなければ null。 */
    private static String groupOf(NotificationManager manager, String tag) {
        for (StatusBarNotification active : manager.getActiveNotifications()) {
            if (tag.equals(active.getTag())) return active.getNotification().getGroup();
        }
        return null;
    }

    /** まとまりの中の通知が無くなったら、見出しも消す (見出しだけが残らないようにする)。 */
    private static void cancelEmptySummary(NotificationManager manager, String group, String cancelledTag) {
        String summaryTag = null;
        for (StatusBarNotification active : manager.getActiveNotifications()) {
            String tag = active.getTag();
            if (tag == null || !group.equals(active.getNotification().getGroup())) continue;
            if (tag.startsWith(SUMMARY_TAG_PREFIX)) {
                summaryTag = tag;
            } else if (!tag.equals(cancelledTag)) {
                // まだ残っている通知がある。
                return;
            }
        }
        if (summaryTag != null) manager.cancel(summaryTag, NOTIFICATION_ID);
    }

    private static NotificationCompat.Builder base(
        Context context,
        String channel,
        String tag,
        String fcmMessageId,
        String messageId
    ) {
        // 通知を押したらアプリを開く。google.message_id があると、プッシュ通知のプラグインが
        // 「通知が押された」として画面へ伝え、画面が messageId のメールを開く。
        Intent open = new Intent(context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra("google.message_id", fcmMessageId == null || fcmMessageId.isEmpty() ? tag : fcmMessageId);
        open.putExtra("messageId", messageId);
        PendingIntent content = PendingIntent.getActivity(
            context,
            tag.hashCode(),
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_mail)
            .setColor(ContextCompat.getColor(context, R.color.brand))
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(content);
    }

    /**
     * 返信欄。押すと通知の中に入力欄が開き、送るとアプリを開かずにサーバーへ届ける。
     * 入力した文章を受け取るため、この PendingIntent だけは書き換えできる (MUTABLE) にする
     * (送り先は明示した自分のアプリの受け口なので、ほかのアプリには渡らない)。
     */
    private static void addReply(
        Context context,
        NotificationCompat.Builder builder,
        String tag,
        String messageId,
        String url,
        String token,
        String title
    ) {
        Intent intent = new Intent(context, NotificationActionReceiver.class);
        intent.setAction(NotificationActionReceiver.ACTION_REPLY);
        intent.putExtra(NotificationActionReceiver.EXTRA_TAG, tag);
        intent.putExtra(NotificationActionReceiver.EXTRA_MESSAGE_ID, messageId);
        intent.putExtra(NotificationActionReceiver.EXTRA_URL, url);
        intent.putExtra(NotificationActionReceiver.EXTRA_TOKEN, token);
        intent.putExtra(NotificationActionReceiver.EXTRA_TITLE, title);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
        PendingIntent pending = PendingIntent.getBroadcast(context, (tag + ":reply").hashCode(), intent, flags);
        RemoteInput input = new RemoteInput.Builder(NotificationActionReceiver.KEY_REPLY_TEXT)
            .setLabel(context.getString(R.string.notification_reply_hint))
            .build();
        builder.addAction(
            new NotificationCompat.Action.Builder(0, context.getString(R.string.notification_reply), pending)
                .addRemoteInput(input)
                .setAllowGeneratedReplies(true)
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                .setShowsUserInterface(false)
                .build()
        );
    }

    private static void addActions(
        Context context,
        NotificationCompat.Builder builder,
        String json,
        String tag,
        String messageId,
        String url,
        String token,
        String title,
        int max
    ) {
        try {
            JSONArray buttons = new JSONArray(json);
            int count = Math.min(buttons.length(), max);
            for (int index = 0; index < count; index++) {
                JSONObject button = buttons.getJSONObject(index);
                String id = button.getString("id");
                String label = button.getString("title");

                Intent intent = new Intent(context, NotificationActionReceiver.class);
                intent.setAction(NotificationActionReceiver.ACTION);
                intent.putExtra(NotificationActionReceiver.EXTRA_TAG, tag);
                intent.putExtra(NotificationActionReceiver.EXTRA_MESSAGE_ID, messageId);
                intent.putExtra(NotificationActionReceiver.EXTRA_ACTION, id);
                intent.putExtra(NotificationActionReceiver.EXTRA_URL, url);
                intent.putExtra(NotificationActionReceiver.EXTRA_TOKEN, token);
                intent.putExtra(NotificationActionReceiver.EXTRA_TITLE, title);
                PendingIntent pending = PendingIntent.getBroadcast(
                    context,
                    (tag + ":" + id).hashCode(),
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                );
                builder.addAction(
                    new NotificationCompat.Action.Builder(0, label, pending)
                        .setSemanticAction(semanticAction(id))
                        .setShowsUserInterface(false)
                        .build()
                );
            }
        } catch (JSONException e) {
            // ボタンを読み取れなくても、通知そのものは出す。
        }
    }

    /** 時計や車などが、ボタンの意味を知るための分類。 */
    private static int semanticAction(String id) {
        switch (id) {
            case "read":
                return NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ;
            case "archive":
                return NotificationCompat.Action.SEMANTIC_ACTION_ARCHIVE;
            case "delete":
                return NotificationCompat.Action.SEMANTIC_ACTION_DELETE;
            default:
                return NotificationCompat.Action.SEMANTIC_ACTION_NONE;
        }
    }

    private static void post(Context context, String tag, NotificationCompat.Builder builder) {
        // 利用者が通知を許可していなければ出さない (Android 13 以降は許可が要る)。
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        // 同じ tag の通知は置き換わる (再送で二重に出さない)。
        manager.notify(tag, NOTIFICATION_ID, builder.build());
    }

    /**
     * 新着メールの通知の分類。アカウントが分かるときは、アカウントごとの分類にする。
     * 画面を開いたときにも作る (lib/native/push.ts) が、無ければここで作る。
     * すでにある分類は、名前だけが新しくなる (利用者が変えた音などの設定は残る)。
     */
    private static String channel(Context context, String accountId, String accountName) {
        boolean perAccount = !accountId.isEmpty();
        String id = perAccount ? ACCOUNT_CHANNEL_PREFIX + accountId : context.getString(R.string.channel_new_mail_id);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null && (manager.getNotificationChannel(id) == null || (perAccount && !accountName.isEmpty()))) {
                NotificationChannel created = new NotificationChannel(
                    id,
                    perAccount && !accountName.isEmpty() ? accountName : context.getString(R.string.channel_new_mail_name),
                    NotificationManager.IMPORTANCE_HIGH
                );
                created.setDescription(context.getString(R.string.channel_new_mail_description));
                manager.createNotificationChannel(created);
            }
        }
        return id;
    }

    private static String orEmpty(String value) {
        return value == null ? "" : value;
    }
}
