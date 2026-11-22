/**
 * アイコンを選ぶ画面のための、Lucide の全アイコンの分類と検索。
 * 元のデータ (meta.json) は scripts/generate-lucide-icons.mjs が作る。
 */

/** meta.json の中身。 */
export type IconMeta = {
  /** データの元になった lucide の版。 */
  version: string;
  categories: readonly { name: string; title: string; icon: string }[];
  /** [名前, 分類の番号 (categories の位置), 検索用の語 (空白区切り)] */
  icons: readonly (readonly [string, readonly number[], string])[];
};

export type IconCategory = {
  name: string;
  /** 画面に出す名前。 */
  label: string;
  /** 分類を表すアイコンの名前。 */
  icon: string;
  /** 分類に入っているアイコンの名前。 */
  icons: readonly string[];
};

export type IconCatalog = {
  categories: readonly IconCategory[];
  /** 検索用。名前と、探すときに照らし合わせる文字列。 */
  entries: readonly IconEntry[];
  names: ReadonlySet<string>;
};

type IconEntry = {
  name: string;
  /** 名前の「-」を空白にしたもの。 */
  words: string;
  /** 検索用の語と、分類の名前 (英語と日本語)。 */
  tags: string;
};

/**
 * 分類の日本語の名前。この並びの順に画面へ出す
 * (メールのアカウントに付けるものなので、関係の深い分類を先にしている)。
 * ここに無い分類が増えたら、英語の名前のまま最後に出す。
 */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  mail: "メール",
  account: "アカウント",
  communication: "コミュニケーション",
  people: "人",
  emoji: "顔",
  social: "ソーシャル",
  home: "家・暮らし",
  buildings: "建物",
  finance: "お金",
  shopping: "買い物",
  education: "教育",
  development: "開発",
  devices: "デバイス",
  gaming: "ゲーム",
  multimedia: "マルチメディア",
  photography: "写真",
  design: "デザイン",
  "food-beverage": "食べ物・飲み物",
  animals: "動物",
  nature: "自然",
  weather: "天気",
  travel: "旅行",
  transportation: "乗り物",
  navigation: "地図・場所",
  logistics: "物流",
  sports: "スポーツ",
  medical: "医療",
  science: "科学",
  time: "時間・カレンダー",
  notifications: "通知",
  security: "セキュリティ",
  connectivity: "接続",
  ai: "AI",
  tools: "道具",
  files: "ファイル",
  text: "文字の書式",
  "letters-digits": "文字・数字",
  math: "数学",
  charts: "グラフ",
  layout: "レイアウト",
  shapes: "図形",
  arrows: "矢印",
  cursors: "カーソル",
  accessibility: "アクセシビリティ",
  sustainability: "環境",
};

/**
 * 日本語で探すための言い換え。検索用の語は英語しか無いので、よく使いそうな言葉だけ
 * 英語に置き換えて探す。分類の日本語の名前 (「動物」など) は、これとは別に探せる。
 */
