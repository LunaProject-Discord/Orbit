package jp.lunaproject.orbit.mail;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * サーバーからの新着メールの知らせ (FCM) の受け口。
 * サーバーは通知の中身を data だけで送るので、ここで通知を組み立てて出す
 * (Android に任せる形の通知には、ボタンを付けられないため)。
 * 端末の登録 (トークン) の扱いは、もとのプラグインの受け口に任せる。
 */
public class OrbitMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        // notification の付いた知らせ (古いサーバー) は、Android が自分で出す。
        if (remoteMessage.getNotification() != null) return;
        Map<String, String> data = remoteMessage.getData();
        String title = data.get("title");
        if (title == null || title.isEmpty()) return;
        // 画面を開いている間は通知を出さない (一覧に反映される)。
        if (MainActivity.isVisible()) return;
        MailNotifications.show(this, remoteMessage.getMessageId(), data);
    }
}
