/**
 * 開発中に、同じ LAN の別の端末 (スマホなど) から Web を開けるようにするための、許可するオリジン。
 *
 * スマホは Web を http://<PC の IP アドレス>:3000 で開くので、API から見たオリジンは
 * http://localhost:3000 ではなくなる。許可していないと、ログインも一覧の取得も CORS で断られる。
 * ここでは、設定済みのオリジンのうち localhost のものを、この PC の名前と IP アドレスに置き換えたものを返す。
 * (この PC を指すオリジンだけを足す。ほかの機器のオリジンは許可しない。)
 */

export type NetworkAddress = {
  address: string;
  family: string;
  internal: boolean;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function lanOrigins(
  configured: readonly string[],
  hostname: string,
  interfaces: Record<string, readonly NetworkAddress[] | undefined>,
): string[] {
  const hosts = new Set<string>();
  if (hostname) {
    hosts.add(hostname.toLowerCase());
    hosts.add(`${hostname.toLowerCase()}.local`);
  }
  for (const addresses of Object.values(interfaces)) {
    for (const { address, family, internal } of addresses ?? []) {
      if (family === "IPv4" && !internal) hosts.add(address);
    }
  }
  const origins = new Set<string>();
  for (const origin of configured) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      continue;
    }
    if (!LOCAL_HOSTS.has(url.hostname)) continue;
    for (const host of hosts) {
      origins.add(`${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`);
    }
  }
  return [...origins].filter((origin) => !configured.includes(origin));
}