export const JAPANESE_WORDS: Readonly<Record<string, string>> = {
  メール: "mail",
  手紙: "mail",
  封筒: "mail",
  受信: "inbox",
  送信: "send",
  人: "user",
  個人: "user",
  自分: "user",
  ユーザー: "user",
  家族: "users",
  グループ: "users",
  友達: "users",
  仕事: "briefcase",
  かばん: "briefcase",
  会社: "building",
  ビル: "building",
  家: "house",
  ホーム: "house",
  学校: "school",
  大学: "university",
  勉強: "graduation",
  卒業: "graduation",
  ハート: "heart",
  好き: "heart",
  星: "star",
  スター: "star",
  買い物: "shopping",
  ショッピング: "shopping",
  カート: "cart",
  店: "store",
  お金: "money",
  財布: "wallet",
  銀行: "bank",
  カード: "card",
  コード: "code",
  開発: "code",
  プログラム: "code",
  ゲーム: "gamepad",
  地球: "globe",
  世界: "globe",
  ウェブ: "globe",
  本: "book",
  読書: "book",
  音楽: "music",
  カメラ: "camera",
  写真: "image",
  画像: "image",
  動画: "video",
  映画: "film",
  飛行機: "plane",
  旅行: "plane",
  車: "car",
  電車: "train",
  自転車: "bike",
  船: "ship",
  道具: "wrench",
  工具: "wrench",
  設定: "settings",
  ベル: "bell",
  通知: "bell",
  お知らせ: "bell",
  電話: "phone",
  スマホ: "smartphone",
  パソコン: "laptop",
  コンピューター: "computer",
  サーバー: "server",
  クラウド: "cloud",
  雲: "cloud",
  太陽: "sun",
  月: "moon",
  雨: "rain",
  雪: "snow",
  花: "flower",
  木: "tree",
  葉: "leaf",
  犬: "dog",
  猫: "cat",
  鳥: "bird",
  魚: "fish",
  食べ物: "food",
  コーヒー: "coffee",
  ケーキ: "cake",
  ピザ: "pizza",
  鍵: "key",
  カギ: "key",
  ロック: "lock",
  盾: "shield",
  安全: "shield",
  旗: "flag",
  ピン: "pin",
  地図: "map",
  時計: "clock",
  時間: "clock",
  カレンダー: "calendar",
  予定: "calendar",
  プレゼント: "gift",
  ギフト: "gift",
  王冠: "crown",
  トロフィー: "trophy",
  ロケット: "rocket",
  火: "flame",
  炎: "flame",
  雷: "zap",
  稲妻: "zap",
  電気: "zap",
  電球: "lightbulb",
  アイデア: "lightbulb",
  笑顔: "smile",
  顔: "face",
  目: "eye",
  手: "hand",
  病院: "hospital",
  薬: "pill",
  ニュース: "newspaper",
  新聞: "newspaper",
  チャット: "message",
  メッセージ: "message",
  吹き出し: "message",
  フォルダ: "folder",
  フォルダー: "folder",
  ファイル: "file",
  書類: "file",
  ゴミ箱: "trash",
  ごみ箱: "trash",
  アーカイブ: "archive",
  箱: "box",
  荷物: "package",
  タグ: "tag",
  ラベル: "tag",
  しおり: "bookmark",
  ブックマーク: "bookmark",
  ペン: "pen",
  鉛筆: "pencil",
  ロボット: "bot",
  虫: "bug",
  バグ: "bug",
  検索: "search",
  矢印: "arrow",
  チェック: "check",
  丸: "circle",
  四角: "square",
  三角: "triangle",
};

/** meta.json の内容を、画面で使いやすい形に直す。 */
export function buildIconCatalog(meta: IconMeta): IconCatalog {
  const order = Object.keys(CATEGORY_LABELS);
  const categories = meta.categories.map((category) => ({
    name: category.name,
    label: CATEGORY_LABELS[category.name] ?? category.title,
    title: category.title,
    icon: category.icon,
    icons: [] as string[],
  }));
  const entries = meta.icons.map(([name, categoryIndexes, tags]) => {
    const labels: string[] = [];
    for (const index of categoryIndexes) {
      const category = categories[index];
      if (!category) continue;
      category.icons.push(name);
      labels.push(category.title, category.label);
    }
    return {
      name,
      words: name.replaceAll("-", " "),
      // 語の先頭を探せるように、先頭にも空白を置く。
      tags: ` ${tags} ${labels.join(" ")}`.toLowerCase().replaceAll("-", " "),
    };
  });
  const position = (name: string) => {
    const index = order.indexOf(name);
    return index < 0 ? order.length : index;
  };
  return {
    categories: categories
      .filter((category) => category.icons.length > 0)
      .sort((a, b) => position(a.name) - position(b.name))
      .map(({ name, label, icon, icons }) => ({ name, label, icon, icons })),
    entries,
    names: new Set(entries.map((entry) => entry.name)),
  };
}

