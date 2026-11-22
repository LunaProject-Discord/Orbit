/**
 * 絵文字を選ぶ画面のための、全絵文字の分類と検索。
 * 元のデータ (data.json) は scripts/generate-emoji.mjs が emojibase-data から作る。
 * 大きいので画面の本体には含めず、選ぶ画面を開いたときに読み込む。
 */

/** data.json の中身。 */
export type EmojiData = {
  /** データの元になった emojibase-data の版。 */
  version: string;
  groups: readonly { key: string; label: string }[];
  /** [絵文字, 分類の番号, 加わった版, 名前, 英語の名前, 検索用の語, 肌の色ごとの絵文字 (薄い順、あるものだけ)] */
  emojis: readonly (
    | readonly [string, number, number, string, string, string]
    | readonly [
        string,
        number,
        number,
        string,
        string,
        string,
        readonly string[],
      ]
  )[];
};

export type EmojiEntry = {
  /** 標準の色の絵文字。 */
  emoji: string;
  /** 名前 (日本語)。 */
  label: string;
  /** 名前を探しやすくしたもの (ひらがなをカタカナに揃える)。 */
  labelKey: string;
  /** 英語の名前 (小文字)。探すときに使う。 */
  english: string;
  /** 検索用の語 (日本語と英語、空白区切り、小文字、ひらがなはカタカナ)。先頭にも空白がある。 */
  words: string;
  /** 肌の色ごとの絵文字 (薄い順に 5 つ)。色を変えられなければ空。 */
  skins: readonly string[];
};

export type EmojiCatalog = {
  groups: readonly { key: string; label: string; emojis: readonly string[] }[];
  /** 標準の色の絵文字 → 中身。 */
  entries: ReadonlyMap<string, EmojiEntry>;
  /** 肌の色を変えた絵文字 → 標準の色の絵文字。 */
  bases: ReadonlyMap<string, string>;
};

/** 肌の色。0 は標準 (黄色)、1 (薄い) 〜 5 (濃い)。 */
export type SkinTone = 0 | 1 | 2 | 3 | 4 | 5;

export const SKIN_TONES: readonly { tone: SkinTone; label: string }[] = [
  { tone: 0, label: "標準の色" },
  { tone: 1, label: "薄い肌色" },
  { tone: 2, label: "やや薄い肌色" },
  { tone: 3, label: "中間の肌色" },
  { tone: 4, label: "やや濃い肌色" },
  { tone: 5, label: "濃い肌色" },
];

/** 絵文字を、端末の絵文字用のフォントで出すための指定。 */
export const EMOJI_FONT_FAMILY =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';

/** ひらがなをカタカナに揃える (「ねこ」でも「ネコ」でも探せるように)。 */
function toKatakana(text: string): string {
  return text.replace(/[\u3041-\u3096]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0x60),
  );
}

/**
 * data.json の内容を、画面で使いやすい形に直す。
 * maxVersion を渡すと、それより新しい版で加わった絵文字を除く (端末が出せないもの)。
 */
export function buildEmojiCatalog(
  data: EmojiData,
  maxVersion = Number.POSITIVE_INFINITY,
): EmojiCatalog {
  const groups = data.groups.map((group) => ({
    key: group.key,
    label: group.label,
    emojis: [] as string[],
  }));
  const entries = new Map<string, EmojiEntry>();
  const bases = new Map<string, string>();
  for (const item of data.emojis) {
    const [emoji, group, version, label, english, words, skins = []] = item;
    if (version > maxVersion) continue;
    groups[group]?.emojis.push(emoji);
    entries.set(emoji, {
      emoji,
      label,
      labelKey: toKatakana(label),
      english,
      words: toKatakana(` ${words}`),
      skins,
    });
    for (const skin of skins) bases.set(skin, emoji);
  }
  return {
    groups: groups.filter((group) => group.emojis.length > 0),
    entries,
    bases,
  };
}

/**
 * 端末が出せる、いちばん新しい絵文字の版を調べる。
 * 版ごとに 1 つ絵文字を描いてみて、幅が普通の絵文字と同じなら出せるとみなす
 * (出せない絵文字は、四角や複数の絵文字に分かれて描かれ、幅が変わる)。
 * 調べられない環境では、すべて出せるものとして扱う。
 */
