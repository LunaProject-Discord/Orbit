// 絵文字を選ぶ画面で使う、全絵文字のデータ (src/lib/emoji/data.json) を作る。
// emojibase-data を更新したら `pnpm --filter @orbit/web emoji:generate` で作り直す (通信は不要)。
//
// emojibase-data の日本語と英語のデータから、画面で使う項目だけを取り出して小さくする。
// 名前と検索用の語は日本語を主にし、英語でも探せるように英語の名前と語も入れる。
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve("emojibase-data/package.json"));
const read = (path) => JSON.parse(readFileSync(join(packageDir, path), "utf8"));
const { version } = read("package.json");
const japanese = read("ja/compact.json");
const english = new Map(
  read("en/compact.json").map((emoji) => [emoji.hexcode, emoji]),
);
const messages = read("ja/messages.json");
// 絵文字が加わった Unicode の版。端末が出せない新しい絵文字を隠すために使う (compact には入っていない)。
const versions = new Map(
  read("ja/data.json").map((emoji) => [emoji.hexcode, emoji.version]),
);

// 肌の色などの部品 (component) は、単独では選ばせない。
const groups = messages.groups
  .filter((group) => group.key !== "component")
  .sort((a, b) => a.order - b.order);
const groupIndex = new Map(groups.map((group, index) => [group.order, index]));

const emojis = japanese
  // 分類の無いもの (地域指標の文字) と部品は除く。
  .filter((emoji) => groupIndex.has(emoji.group))
  .sort((a, b) => a.order - b.order)
  .map((emoji) => {
    const other = english.get(emoji.hexcode);
    const words = [...new Set([...(emoji.tags ?? []), ...(other?.tags ?? [])])];
    // 肌の色を 1 つだけ変えられるもの (5 種類) に限る。2 人それぞれに色があるものは標準の色だけにする。
    const skins =
      emoji.skins?.length === 5 ? emoji.skins.map((skin) => skin.unicode) : [];
    return [
      emoji.unicode,
      groupIndex.get(emoji.group),
      versions.get(emoji.hexcode) ?? 0,
      emoji.label,
      (other?.label ?? "").toLowerCase(),
      words.join(" ").toLowerCase(),
      ...(skins.length > 0 ? [skins] : []),
    ];
  });

const data = {
  version,
  groups: groups.map((group) => ({ key: group.key, label: group.message })),
  // [絵文字, 分類の番号, 加わった版, 名前, 英語の名前, 検索用の語, 肌の色ごとの絵文字 (薄い順、あるものだけ)]
  emojis,
};
const out = fileURLToPath(
  new URL("../src/lib/emoji/data.json", import.meta.url),
);
writeFileSync(out, `${JSON.stringify(data)}\n`);
console.log(`emojibase-data ${version}: ${emojis.length} emojis`);
