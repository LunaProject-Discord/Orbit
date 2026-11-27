import { useEffect, useState, useSyncExternalStore } from "react";
import {
  fetchSenderIcon,
  isVerifiedSender,
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
  if (isVerifiedSender(check)) sources.push("bimi");
  if (gravatar) sources.push("gravatar");
  if (clean) sources.push("favicon");
  return sources;
}

export type SenderIcon = { url: string; source: SenderIconSource | null };

/** 取得の済んだアイコン (見つからなかったものは icon が null) と、取得したときの世代。 */
type Entry = { icon: SenderIcon | null; generation: number };

/** 取得の済んだアイコン。キーは「アドレス|取得元」。 */
const resolved = new Map<string, Entry>();
const pending = new Map<string, Promise<SenderIcon | null>>();
const MAX_ENTRIES = 1000;
/** 置き換えた画像の URL を捨てるまでの時間 (表示中の画像が切り替わるのを待つ)。 */
const REVOKE_DELAY_MS = 30_000;
/** 同時に取りに行く数。一覧を開いた直後に、行の数だけ一度に問い合わせないようにする。 */
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: (() => void)[] = [];

/**
 * 利用者が更新した回数。これより前の世代に取得したアイコンは、次に表示するときに取り直す
 * (取り直すまでは前の画像を出しておく)。
 */
let generation = 0;
const listeners = new Set<() => void>();

/**
 * 差出人のアイコンを取り直す (利用者がフォルダやアカウントを更新したとき)。
 * この端末で取得済みのアイコンを、表示したものから順に、ブラウザーとサーバーの控えを使わずに
 * 取り直す (サーバーは、1 時間以内に取得したものは取り直さない)。
 */
export function reloadSenderIcons() {
  generation++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const currentGeneration = () => generation;

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

function revokeLater(url: string | undefined) {
  if (url) setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

function remember(key: string, entry: Entry) {
  const previous = resolved.get(key);
  if (previous) {
    if (previous.icon?.url !== entry.icon?.url) revokeLater(previous.icon?.url);
    // 入れ直して、新しいものとして並べる。
    resolved.delete(key);
  } else if (resolved.size >= MAX_ENTRIES) {
    // いちばん古いものから捨てる (Map は入れた順に並ぶ)。
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) {
      revokeLater(resolved.get(oldest)?.icon?.url);
      resolved.delete(oldest);
    }
  }
  resolved.set(key, entry);
}

function load(
  key: string,
  address: string,
  sources: SenderIconSource[],
): Promise<SenderIcon | null> {
  const running = pending.get(key);
  if (running) return running;
  const wanted = generation;
  // 更新の前に取得したものは、控えを使わずに取り直す。初めて表示するものは控えを使う
  // (更新のたびに、見たことのない差出人の分まで相手のサーバーへ問い合わせないため)。
  const known = resolved.get(key);
  const refresh = known !== undefined && known.generation < wanted;
  const promise = slot(() => fetchSenderIcon(address, sources, { refresh }))
    .then((result) => {
      const icon = result
        ? {
            url: URL.createObjectURL(result.blob),
            source: result.source,
          }
        : null;
      remember(key, { icon, generation: wanted });
      return icon;
    })
    // 通信できないときなどは覚えずに (前に取れていたものがあればそれを出し)、次に表示したときに取り直す。
    .catch(() => resolved.get(key)?.icon ?? null)
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
  const wantedGeneration = useSyncExternalStore(
    subscribe,
    currentGeneration,
    () => 0,
  );
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
  } | null>(() => {
    const known = key ? resolved.get(key) : undefined;
    return key && known ? { key, icon: known.icon } : null;
  });
  useEffect(() => {
    if (!key || !address) return;
    const known = resolved.get(key);
    if (known) setIcon({ key, icon: known.icon });
    // 今の世代で取得済みなら、取り直さない。
    if (known && known.generation >= wantedGeneration) return;
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
  }, [key, address, wantedGeneration]);
  if (!key) return null;
  if (icon?.key === key) return icon.icon;
  return resolved.get(key)?.icon ?? null;
}