export function detectEmojiVersion(data: EmojiData): number {
  if (typeof document === "undefined") return Number.POSITIVE_INFINITY;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return Number.POSITIVE_INFINITY;
  context.font = `100px ${EMOJI_FONT_FAMILY}`;
  const baseline = context.measureText("😀").width;
  if (!(baseline > 0)) return Number.POSITIVE_INFINITY;
  // 版ごとの見本。つなぎの文字を含まない、短いものを選ぶ。
  const samples = new Map<number, string>();
  for (const [emoji, , version] of data.emojis) {
    const current = samples.get(version);
    if (current === undefined || emoji.length < current.length) {
      samples.set(version, emoji);
    }
  }
  let supported = 0;
  for (const version of [...samples.keys()].sort((a, b) => a - b)) {
    const width = context.measureText(samples.get(version) ?? "").width;
    // 古い版が出せて新しい版が出せないことはあっても、その逆はほぼ無いので、出せなくなった所で止める。
    if (Math.abs(width - baseline) > 1) break;
    supported = version;
  }
  return supported > 0 ? supported : Number.POSITIVE_INFINITY;
}

/** 指定した肌の色の絵文字。色を変えられない絵文字は、そのまま返す。 */
export function withSkinTone(
  catalog: EmojiCatalog,
  emoji: string,
  tone: SkinTone,
): string {
  if (tone === 0) return emoji;
  return catalog.entries.get(emoji)?.skins[tone - 1] ?? emoji;
}

/**
 * 絵文字を探す。空白で区切った言葉のすべてに当てはまるものを、合い方の良い順に返す
 * (名前そのもの → 名前の先頭 → 名前の途中 → 検索用の語)。同じ合い方なら、元の並び順。
 * 英語は語の先頭から合うものだけにし、日本語は途中でも合わせる。
 */
export function searchEmojis(catalog: EmojiCatalog, query: string): string[] {
  const terms = query
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/)
    .map(toKatakana)
    .filter((term) => term !== "");
  if (terms.length === 0) return [];
  const found: { emoji: string; score: number; order: number }[] = [];
  let order = 0;
  for (const entry of catalog.entries.values()) {
    order += 1;
    // 絵文字そのものを貼り付けて探すこともできる。
    if (terms.length === 1 && entry.emoji === query.trim()) {
      found.push({ emoji: entry.emoji, score: -1, order });
      continue;
    }
    let total = 0;
    let matched = true;
    for (const term of terms) {
      const score = matchScore(entry, term);
      if (score === null) {
        matched = false;
        break;
      }
      total += score;
    }
    if (matched) found.push({ emoji: entry.emoji, score: total, order });
  }
  return found
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map((item) => item.emoji);
}

/** 言葉が絵文字にどれだけ合うか (小さいほど良い)。合わなければ null。 */
function matchScore(entry: EmojiEntry, term: string): number | null {
  if (entry.labelKey === term || entry.english === term) return 0;
  const ascii = /^[\x20-\x7e]+$/.test(term);
  if (ascii) {
    // 英語は、語の先頭から合うものだけにする。
    if (entry.english.startsWith(term)) return 1;
    if (entry.english.includes(` ${term}`)) return 2;
    return entry.words.includes(` ${term}`) ? 3 : null;
  }
  const at = entry.labelKey.indexOf(term);
  if (at === 0) return 1;
  if (at > 0) return 2;
  return entry.words.includes(term) ? 3 : null;
}

let loading: Promise<EmojiCatalog> | null = null;

/** 絵文字のデータを読み込む。2 回目からは同じものを返す。 */
export function loadEmojiCatalog(): Promise<EmojiCatalog> {
  loading ??= import("./data.json")
    .then((module) => {
      const data = module.default as unknown as EmojiData;
      return buildEmojiCatalog(data, detectEmojiVersion(data));
    })
    .catch((error: unknown) => {
      // 通信できなかったときは、次の機会にもう一度試す。
      loading = null;
      throw error;
    });
  return loading;
}

/** 最近使った絵文字を覚えておく場所 (端末ごと)。 */
export const RECENT_EMOJIS_KEY = "mail.emoji-recent.v1";
const SKIN_TONE_KEY = "mail.emoji-skin-tone.v1";

/** 前に選んだ肌の色。端末ごとに覚える。 */
export function readSkinTone(): SkinTone {
  try {
    const stored = Number(window.localStorage.getItem(SKIN_TONE_KEY));
    return SKIN_TONES.some((item) => item.tone === stored)
      ? (stored as SkinTone)
      : 0;
  } catch {
    return 0;
  }
}

export function saveSkinTone(tone: SkinTone) {
  try {
    window.localStorage.setItem(SKIN_TONE_KEY, String(tone));
  } catch {
    // 保存できなくても、次に開いたときに標準の色へ戻るだけ。
  }
}

/**
 * アカウントのアイコンとして保存された値が、絵文字か。
 * アイコンの名前は小文字の英数字とハイフンだけなので、それ以外を絵文字として扱う。
 */
export function isEmojiIcon(value: string): boolean {
  return !/^[a-z0-9-]+$/.test(value);
}
