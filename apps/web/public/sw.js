// 新着メールの通知を出すサービスワーカー。
// サーバーからの Web Push を受けて通知を出し、通知が押されたらアプリを開く。
// 画面の表示やデータの取得には関わらない (キャッシュもしない)。

self.addEventListener("install", () => {
  // 新しい版はすぐに有効にする (古い版を待たせる理由が無い)。
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // 形式の違う通知でも、何か届いたことは知らせる。
  }
  const title =
    typeof data.title === "string" && data.title ? data.title : "新着メール";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      // 同じメールの通知は置き換える (再送や複数のタブで二重に出さない)。
      tag: typeof data.tag === "string" ? data.tag : undefined,
      icon: "/favicon.ico",
      data: {
        messageId: typeof data.messageId === "string" ? data.messageId : null,
      },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const messageId = event.notification.data?.messageId ?? null;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // すでに開いている画面があれば、そこでメールを開く。
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        client.postMessage({ type: "open-message", messageId });
        await client.focus().catch(() => {});
        return;
      }
      await self.clients.openWindow(
        messageId ? `/?message=${encodeURIComponent(messageId)}` : "/",
      );
    })(),
  );
});
