/**
 * 一定時間あたりの回数の制限 (メモリ上、プロセスごと)。ログイン前に呼べる API で、
 * IdP への通信などを何度でも起こされないようにする。
 */
export function createRateWindow(options: { limit: number; windowMs: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    /** 1 回数える。上限を超えていれば false。 */
    take(key: string, now = Date.now()): boolean {
      // 古い記録が溜まりすぎないよう、ときどき掃除する。
      if (hits.size > 10_000) {
        for (const [k, entry] of hits) {
          if (entry.resetAt <= now) hits.delete(k);
        }
      }
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + options.windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= options.limit;
    },
  };
}

/**
 * 呼び出し元の IP アドレス。前段のリバースプロキシ (Caddy) が付ける X-Forwarded-For の先頭
 * (Better Auth の回数制限と同じ考え方)。分からなければ "unknown" でまとめて数える。
 */
export function clientAddress(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}
