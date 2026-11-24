import { useEffect, useMemo, useSyncExternalStore } from "react";
import { type Contact, getContacts, getToken } from "@/lib/api";

/**
 * 宛先の候補 (送受信したメールの相手)。
 * 入力のたびにサーバーへ問い合わせないよう、上位 MAX_CONTACTS 件を一度だけ取得して手元に持ち、
 * 絞り込みと並べ替えは rankContacts で行う。宛先の欄・検索欄など、どの画面からも同じものを使う。
 */

/** 手元に持つ件数の上限。 */
const MAX_CONTACTS = 5000;
/** これより古ければ、次に使うときに取得し直す。 */
const STALE_MS = 5 * 60_000;

type State = {
  contacts: Contact[];
  /** 取得した時刻 (ミリ秒)。まだ取得していなければ 0。 */
  fetchedAt: number;
  /** 取得したときのログイン (別の利用者でログインし直したら捨てる)。 */
  token: string | null;
};

const EMPTY: State = { contacts: [], fetchedAt: 0, token: null };
let state: State = EMPTY;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function read() {
  return state;
}

/** 候補を取得し直す (古ければ)。force で必ず取得する。失敗しても手元の候補はそのまま。 */
export function refreshContacts(force = false): Promise<void> {
  const token = getToken();
  if (state.fetchedAt && state.token !== token) clearContacts();
  if (!token) return Promise.resolve();
  if (pending) return pending;
  if (!force && state.fetchedAt && Date.now() - state.fetchedAt < STALE_MS) {
    return Promise.resolve();
  }
  pending = getContacts({ limit: MAX_CONTACTS })
    .then((contacts) => {
      // 取得中にログインし直していたら、前の利用者の候補なので使わない。
      if (getToken() !== token) return;
      state = { contacts, fetchedAt: Date.now(), token };
      for (const listener of listeners) listener();
    })
    .catch(() => {
      // オフラインなど。次に使うときにもう一度試す。
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** 手元の候補をすべて捨てる。 */
export function clearContacts() {
  state = EMPTY;
  for (const listener of listeners) listener();
}

/** 手元にある候補の全件。初めて使ったとき (と古くなったとき) に取得する。 */
export function useContacts(): Contact[] {
  const current = useSyncExternalStore(subscribe, read, () => EMPTY);
  useEffect(() => {
    void refreshContacts();
  }, []);
  return current.contacts;
}

/** 照らし合わせ用に、大文字・小文字と全角・半角の違いをなくす。 */
function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** 名前やアドレスを、語の先頭として扱う位置で区切る。 */
function words(text: string): string[] {
  return text.split(/[\s@._+\-"'()<>,]+/).filter(Boolean);
}

/**
 * どのくらい合っているか。0 は合っていない。
 * 3: アドレスか名前の先頭から合う、2: 語の先頭から合う、1: 途中に含まれる。
 * 空白で区切った語が複数あるときは、すべての語が合う必要があり、いちばん弱い合い方を使う。
 */
export function matchStrength(contact: Contact, query: string): number {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const address = normalize(contact.address);
  const name = normalize(contact.name ?? "");
  const allWords = [...words(address), ...words(name)];
  let weakest = 3;
  for (const token of tokens) {
    let strength = 0;
    if (address.startsWith(token) || name.startsWith(token)) strength = 3;
    else if (allWords.some((word) => word.startsWith(token))) strength = 2;
    else if (address.includes(token) || name.includes(token)) strength = 1;
    if (strength === 0) return 0;
    weakest = Math.min(weakest, strength);
  }
  return weakest;
}

/**
 * 入力に合う候補を、合い方の強さ → よくやり取りする順に並べて返す。
 * exclude のアドレス (選び済みの宛先など、大文字・小文字は区別しない) は除く。
 */
export function rankContacts(
  contacts: readonly Contact[],
  query: string,
  { limit = 8, exclude }: { limit?: number; exclude?: Iterable<string> } = {},
): Contact[] {
  if (!query.trim()) return [];
  const skip = new Set(
    Array.from(exclude ?? [], (address) => address.toLowerCase()),
  );
  const matched: { contact: Contact; strength: number; index: number }[] = [];
  contacts.forEach((contact, index) => {
    if (skip.has(contact.address.toLowerCase())) return;
    const strength = matchStrength(contact, query);
    if (strength > 0) matched.push({ contact, strength, index });
  });
  // 語の先頭から合うものを前にし、その中ではサーバーの並び (よくやり取りする順) を保つ。
  // 途中に含まれるだけのものは、よくやり取りする相手でも後ろにする。
  const strong = (entry: { strength: number }) => (entry.strength >= 2 ? 1 : 0);
  matched.sort((a, b) => strong(b) - strong(a) || a.index - b.index);
  return matched.slice(0, limit).map((entry) => entry.contact);
}

/**
 * 入力中の文字列に合う候補。query が空なら空の配列を返す。
 * 宛先の欄と検索欄で同じものを使う。
 */
export function useContactSuggestions(
  query: string,
  { limit = 8, exclude }: { limit?: number; exclude?: readonly string[] } = {},
): Contact[] {
  const contacts = useContacts();
  const excludeKey = exclude?.join("\n") ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: exclude は中身 (excludeKey) が変わったときだけ計算し直す。
  return useMemo(
    () => rankContacts(contacts, query, { limit, exclude }),
    [contacts, query, limit, excludeKey],
  );
}
