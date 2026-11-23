import { cn } from "cn";
import { createElement, useEffect, useSyncExternalStore } from "react";

/**
 * Lucide の全アイコンを、名前から描くための仕組み。
 *
 * 全アイコンの図形 (nodes.json、約 2,100 個) は大きいので、画面の本体には含めず、
 * 必要になったときに 1 回だけ読み込む。一度描いたアイコンの図形は端末に覚えておき、
 * 次に開いたときは読み込みを待たずに描く (アカウントのマークがちらつかないようにするため)。
 */

/** アイコンの図形。[要素の名前, 属性] の並び。 */
export type IconNode = readonly (readonly [
  string,
  Readonly<Record<string, string | number>>,
])[];

const STORAGE_KEY = "mail.lucide-nodes.v1";
/** 端末に覚えておくアイコンの数の上限。 */
const REMEMBER_LIMIT = 64;
/** 図形に使われる要素。端末に覚えた内容を読むときに、これ以外は捨てる。 */
const TAGS = new Set([
  "path",
  "circle",
  "rect",
  "line",
  "ellipse",
  "polyline",
  "polygon",
]);

let all: Readonly<Record<string, IconNode>> | null = null;
let loading: Promise<Readonly<Record<string, IconNode>>> | null = null;
let remembered: Map<string, IconNode> | null = null;
const listeners = new Set<() => void>();

function isIconNode(value: unknown): value is IconNode {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        TAGS.has(item[0]) &&
        typeof item[1] === "object" &&
        item[1] !== null &&
        Object.values(item[1]).every(
          (attr) => typeof attr === "string" || typeof attr === "number",
        ),
    )
  );
}

function rememberedNodes(): Map<string, IconNode> {
  if (remembered) return remembered;
  remembered = new Map();
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "null",
    );
    if (stored && typeof stored === "object") {
      for (const [name, node] of Object.entries(stored)) {
        if (isIconNode(node)) remembered.set(name, node);
      }
    }
  } catch {
    // 読めなければ、覚えていないものとして扱う。
  }
  return remembered;
}

function remember(name: string, node: IconNode) {
  const nodes = rememberedNodes();
  if (nodes.get(name) === node) return;
  // 新しいものを後ろに置き、上限を超えたら古いものから忘れる。
  nodes.delete(name);
  nodes.set(name, node);
  while (nodes.size > REMEMBER_LIMIT) {
    const oldest = nodes.keys().next().value;
    if (oldest === undefined) break;
    nodes.delete(oldest);
  }
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(nodes)),
    );
  } catch {
    // 保存できなくても、次に開いたときに読み込み直すだけ。
  }
}

/** 全アイコンの図形を読み込む。2 回目からは同じものを返す。 */
export function loadIconNodes(): Promise<Readonly<Record<string, IconNode>>> {
  loading ??= import("./nodes.json")
    .then((module) => {
      all = module.default as unknown as Record<string, IconNode>;
      for (const listener of listeners) listener();
      return all;
    })
    .catch((error: unknown) => {
      // 通信できなかったときは、次の機会にもう一度試す。
      loading = null;
      throw error;
    });
  return loading;
}

/**
 * 名前に対応する図形。
 * - 図形: 描ける。
 * - null: その名前のアイコンは無い。
 * - undefined: まだ分からない (読み込み中)。
 */
function iconNodeOf(name: string): IconNode | null | undefined {
  if (all) return Object.hasOwn(all, name) ? all[name] : null;
  return rememberedNodes().get(name);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 名前に対応する図形を返す。手元に無ければ読み込み、届いたら描き直す。 */
export function useIconNode(name: string | null): IconNode | null | undefined {
  const node = useSyncExternalStore(
    subscribe,
    () => (name === null ? null : iconNodeOf(name)),
    () => (name === null ? null : undefined),
  );
  useEffect(() => {
    if (name === null) return;
    if (node === undefined) {
      loadIconNodes().catch(() => {});
    } else if (node !== null) {
      remember(name, node);
    }
  }, [name, node]);
  return node;
}

/** 図形からアイコンを描く。見た目は lucide-react のアイコンと同じ。 */
export function LucideSvg({
  node,
  className,
}: {
  node: IconNode;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("lucide", className)}
    >
      {node.map(([tag, attrs], index) =>
        // 図形の並びは変わらないので、順番をそのまま key にする。
        createElement(tag, { ...attrs, key: index }),
      )}
    </svg>
  );
}

/** テスト用。読み込んだ内容と覚えた内容を捨てる。 */
export function resetIconNodesForTest() {
  all = null;
  loading = null;
  remembered = null;
}
