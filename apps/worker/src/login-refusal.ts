/**
 * ログインを断られた理由が、パスワードの誤りではなく一時的なもの (同時接続数の上限、
 * 混雑、サーバーの不調) かを見分ける。
 *
 * 接続が多すぎるとき、サーバーはログインのコマンドに NO を返すので、そのままでは
 * 「認証に失敗した」と区別が付かない (Dovecot は `NO [UNAVAILABLE] Maximum number of
 * connections ...`、Gmail は `NO [ALERT] Too many simultaneous connections.`)。
 * これを認証の失敗として扱うと、パスワードは正しいのに再ログインを求めてしまう。
 * 応答コードは RFC 5530 のもの。
 */
const TEMPORARY_CODES = new Set(["UNAVAILABLE", "LIMIT", "INUSE", "SERVERBUG"]);
const PERMANENT_CODES = new Set([
  "AUTHENTICATIONFAILED",
  "AUTHORIZATIONFAILED",
  "EXPIRED",
  "PRIVACYREQUIRED",
]);
const TEMPORARY_TEXT =
  /too many|maximum number of connections|simultaneous|connection limit|rate limit|temporar|try again|unavailable|overload|busy/i;

export function isTemporaryLoginRefusal(error: {
  serverResponseCode?: string;
  responseText?: string;
  message?: string;
}): boolean {
  const code = error.serverResponseCode?.toUpperCase();
  if (code && TEMPORARY_CODES.has(code)) return true;
  if (code && PERMANENT_CODES.has(code)) return false;
  return TEMPORARY_TEXT.test(error.responseText ?? error.message ?? "");
}
