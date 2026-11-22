/**
 * API サーバーの URL を決める。
 *
 * 開発中の設定は http://localhost:8787 だが、同じ LAN のスマホから
 * http://<PC の IP アドレス>:3000 で開くと、スマホにとっての localhost はスマホ自身なので届かない。
 * 設定が localhost を指していて、画面を別の名前や IP アドレスで開いているときは、
 * 画面と同じ機器 (= 開発サーバーを動かしている PC) の同じポートへ向ける。
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalHost(hostname: string): boolean {
  // Tauri (tauri.localhost) や Capacitor (localhost) は、その端末自身を指す。
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}

export function resolveApiUrl(
  configured: string,
  page: { protocol: string; hostname: string } | null,
): string {
  const base = configured.replace(/\/+$/, "");
  if (!page || !/^https?:$/.test(page.protocol) || !page.hostname) return base;
  if (isLocalHost(page.hostname)) return base;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return base;
  }
  if (!LOCAL_HOSTS.has(url.hostname)) return base;
  url.hostname = page.hostname;
  return url.toString().replace(/\/+$/, "");
}