/** 探す言葉を、照らし合わせる語の並びに直す。日本語の言葉は英語にも置き換える。 */
function searchTerms(query: string): string[][] {
  return query
    .normalize("NFKC")
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((term) => term !== "")
    .map((term) => {
      const english = JAPANESE_WORDS[term];
      return english ? [term, english] : [term];
    });
}

/**
 * 検索用の語に当てはまるか。英語は語の先頭から合うものだけにする
 * (途中でも合わせると、cat で location や communication まで出てしまう)。
 * 日本語 (分類の名前) は語の区切りがはっきりしないので、途中でも合わせる。
 */
function matchesTag(tags: string, term: string): boolean {
  return /^[\x20-\x7e]+$/.test(term)
    ? tags.includes(` ${term}`)
    : tags.includes(term);
}

/**
 * アイコンを探す。空白で区切った言葉のすべてに当てはまるものを、合い方の良い順に返す
 * (名前そのもの → 名前の単語の先頭 → 名前の途中 → 検索用の語)。
 */
export function searchIcons(catalog: IconCatalog, query: string): string[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const full = terms.map((term) => term[term.length - 1]).join(" ");
  const found: { name: string; score: number }[] = [];
  for (const entry of catalog.entries) {
    let total = entry.words === full ? -10 : 0;
    let matched = true;
    for (const alternatives of terms) {
      let best = Number.POSITIVE_INFINITY;
      for (const term of alternatives) {
        const at = entry.words.indexOf(term);
        if (at === 0) best = Math.min(best, 0);
        else if (at > 0 && entry.words[at - 1] === " ")
          best = Math.min(best, 1);
        else if (at > 0) best = Math.min(best, 2);
        else if (matchesTag(entry.tags, term)) best = Math.min(best, 3);
      }
      if (best === Number.POSITIVE_INFINITY) {
        matched = false;
        break;
      }
      total += best;
    }
    if (matched) found.push({ name: entry.name, score: total });
  }
  // 同じ合い方なら、短い名前 (より基本的なアイコン) を先にする。
  return found
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name),
    )
    .map((item) => item.name);
}

let loading: Promise<IconCatalog> | null = null;

/** 分類と検索用のデータを読み込む。2 回目からは同じものを返す。 */
export function loadIconCatalog(): Promise<IconCatalog> {
  loading ??= import("./meta.json")
    .then((module) => buildIconCatalog(module.default as unknown as IconMeta))
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

const RECENT_KEY = "mail.account-icon-recent.v1";
/** 最近使ったアイコンを覚えておく数。 */
export const RECENT_LIMIT = 18;

/** 最近使ったアイコンの名前 (新しい順)。端末ごとに覚える。 */
export function readRecentIcons(): string[] {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(RECENT_KEY) ?? "[]",
    );
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((name): name is string => typeof name === "string")
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** 使ったアイコンを、最近使ったものの先頭に加える。 */
export function addRecentIcon(name: string): string[] {
  const next = [
    name,
    ...readRecentIcons().filter((other) => other !== name),
  ].slice(0, RECENT_LIMIT);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // 保存できなくても、選ぶこと自体には影響しない。
  }
  return next;
}

/** 一覧の 1 行。見出しか、アイコンの並び。 */
export type IconRow =
  | { kind: "heading"; section: string; label: string }
  | {
      kind: "icons";
      section: string;
      names: readonly string[];
      /** この行の先頭のアイコンが、一覧全体で何番目か。 */
      offset: number;
    };

/** 見出し付きの区切りを、決まった列数の行に並べる。 */
export function layoutIconRows(
  sections: readonly { id: string; label: string; icons: readonly string[] }[],
  columns: number,
): { rows: IconRow[]; count: number } {
  const rows: IconRow[] = [];
  let offset = 0;
  for (const section of sections) {
    if (section.icons.length === 0) continue;
    rows.push({ kind: "heading", section: section.id, label: section.label });
    for (let start = 0; start < section.icons.length; start += columns) {
      const names = section.icons.slice(start, start + columns);
      rows.push({ kind: "icons", section: section.id, names, offset });
      offset += names.length;
    }
  }
  return { rows, count: offset };
}
