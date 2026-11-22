import type { Address, SignatureRule } from "@/lib/api";

/** 署名の出どころ。優先順位は、会話、連絡先、アカウントの順。 */
export type SignatureSource = "thread" | "contact" | "account";

export type ResolvedSignature = {
  /** 本文に入れる署名 (書式付き)。null は署名なし。 */
  html: string | null;
  source: SignatureSource;
};

/** 連絡先の決まりを探すときの鍵 (大文字と小文字、前後の空白は区別しない)。 */
export function contactKey(address: string): string {
  return address.trim().toLowerCase();
}

export function findContactRule(
  rules: readonly SignatureRule[],
  address: string,
): SignatureRule | null {
  const key = contactKey(address);
  return (
    rules.find((rule) => rule.kind === "contact" && rule.key === key) ?? null
  );
}

export function findThreadRule(
  rules: readonly SignatureRule[],
  accountId: string,
  threadKey: string | null | undefined,
): SignatureRule | null {
  if (!threadKey) return null;
  return (
    rules.find(
      (rule) =>
        rule.kind === "thread" &&
        rule.accountId === accountId &&
        rule.key === threadKey,
    ) ?? null
  );
}

/**
 * 書いているメールに入れる署名を決める。
 *
 * 1. 返信・転送する会話に署名が決めてあれば、それを使う。
 * 2. 宛先 (To) の全員に連絡先の署名が決めてあり、すべて同じ内容なら、それを使う。
 *    決めていない相手が混ざるときや、相手によって署名が違うときは使わない
 *    (特定の相手向けの署名が、ほかの相手に届かないようにするため)。Cc と Bcc は見ない。
 * 3. どちらでもなければ、差出人のアカウントの署名を使う。
 */
export function resolveSignature(input: {
  rules: readonly SignatureRule[];
  accountId: string;
  accountSignature: string | null | undefined;
  threadKey?: string | null;
  to: readonly Address[];
}): ResolvedSignature {
  const thread = findThreadRule(input.rules, input.accountId, input.threadKey);
  if (thread) return { html: thread.signatureHtml, source: "thread" };

  const keys = new Set(input.to.map((entry) => contactKey(entry.address)));
  if (keys.size > 0) {
    const found = [...keys].map((key) => findContactRule(input.rules, key));
    const first = found[0];
    if (
      first &&
      found.every(
        (rule) => rule !== null && rule.signatureHtml === first.signatureHtml,
      )
    ) {
      return { html: first.signatureHtml, source: "contact" };
    }
  }
  return { html: input.accountSignature ?? null, source: "account" };
}

const CACHE_KEY = "mail.signature-rules.v1";

/** 前回取得した決まり。サーバーに届かないとき (オフライン) にも署名を選べるようにする。 */
export function loadCachedSignatureRules(): SignatureRule[] {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(CACHE_KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? (parsed as SignatureRule[]) : [];
  } catch {
    return [];
  }
}

export function storeCachedSignatureRules(
  rules: readonly SignatureRule[],
): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(rules));
  } catch {
    // 保存できない環境では、次に開いたときにサーバーから取得するだけ。
  }
}
