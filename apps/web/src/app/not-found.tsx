import Home from "./page";

/**
 * Next.js が知らないパスで出す画面。メールの画面はパス (/accounts/… など) を自分で
 * 読み取るので、ここでも同じ画面を出す。
 *
 * 知らないパスに "/" の画面を返すのは、本来は配信する側の役目 (本番の Caddy、
 * サービスワーカー、Tauri / Capacitor)。それが無い場所 (`next dev` や、404.html しか
 * 返さない置き場) でも同じ URL で開けるように、404 の画面もアプリにしておく。
 */
export default function NotFound() {
  return <Home />;
}
