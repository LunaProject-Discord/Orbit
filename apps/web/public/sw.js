// サービスワーカー。次の 2 つを受け持つ。
// - アプリ本体 (HTML、スクリプト、スタイル、フォント) を端末に保存し、オフラインでも画面を開けるようにする。
// - サーバーからの Web Push を受けて新着メールの通知を出し、通知が押されたらアプリを開く。
//   通知のボタン (既読にする、アーカイブなど) が押されたら、画面を開かずに操作する。
// メールのデータ (API の応答) は扱わない。そちらは画面側が IndexedDB に保存する。

// アプリ本体の保存先。ビルドのたびに作られる一覧 (precache-manifest.json) の内容を入れる。
// 一覧が無い環境 (next dev) では何も保存せず、通信にも手を出さない。
const SHELL_PREFIX = "mail-shell-";
// 一覧に無い静的ファイル (使った分だけ読み込むフォントなど) の保存先。
const ASSETS = "mail-assets";
const MANIFEST_URL = "/precache-manifest.json";
// 画面の HTML を待つ時間。これを過ぎたら、保存してあるものを先に出す。
const NAVIGATION_TIMEOUT_MS = 4000;

// 同じ URL の中身が変わらないファイル。Next.js が書き出したもの (名前に内容のハッシュが入る) と、
// PDF の表示に使う pdf.js のファイル (パスに pdf.js の版が入る。scripts/copy-pdfjs.mjs)。
// 一度取得したら保存したものを使うので、CMap などは開いた PDF に要った分だけがたまり、オフラインでも使える。
function isImmutable(pathname) {
  return (
    pathname.startsWith("/_next/static/") || pathname.startsWith("/pdfjs/")
  );
}

async function currentShell() {
  const names = await caches.keys();
  return names.find((name) => name.startsWith(SHELL_PREFIX)) ?? null;
}

