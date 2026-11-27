import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const privateRanges = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv6");
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // ::ffff:127.0.0.1 のような IPv4 射影アドレスは IPv4 として判定する。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return privateRanges.check(mapped[1], "ipv4");
  return privateRanges.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * 利用者が指定したホストが、サーバーの内部ネットワークを指していないか調べる。
 * API サーバーを踏み台にした内部への接続 (SSRF) を防ぐためのもの。
 * 名前解決の結果は接続時に変わりうるので、完全な防御ではない。
 */
export async function resolvesToPrivateAddress(host: string): Promise<boolean> {
  if (isIP(host)) return isPrivateAddress(host);
  const addresses = await lookup(host, { all: true });
  return addresses.some((entry) => isPrivateAddress(entry.address));
}
