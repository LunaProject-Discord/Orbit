// アカウントのアイコン選択で使う、Lucide の全アイコンのデータを作る。
// lucide-react を更新したら `pnpm --filter @orbit/web icons:generate` で作り直す (通信が必要)。
//
// - src/lib/lucide/nodes.json: アイコンの名前 → 図形。アイコンを描くときに読み込む。
// - src/lib/lucide/meta.json: 分類と検索用の語。アイコンを選ぶ画面を開いたときに読み込む。
//
// 図形は入っている lucide-react から取り出す。分類と検索用の語は npm のパッケージに
// 含まれないので、同じ版の Lucide のリポジトリから取得する。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve("lucide-react/package.json"));
const { version } = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
);
const iconsDir = join(packageDir, "dist/esm/icons");
const outDir = fileURLToPath(new URL("../src/lib/lucide", import.meta.url));
const SOURCE = `https://raw.githubusercontent.com/lucide-icons/lucide/${version}`;
const CONCURRENCY = 24;

async function fetchJson(path) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${SOURCE}/${path}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

async function mapConcurrently(items, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await task(items[index]);
      }
    }),
  );
  return results;
}

// 別名のファイル (home.mjs → house.mjs など) は __iconData を持たないので、ここで除かれる。
const nodes = {};
const files = readdirSync(iconsDir)
  .filter((file) => file.endsWith(".mjs"))
  .sort();
for (const file of files) {
  const name = file.slice(0, -".mjs".length);
  const source = readFileSync(join(iconsDir, file), "utf8");
  if (!source.includes("__iconData = ")) continue;
  const module = await import(pathToFileURL(join(iconsDir, file)).href);
  if (module.__iconData.name !== name) {
    throw new Error(`${file}: 名前が一致しません (${module.__iconData.name})`);
  }
  // key は React が並びを見分けるためのもの。描く側で順番から付け直す。
  nodes[name] = module.__iconData.node.map(([tag, { key: _key, ...attrs }]) => [
    tag,
    attrs,
  ]);
}
const names = Object.keys(nodes);

const details = new Map(
  await mapConcurrently(names, async (name) => {
    const detail = await fetchJson(`icons/${name}.json`);
    if (!detail) throw new Error(`${name}: 分類の情報がありません`);
    return [name, detail];
  }),
);

// 検索用の語には、語の集まり ($group:名前) と、ほかのアイコンの引き継ぎ ($extends:名前) が
// 混ざっている。分類にも引き継ぎがある。どちらも展開する。
const GROUP = "$group:";
const EXTENDS = "$extends:";
const groupNames = new Set();
for (const detail of details.values()) {
  for (const tag of detail.tags ?? []) {
    if (tag.startsWith(GROUP)) groupNames.add(tag.slice(GROUP.length));
  }
}
const groups = new Map();
for (let pending = [...groupNames]; pending.length > 0; ) {
  const loaded = await mapConcurrently(pending, async (name) => {
    const detail = await fetchJson(`groups/${name}.json`);
    if (!detail) throw new Error(`${name}: 語の集まりがありません`);
    return [name, detail.tags ?? []];
  });
  pending = [];
  for (const [name, tags] of loaded) {
    groups.set(name, tags);
    for (const tag of tags) {
      const nested = tag.startsWith(GROUP) ? tag.slice(GROUP.length) : null;
      if (nested && !groups.has(nested)) pending.push(nested);
    }
  }
}

function resolve(field, values, seen) {
  return values.flatMap((value) => {
    if (value.startsWith(EXTENDS)) {
      const name = value.slice(EXTENDS.length);
      if (seen.has(name)) return [];
      const detail = details.get(name);
      if (!detail) throw new Error(`${value}: 引き継ぎ元がありません`);
      return resolve(field, detail[field] ?? [], new Set([...seen, name]));
    }
    if (value.startsWith(GROUP)) {
      const name = `${GROUP}${value.slice(GROUP.length)}`;
      if (seen.has(name)) return [];
      return resolve(
        field,
        groups.get(value.slice(GROUP.length)) ?? [],
        new Set([...seen, name]),
      );
    }
    return [value];
  });
}
const resolved = names.map((name) => {
  const detail = details.get(name);
  return {
    categories: [
      ...new Set(
        resolve("categories", detail.categories ?? [], new Set([name])),
      ),
    ],
    tags: [
      ...new Set([
        // 以前の名前 (home → house など) でも探せるようにする。
        ...(detail.aliases ?? []).map((alias) => alias.name),
        ...resolve("tags", detail.tags ?? [], new Set([name])),
      ]),
    ],
  };
});

const categoryNames = [
  ...new Set(resolved.flatMap((item) => item.categories)),
].sort();
const categories = await mapConcurrently(categoryNames, async (name) => {
  const detail = await fetchJson(`categories/${name}.json`);
  if (!detail) throw new Error(`${name}: 分類の情報がありません`);
  if (!(detail.icon in nodes))
    throw new Error(`${name}: 分類のアイコンがありません`);
  return { name, title: detail.title, icon: detail.icon };
});

const meta = {
  version,
  categories,
  // [名前, 分類の番号, 検索用の語]
  icons: names.map((name, index) => [
    name,
    resolved[index].categories.map((category) =>
      categoryNames.indexOf(category),
    ),
    resolved[index].tags.join(" "),
  ]),
};

writeFileSync(join(outDir, "nodes.json"), `${JSON.stringify(nodes)}\n`);
writeFileSync(join(outDir, "meta.json"), `${JSON.stringify(meta)}\n`);
console.log(
  `lucide ${version}: ${names.length} icons, ${categories.length} categories`,
);