// 一覧を取得し、版が変わっていればアプリ本体を保存し直す。
// すべて保存できてから古い版を消すので、途中で通信が切れても前の版で開ける。
let refreshing = null;
function refreshShell() {
  refreshing ??= (async () => {
    const response = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!response.ok) return;
    const manifest = await response.json();
    if (
      typeof manifest.version !== "string" ||
      !Array.isArray(manifest.files)
    ) {
      return;
    }
    const name = SHELL_PREFIX + manifest.version;
    const names = await caches.keys();
    if (!names.includes(name)) {
      const previous = await currentShell();
      const cache = await caches.open(name);
      try {
        for (const file of manifest.files) {
          // 名前に内容のハッシュ (または版) が入ったファイルは、前の版にあればそれを使う。
          const reused =
            previous && isImmutable(file)
              ? await (await caches.open(previous)).match(file)
              : null;
          if (reused) {
            await cache.put(file, reused);
            continue;
          }
          const fetched = await fetch(file, { cache: "no-store" });
          if (!fetched.ok) throw new Error(`${file}: ${fetched.status}`);
          await cache.put(file, fetched);
        }
      } catch (error) {
        await caches.delete(name);
        throw error;
      }
    }
    for (const other of await caches.keys()) {
      if (other.startsWith(SHELL_PREFIX) && other !== name) {
        await caches.delete(other);
      }
    }
  })()
    .catch(() => {
      // 取得できなければ、前に保存した版のまま使う。
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

self.addEventListener("install", (event) => {
  // 新しい版はすぐに有効にする (古い版を待たせる理由が無い)。
  self.skipWaiting();
  event.waitUntil(refreshShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  // 画面を開くたびに、新しい版が配置されていないかを確かめる。
  if (event.data?.type === "refresh-shell") event.waitUntil(refreshShell());
});

// URL に対応する、保存してあるファイルの名前 (/login → /login.html など)。
function shellCandidates(pathname) {
  const path = pathname.replace(/\/+$/, "");
  if (path === "") return ["/index.html"];
  return [path, `${path}.html`, `${path}/index.html`];
}

async function fromShell(shell, pathname) {
  const cache = await caches.open(shell);
  for (const candidate of shellCandidates(pathname)) {
    const response = await cache.match(candidate);
    if (response) return response;
  }
  return null;
}

async function networkFirst(request, shell, timeoutMs) {
  const url = new URL(request.url);
  const navigate = request.mode === "navigate";
  // 画面は 1 つのアプリで、パス (/accounts/… など) はアプリが読み取る。
  // そのパスのファイルが無ければ、最初の画面を出す。
  const saved = async () =>
    (await fromShell(shell, url.pathname)) ??
    (navigate ? await fromShell(shell, "/") : null);
  let timer = null;
  const network = fetch(request);
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const response = await Promise.race([network, timeout]);
    // 知らないパスに最初の画面を返さないサーバーでも、保存してある画面で開く。
    if (response && navigate && response.status === 404) {
      return (await saved()) ?? response;
    }
    if (response) return response;
    // 応答が遅い。保存してあるものがあれば先に出し、無ければ待ち続ける。
    network.catch(() => {});
    return (await saved()) ?? (await network);
  } catch (error) {
    const response = await saved();
    if (response) return response;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cacheFirst(request, shell) {
  const url = new URL(request.url);
  const saved =
    (await (await caches.open(shell)).match(url.pathname)) ??
    (await (await caches.open(ASSETS)).match(url.pathname));
  if (saved) return saved;
  const response = await fetch(request);
  if (response.ok) {
    const copy = response.clone();
    void caches.open(ASSETS).then((cache) => cache.put(url.pathname, copy));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API (同じドメインで公開している場合は /v1/ 以下) には手を出さない。
  if (url.pathname.startsWith("/v1/") || url.pathname === MANIFEST_URL) return;
  const immutable = isImmutable(url.pathname);
  const page = request.mode === "navigate" || url.pathname.endsWith(".txt");
  if (!immutable && !page) return;
  event.respondWith(
    (async () => {
      const shell = await currentShell();
      // 一覧の無い環境 (next dev) では、そのまま通信する。
      if (!shell) return fetch(request);
      return immutable
        ? cacheFirst(request, shell)
        : networkFirst(
            request,
            shell,
            request.mode === "navigate" ? NAVIGATION_TIMEOUT_MS : 10000,
          );
    })(),
  );
});

// 通知に付けるボタン。サーバーが選んだもの (利用者の設定) のうち、形の正しいものだけを使う。
function readActions(data) {
  const actions = data.actions;
  if (
    !actions ||
    typeof actions.url !== "string" ||
    typeof actions.token !== "string" ||
    !Array.isArray(actions.buttons)
  ) {
    return null;
  }
  const buttons = actions.buttons.filter(
    (button) =>
      button &&
      typeof button.id === "string" &&
      typeof button.title === "string",
  );
  if (buttons.length === 0) return null;
  return { url: actions.url, token: actions.token, buttons };
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // 形式の違う通知でも、何か届いたことは知らせる。
  }
  const title =
    typeof data.title === "string" && data.title ? data.title : "新着メール";
  const messageId = typeof data.messageId === "string" ? data.messageId : null;
  const actions = messageId ? readActions(data) : null;
  // 並べられるボタンの数はブラウザーごとに違う (Chrome は 2 つ)。入る分だけ、設定した順に出す。
  const max =
    typeof Notification !== "undefined" &&
    typeof Notification.maxActions === "number"
      ? Notification.maxActions
      : 2;
  // 件名の下に、本文の冒頭を出す。
  const body = [data.body, data.preview]
    .filter((line) => typeof line === "string" && line)
    .join("\n");
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // 同じメールの通知は置き換える (再送や複数のタブで二重に出さない)。
      tag: typeof data.tag === "string" ? data.tag : undefined,
      icon: "/icons/icon-192.png",
      ...(actions
        ? {
            actions: actions.buttons
              .slice(0, max)
              .map((button) => ({ action: button.id, title: button.title })),
          }
        : {}),
      data: {
        messageId,
        title,
        action: actions ? { url: actions.url, token: actions.token } : null,
      },
    }),
  );
});

// 通知のボタンが押された。画面を開かずに、サーバーへ操作を送る。
// ログインの情報は使わず、通知に付いていた合言葉で操作する。
async function runNotificationAction(notification, action) {
  const { messageId, title, action: target } = notification.data ?? {};
  let done = false;
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, action, token: target.token }),
    });
    // 404 は、ほかの端末ですでに削除や移動をしたメール。済んだものとして扱う。
    done = response.ok || response.status === 404;
  } catch {
    // 通信できなかった。
  }
  if (done) return;
  // 反映できなかったことを知らせる。押すと、そのメールを開く。
  await self.registration.showNotification("操作を反映できませんでした", {
    body: typeof title === "string" ? title : "",
    tag: notification.tag || undefined,
    icon: "/icons/icon-192.png",
    data: { messageId, title, action: null },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const messageId = event.notification.data?.messageId ?? null;
  if (event.action && messageId && event.notification.data?.action) {
    event.waitUntil(runNotificationAction(event.notification, event.action));
    return;
  }
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
        messageId ? `/messages/${encodeURIComponent(messageId)}` : "/",
      );
    })(),
  );
});
