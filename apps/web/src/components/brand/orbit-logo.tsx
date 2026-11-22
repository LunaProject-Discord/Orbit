import { cn } from "cn";
import { useId } from "react";
import { MOON_PATH, WORDMARK_MAIL, WORDMARK_ORBIT } from "./brand-data";

/**
 * Orbit Mail の記号: 軌道の輪 (中は封筒の折り目) と、衛星として乗る Luna Project の月。
 * 形の元は assets/brand/build.mjs。数値を変えるときは両方をそろえる。
 */
export function OrbitMark({ className }: { className?: string }) {
  const id = useId();
  const ink = `${id}-ink`;
  const gap = `${id}-gap`;
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
            className="[stop-color:#5B5BF0] dark:[stop-color:#A5A8FF]"
          />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
        {/* 月のまわりは輪を抜いて、月が輪に乗って見えるようにする。 */}
        <mask id={gap}>
          <rect width="512" height="512" fill="#fff" />
          <circle cx="373.42" cy="361.72" r="74" fill="#000" />
        </mask>
      </defs>
      <g mask={`url(#${gap})`} fill="none" stroke={`url(#${ink})`}>
        <path
          d="M127.7 190.63L256 282L384.3 190.63"
          strokeWidth="38"
          strokeLinejoin="round"
        />
        <circle cx="256" cy="256" r="150" strokeWidth="44" />
      </g>
      <path
        transform="translate(319.14 302.84) scale(0.46)"
        d={MOON_PATH}
        fill="#ffc636"
      />
    </svg>
  );
}

/** 「Orbit」と「Mail」の間の空き (文字のパスと同じ 100 単位)。 */
const WORD_GAP = 27;
const WORDMARK_WIDTH = WORDMARK_ORBIT.width + WORD_GAP + WORDMARK_MAIL.width;

/**
 * 横組みのロゴ (記号 + 「Orbit Mail」)。文字は LINE Seed をパスにしたもので、色は文字色に従う。
 * 大きさは className の高さ (h-6 など) で決める。
 */
export function OrbitLogo({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Orbit Mail"
      className={cn("inline-flex h-6 items-center gap-[0.35em]", className)}
    >
      <OrbitMark className="size-auto h-full" />
      <svg
        viewBox={`0 -80 ${WORDMARK_WIDTH} 84`}
        aria-hidden="true"
        className="h-[62%] w-auto shrink-0 fill-current"
      >
        <path d={WORDMARK_ORBIT.d} />
        <path
          d={WORDMARK_MAIL.d}
          transform={`translate(${WORDMARK_ORBIT.width + WORD_GAP} 0)`}
          opacity="0.7"
        />
      </svg>
    </span>
  );
}
