import { Hono } from "hono";
import type { AppEnv, RouteDeps } from "../context.js";

/**
 * CalDAV のアカウント (iCloud、一般の CalDAV サーバー) の追加と設定。ログインが要る。
 * 起点の URL の探索、接続先の検査、アカウントの追加は CalDAV の担当が実装する。
 * いまは雛形で、何も受け付けない。/v1/accounts/caldav にマウントされる
 * (/v1/accounts の /:id より先に登録する)。
 */
export function caldavAccountRoutes(
  _deps: Pick<RouteDeps, "db" | "encryptionKey" | "allowPrivateMailHosts">,
) {
  return new Hono<AppEnv>();
}
