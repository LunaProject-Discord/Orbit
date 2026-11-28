import { cn } from "cn";
import { useId } from "react";
import {
  MOON_PATH,
  WORDMARK_CALENDAR,
  WORDMARK_CONTACTS,
  WORDMARK_MAIL,
  WORDMARK_ORBIT,
} from "./brand-data";

/** Orbit のアプリ。 */
export type OrbitProduct = "mail" | "calendar" | "contacts";
/** ロゴの種類。orbit は製品名の付かない Orbit 全体 (管理画面など)。 */
export type OrbitBrand = OrbitProduct | "orbit";

/** 製品ごとの色。from → to が明るい背景とタイル、tint → tintTo が暗い背景。 */
const COLORS: Record<
  OrbitBrand,
  { from: string; to: string; tint: string; tintTo: string }
> = {
  orbit: {
    from: "#2B2F45",
    to: "#12141F",
    tint: "#FFFFFF",
    tintTo: "#C9CEE8",
  },
  mail: { from: "#5B5BF0", to: "#8B5CF6", tint: "#A5A8FF", tintTo: "#8B5CF6" },
  calendar: {
    from: "#F9603A",
    to: "#F43F7A",
    tint: "#FF9A7A",
    tintTo: "#F43F7A",
  },
  contacts: {
    from: "#0FA58F",
    to: "#22B8CF",
    tint: "#5FE0CC",
    tintTo: "#22B8CF",
  },
};

const WORDMARKS: Record<OrbitProduct, { d: string; width: number }> = {
  mail: WORDMARK_MAIL,
  calendar: WORDMARK_CALENDAR,
  contacts: WORDMARK_CONTACTS,
};

const NAMES: Record<OrbitBrand, string> = {
  orbit: "Orbit",
  mail: "Orbit Mail",
  calendar: "Orbit Calendar",
  contacts: "Orbit Contacts",
};

/** 輪の中のモチーフ (Mail = 封筒の折り目、Calendar = 暦の線と日の点、Contacts = 人)。 */
function Motif({
  product,
  inside,
  ink,
}: {
  product: OrbitBrand;
  inside: string;
  ink: string;
}) {
  // Orbit 全体の記号は、輪と月だけ。
  if (product === "orbit") return null;
  if (product === "mail") {
    return (
      <path
        d="M127.7 190.63L256 282L384.3 190.63"
        strokeWidth="38"
        strokeLinejoin="round"
      />
    );
  }
  if (product === "calendar") {
    const dots: [number, number, number][] = [
      [-52, 6, 1],
      [0, 6, 1],
      [52, 6, 1],
      [-52, 58, 1],
      [0, 58, 0.45],
    ];
    return (
      <>
        <path d="M116 204H396" strokeWidth="34" clipPath={`url(#${inside})`} />
        {dots.map(([x, y, opacity]) => (
          <circle
            key={`${x},${y}`}
            cx={256 + x}
            cy={256 + y}
            r="17"
            stroke="none"
            fill={ink}
            opacity={opacity}
          />
        ))}
      </>
    );
  }
  return (
    <>
      <circle cx="256" cy="222" r="46" stroke="none" fill={ink} />
      <path
        d="M160 386a96 84 0 0 1 192 0z"
        stroke="none"
        fill={ink}
        clipPath={`url(#${inside})`}
      />
    </>
  );
}

/**
 * 記号 (軌道の輪とモチーフ、衛星として乗る Luna Project の月) の中身。512 × 512 の座標。
 * 形の元は assets/brand/build.mjs。数値を変えるときは両方をそろえる。
 */
function Glyph({
  product,
  ink,
}: {
  product: OrbitBrand;
  /** 線と点の色 (url(#…) か色の値)。 */
  ink: string;
}) {
  const id = useId();
  const gap = `${id}-gap`;
  const inside = `${id}-inside`;
  return (
    <>
      <defs>
        <clipPath id={inside}>
          <circle cx="256" cy="256" r="146" />
        </clipPath>
        {/* 月のまわりは輪を抜いて、月が輪に乗って見えるようにする。 */}
        <mask id={gap}>
          <rect width="512" height="512" fill="#fff" />
          <circle cx="373.42" cy="361.72" r="74" fill="#000" />
        </mask>
      </defs>
      <g mask={`url(#${gap})`} fill="none" stroke={ink}>
        <Motif product={product} inside={inside} ink={ink} />
        <circle cx="256" cy="256" r="150" strokeWidth="44" />
      </g>
      <path
        transform="translate(319.14 302.84) scale(0.46)"
        d={MOON_PATH}
        fill="#ffc636"
      />
    </>
  );
}

/** 記号だけ (背景なし)。色は明るい背景と暗い背景で切り替わる。 */
export function OrbitMark({
  className,
  product = "mail",
}: {
  className?: string;
  product?: OrbitBrand;
}) {
  const id = useId();
  const ink = `${id}-ink`;
  const color = COLORS[product];
  return (
    <svg
      viewBox="64 64 400 400"
      aria-hidden="true"
      className={cn("size-6 shrink-0", className)}
    >
      <defs>
        <linearGradient id={ink} x1="0" y1="0" x2="1" y2="1">
          <stop
            offset="0"
            stopColor={color.from}
            className="dark:[stop-color:var(--orbit-tint)]"
            style={{ ["--orbit-tint" as string]: color.tint }}
          />
          <stop
            offset="1"
            stopColor={color.to}
            className="dark:[stop-color:var(--orbit-tint-to)]"
            style={{ ["--orbit-tint-to" as string]: color.tintTo }}
          />
        </linearGradient>
      </defs>
      <Glyph product={product} ink={`url(#${ink})`} />
    </svg>
  );
}

