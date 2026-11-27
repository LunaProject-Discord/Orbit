import { useEffect, useState } from "react";
import {
  fetchSenderIcon,
  type SenderCheck,
  type SenderIconSource,
} from "@/lib/api";
import { useSenderIconGravatar } from "@/lib/sender-icon-settings";

/**
 * 差出人のアイコンを探す取得元を、探す順に決める。
 * - BIMI のロゴ: サーバーが証明書 (VMC・CMC) を確かめたロゴだけを返す。差出人では、
 *   送信元の確認 (DMARC) が取れていて注意が無いメールだけ (なりすましのメールに本物のロゴを出さない)。
 * - Gravatar: 設定 (どの端末でも共通) で許したときだけ (アドレスのハッシュが Gravatar に送られるため)。
 *   サーバーも設定を確かめ、オフなら頼まれても使わない。
 * - ドメインのファビコン: 注意 (認証の失敗や、表示名とドメインの食い違い) が無い差出人だけ。
 *   ファビコンには証明書が無く、似せたドメインでも本物らしい画像を置けるため。
 * 確認結果がまだ無いメール (取り込みの途中など) は、Gravatar だけを使う。
 * contact は、宛先や宛先の候補など、メールの差出人でない相手。確認結果が無いので、
 * 証明書で確かめられる BIMI と Gravatar だけを使う。
 */
export function senderIconSources(
  check: SenderCheck | null | undefined,
  gravatar: boolean,
  contact = false,
): SenderIconSource[] {
  if (contact) return gravatar ? ["bimi", "gravatar"] : ["bimi"];
  const clean = check ? check.warnings.length === 0 : false;
  const sources: SenderIconSource[] = [];
  if (clean && check?.verified) sources.push("bimi");
  if (gravatar) sources.push("gravatar");
  if (clean) sources.push("favicon");
  return sources;
}

export type SenderIcon = { url: string; source: SenderIconSource | null };

/** 取得の済んだアイコン (見つからなかったものは null)。キーは「アドレス|取得元」。 */
const resolved = new Map<string, SenderIcon | null>();
const pending = new Map<string, Promise<SenderIcon | null>>();
const MAX_ENTRIES = 1000;
/** 同時に取りに行く数。一覧を開いた直後に、行の数だけ一度に問い合わせないようにする。 */
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function remember(key: string, icon: SenderIcon | null) {
  if (resolved.size >= MAX_ENTRIES) {
    // いちばん古いものから捨てる (Map は入れた順に並ぶ)。
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) {
      const url = resolved.get(oldest)?.url;
      if (url) URL.revokeObjectURL(url);
      resolved.delete(oldest);
    }
  }
  resolved.set(key, icon);
}

function load(
  key: string,
  address: string,
  sources: SenderIconSource[],
): Promise<SenderIcon | null> {
  const running = pending.get(key);
  if (running) return running;
  const promise = slot(() => fetchSenderIcon(address, sources))
    .then((result) => {
      const icon = result
        ? {
            url: URL.createObjectURL(result.blob),
            source: result.source,
          }
        : null;
      remember(key, icon);
      return icon;
    })
    // 通信できないときなどは覚えずに、次に表示したときに取り直す。
    .catch(() => null)
    .finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

/**
 * 差出人のアイコンの URL (端末の中の blob: URL)。無い、まだ取れていない、
 * または enabled が false なら null で、呼び出し側は頭文字を出す。
 */
export function useSenderIcon(
  address: string | null | undefined,
  check: SenderCheck | null | undefined,
  enabled: boolean,
  /** 差出人でない相手 (宛先、宛先の候補)。senderIconSources を参照。 */
  contact = false,
): SenderIcon | null {
  const senderIconGravatar = useSenderIconGravatar();
  const sources =
    enabled && address
      ? senderIconSources(check, senderIconGravatar, contact)
      : [];
  const key =
    address && sources.length > 0
      ? `${address.toLowerCase()}|${sources.join(",")}`
      : null;
  const [icon, setIcon] = useState<{
    key: string;
    icon: SenderIcon | null;
  } | null>(() =>
    key && resolved.has(key) ? { key, icon: resolved.get(key) ?? null } : null,
  );
  useEffect(() => {
    if (!key || !address) return;
    const known = resolved.get(key);
    if (known !== undefined) {
      setIcon({ key, icon: known });
      return;
    }
    let alive = true;
    void load(
      key,
      address,
      key.split("|")[1]?.split(",") as SenderIconSource[],
    ).then((result) => {
      if (alive) setIcon({ key, icon: result });
    });
    return () => {
      alive = false;
    };
  }, [key, address]);
  if (!key) return null;
  if (icon?.key === key) return icon.icon;
  return resolved.get(key) ?? null;
}
