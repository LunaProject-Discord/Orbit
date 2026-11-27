import type { LocalFont } from "@/lib/local-fonts";

/** 設定で選ぶフォントの種類 (ゴシック体・明朝体・等幅)。 */
export type FontKind = "sans" | "serif" | "mono";

/**
 * 等幅のフォントの名前。等幅かどうかが分からない環境 (ブラウザー) のため、名前でも見分ける。
 * 「Noto Sans Mono」のように Sans を含むものもあるので、ゴシック体より先に調べる。
 */
const MONO_NAME =
  /mono(?!type|line)|\b(code|console|consolas|courier|menlo|monaco|terminal|typewriter|inconsolata|iosevka|hack|cica|ricty|myrica|hackgen|plemoljp|firge|udev gothic|cascadia|andale|sfmono)\b|sfmono|等幅|白源/i;

/** 明朝体 (セリフ体) のフォントの名前。「Sans Serif」は含めない。 */
const SERIF_NAME =
  /(?<!sans[\s-]?)serif|mincho|明朝|明體|宋体|宋體|\b(ming|song|songti|times|georgia|garamond|baskerville|bodoni|didot|cambria|palatino|book antiqua|bookman|constantia|rockwell|charter|merriweather|lora|playfair|batang|myeongjo|caslon|minion|hoefler|new york|sitka|kyokasho|shippori|kaisei|antiqua)\b|century(?! gothic)|教科書/i;

/** ゴシック体 (サンセリフ体) のフォントの名前。 */
const SANS_NAME =
  /sans\b|gothic|ゴシック|角ゴ|丸ゴ|黑体|黑體|黒体|\b(hei|heiti|arial|helvetica|verdana|segoe|meiryo|inter|roboto|gen interface|tahoma|calibri|candara|corbel|bahnschrift|lato|ubuntu|cantarell|frutiger|futura|avenir|trebuchet|franklin|lucida grande|system-ui|sf pro|kosugi|m plus|ibm plex sans|yahei|jhenghei|dengxian|malgun|pretendard|montserrat|poppins|nunito|raleway|manrope|figtree|geist|line seed|biz udp?gothic|murecho|zen kaku)\b|メイリオ|游ゴシック|等線|源ノ角|源真|UD デジタル|UDデジタル/i;

/** 絵文字や記号のフォント。等幅の印が付いていても、どの種類にも入れない。 */
const SYMBOL_NAME =
  /emoji|symbol|dingbat|wingdings|webdings|marlett|\b(icons?|awesome|material)\b/i;

/**
 * フォントがどの種類に当たるか (いくつも当たることがある。例: MS ゴシックはゴシック体で等幅)。
 * 名前から見分け、名前で分からなければフォントのファイルに書かれている分類を使う。
 * どれにも当たらないフォント (分類の分からないもの、筆記体や記号のフォントなど) は空になる。
 */
export function fontKinds(
  font: Pick<LocalFont, "family" | "label" | "monospace" | "kind">,
): Set<FontKind> {
  const name = `${font.family} ${font.label}`;
  const kinds = new Set<FontKind>();
  if (font.kind === "symbol" || SYMBOL_NAME.test(name)) return kinds;
  const monoName = MONO_NAME.test(name);
  if (font.monospace === true || monoName) kinds.add("mono");
  // 等幅の名前のフォント (Noto Sans Mono、Courier など) は、等幅だけに入れる。
  if (monoName) return kinds;
  if (SERIF_NAME.test(name)) kinds.add("serif");
  else if (SANS_NAME.test(name)) kinds.add("sans");
  else if (font.kind === "serif" || font.kind === "sans") kinds.add(font.kind);
  return kinds;
}

/** そのフォントが、指定した種類に合うか。 */
export function matchesFontKind(
  font: Pick<LocalFont, "family" | "label" | "monospace" | "kind">,
  kind: FontKind,
): boolean {
  return fontKinds(font).has(kind);
}
