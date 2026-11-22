/**
 * ランダムな UUID (v4) を作る。
 *
 * crypto.randomUUID() は、https か localhost で開いたとき (セキュアコンテキスト) にしか使えない。
 * 開発中に同じ LAN のスマホから http://<PC の IP アドレス>:3000 で開いたときにも動くよう、
 * 無ければ crypto.getRandomValues() (こちらは http でも使える) から組み立てる。
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // 版 (v4)
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // 種類 (RFC 9562)
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}
