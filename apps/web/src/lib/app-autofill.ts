/**
 * アプリ (デスクトップ版・スマホアプリ) では、ブラウザー標準の自動入力 (以前に入力した値や
 * 住所・連絡先の候補) を出さない。アプリ独自の候補 (宛先やメールアドレスの候補) は別の仕組みなので残る。
 *
 * - 画面の入力欄に autocomplete="off" を付ける (あとから増えた欄にも付ける)。
 * - ログインなどのパスワード欄 (autocomplete が username / current-password / new-password など) は
 *   OS のパスワードマネージャーを使えるよう、そのまま残す。
 * - WebView 側の設定でも止める: Windows は apps/desktop の general_autofill_enabled、
 *   Android は AppShell の setAutofillAllowed (パスワード欄が画面にある間だけ許す)。
 * ブラウザー版では何もしない。
 */

/** OS のパスワードマネージャーやワンタイムコードの入力補助に任せる欄の autocomplete の値。 */
const CREDENTIAL_TOKENS = new Set([
  "username",
  "current-password",
  "new-password",
  "one-time-code",
  "webauthn",
]);

const FIELD_SELECTOR = "input, textarea, select";

/** autocomplete の値が、ログインなどの資格情報の欄を表すか ("username webauthn" のような複数の語も見る)。 */
export function isCredentialAutocomplete(value: string | null): boolean {
  if (!value) return false;
  return value
    .toLowerCase()
    .split(/\s+/)
    .some((token) => CREDENTIAL_TOKENS.has(token));
}

function isField(node: Node): node is Element {
  return node instanceof Element && node.matches(FIELD_SELECTOR);
}

/** 1 つの欄に autocomplete="off" を付ける。資格情報の欄はそのまま。資格情報の欄なら true。 */
export function guardField(field: Element): boolean {
  const value = field.getAttribute("autocomplete");
  if (isCredentialAutocomplete(value)) return true;
  if (value !== "off") field.setAttribute("autocomplete", "off");
  return false;
}

/** root の中の欄をすべて処理する。資格情報の欄があれば true。 */
export function guardFields(root: ParentNode): boolean {
  let credential = false;
  if (root instanceof Element && isField(root) && guardField(root)) {
    credential = true;
  }
  for (const field of root.querySelectorAll(FIELD_SELECTOR)) {
    if (guardField(field)) credential = true;
  }
  return credential;
}

/**
 * 画面の入力欄を見張って、ブラウザー標準の自動入力を止める。
 * onCredentialFieldsChange は、資格情報の欄が画面にあるかどうかが変わるたびに呼ぶ (最初にも 1 回呼ぶ)。
 * 戻り値の関数で見張りをやめる。
 */
export function startAutofillGuard(
  doc: Document,
  onCredentialFieldsChange?: (present: boolean) => void,
): () => void {
  let present: boolean | null = null;
  const report = (next: boolean) => {
    if (next === present) return;
    present = next;
    onCredentialFieldsChange?.(next);
  };

  report(guardFields(doc));

  const observer = new MutationObserver((records) => {
    let removed = false;
    let added = false;
    for (const record of records) {
      if (record.type === "attributes") {
        // React などが autocomplete を付け直したとき。
        if (isField(record.target) && guardField(record.target)) added = true;
        continue;
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element && guardFields(node)) added = true;
      }
      if (record.removedNodes.length > 0) removed = true;
    }
    if (added) report(true);
    else if (removed && present) report(hasCredentialField(doc));
  });
  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["autocomplete"],
  });
  return () => observer.disconnect();
}

function hasCredentialField(doc: Document): boolean {
  for (const field of doc.querySelectorAll(FIELD_SELECTOR)) {
    if (isCredentialAutocomplete(field.getAttribute("autocomplete"))) {
      return true;
    }
  }
  return false;
}