/** アプリのアイコン (角丸のタイルに白い記号)。アプリの切り替えメニューで使う。 */
export function OrbitAppIcon({
  className,
  product,
}: {
  className?: string;
  product: OrbitProduct;
}) {
  const id = useId();
  const tile = `${id}-tile`;
  const color = COLORS[product];
  return (
    <svg
      viewBox="0 0 512 512"
      aria-hidden="true"
      className={cn("size-8 shrink-0", className)}
    >
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={color.from} />
          <stop offset="1" stopColor={color.to} />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill={`url(#${tile})`} />
      <g transform="translate(256 256) scale(0.88) translate(-256 -256)">
        <Glyph product={product} ink="#fff" />
      </g>
    </svg>
  );
}

/** 「Orbit」と製品名の間の空き (文字のパスと同じ 100 単位)。 */
const WORD_GAP = 27;

/**
 * 横組みのロゴ (記号 + 「Orbit Mail」など)。文字は LINE Seed をパスにしたもので、色は文字色に従う。
 * 大きさは className の高さ (h-6 など) で決める。
 */
export function OrbitLogo({
  className,
  product = "mail",
}: {
  className?: string;
  product?: OrbitBrand;
}) {
  const name = product === "orbit" ? null : WORDMARKS[product];
  const width = WORDMARK_ORBIT.width + (name ? WORD_GAP + name.width : 0);
  return (
    <span
      role="img"
      aria-label={NAMES[product]}
      className={cn("inline-flex h-6 items-center gap-[0.35em]", className)}
    >
      <OrbitMark product={product} className="size-auto h-full" />
      <svg
        viewBox={`0 -80 ${width} 84`}
        aria-hidden="true"
        className="h-[62%] w-auto shrink-0 fill-current"
      >
        <path d={WORDMARK_ORBIT.d} />
        {name && (
          <path
            d={name.d}
            transform={`translate(${WORDMARK_ORBIT.width + WORD_GAP} 0)`}
            opacity="0.7"
          />
        )}
      </svg>
    </span>
  );
}

/**
 * 2 段組みのロゴの配置 (高さ 1000 の座標)。記号の輪の上端 (50) に「Orbit」の文字の上端を、
 * 輪の下端 (910) に製品名の並びの線 (ベースライン) をそろえる。assets/brand/build.mjs と同じ数値。
 */
export const STACKED = {
  /** 記号の右端から文字までの空き。 */
  textX: 1175,
  /** 記号を下へずらす量。輪の下に月がある分、目には上に寄って見えるので少し下げる。 */
  markY: 25,
  orbitScale: 3.8095,
  /** 「Orbit」の文字の上端は並びの線から 78 上 (wordmark の形の値)。 */
  orbitBaseline: 50 + 78 * 3.8095,
  nameScale: 5.7143,
  nameBaseline: 910,
} as const;

/**
 * 2 段組みのロゴ (記号 + 小さめの「Orbit」の下に製品名)。横組みより幅が狭いので、
 * サイドバーのロゴの行 (信号機や開閉ボタンと並ぶ所) で使う。大きさは className の高さで決める。
 * 文字の色は文字色に従い、「Orbit」は 70% の濃さ。
 */
export function OrbitStackedLogo({
  className,
  product = "mail",
}: {
  className?: string;
  product?: OrbitProduct;
}) {
  const id = useId();
  const ink = `${id}-ink`;
  const color = COLORS[product];
  const name = WORDMARKS[product];
  const width = Math.ceil(
    STACKED.textX +
      Math.max(
        WORDMARK_ORBIT.width * STACKED.orbitScale,
        name.width * STACKED.nameScale,
      ),
  );
  return (
    <svg
      role="img"
      aria-label={NAMES[product]}
      viewBox={`0 0 ${width} 1000`}
      className={cn("h-6 w-auto shrink-0 fill-current", className)}
    >
      <defs>
        <linearGradient id={ink} x1="0" y1="0" x2="1" y2="1">
          <stop
            offset="0"
            stopColor={color.from}
            className="dark:[stop-color:var(--orbit-tint)]"
            style={{ ["--orbit-tint" as string]: color.tint }}
          />
          <stop
            offset="1"
            stopColor={color.to}
            className="dark:[stop-color:var(--orbit-tint-to)]"
            style={{ ["--orbit-tint-to" as string]: color.tintTo }}
          />
        </linearGradient>
      </defs>
      <g
        transform={`translate(0 ${STACKED.markY}) scale(2.5) translate(-64 -64)`}
      >
        <Glyph product={product} ink={`url(#${ink})`} />
      </g>
      <path
        d={WORDMARK_ORBIT.d}
        transform={`translate(${STACKED.textX} ${STACKED.orbitBaseline}) scale(${STACKED.orbitScale})`}
        opacity="0.7"
      />
      <path
        d={name.d}
        transform={`translate(${STACKED.textX} ${STACKED.nameBaseline}) scale(${STACKED.nameScale})`}
      />
    </svg>
  );
}
