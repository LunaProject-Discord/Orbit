package jp.lunaproject.orbit.mail;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * サーバーからの新着メールと予定の知らせ (FCM) の受け口。
 * サーバーは通知の中身を data だけで送るので、ここで通知を組み立てて出す
 * (Android に任せる形の通知には、ボタンを付けられないため)。
 * 端末の登録 (トークン) の扱いは、もとのプラグインの受け口に任せる。
 */
public class OrbitMessagingService extends MessagingService {

    /** 予定の通知の kind の先頭 (@orbit/core の CalendarNotificationKind)。 */
    private static final String CALENDAR_KIND_PREFIX = "event-";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        // notification の付いた知らせ (古いサーバー) は、Android が自分で出す。
        if (remoteMessage.getNotification() != null) return;
        Map<String, String> data = remoteMessage.getData();
        String title = data.get("title");
        if (title == null || title.isEmpty()) return;
        // 予定の通知 (data.kind が event- で始まる。段取り 9)。リマインダーは画面を開いていても
        // 出さないと気付けないので、画面が見えていても出す。Calendar アプリが入っていれば譲る。
        String kind = data.get("kind");
        if (kind != null && kind.startsWith(CALENDAR_KIND_PREFIX)) {
            if (!CalendarNotifications.handledByOtherApp(this)) CalendarNotifications.showPush(this, data);
            return;
        }
        // 画面を開いている間は通知を出さない (一覧に反映される)。
        if (MainActivity.isVisible()) return;
        MailNotifications.show(this, remoteMessage.getMessageId(), data);
    }
}
