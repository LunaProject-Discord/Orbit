import { cn } from "cn";

/**
 * 回っているアイコン (読み込み中などの印)。アプリのスピナーはすべてこれを使う。
 *
 * CSS の animate-spin で <svg> 要素ごと回すと、ブラウザーは要素を画素の格子に
 * 合わせて描いたうえで、ずれる前の位置を中心に回すことがある。中心が 1px 未満
 * ずれたまま回るので、拡大率が 125% や 150% の画面では円が揺れて見える。
 * ここでは SVG の中の図形を、図の座標 (12, 12) を中心に回す。中心が描いた
 * アイコンの真ん中から動かないので、どこに置いても揺れない。
 *
 * 大きさは className で決める (指定しなければ 16px。ボタンの中ではボタンのアイコンの大きさになる)。
 * 文字と並べて使う前提で、読み上げには出さない (状態は隣の文字で伝える)。
 */
const PATHS = {
  // lucide の LoaderCircle と同じ形
  circle: ["M21 12a9 9 0 1 1-6.219-8.56"],
  // lucide の RefreshCw と同じ形
  refresh: [
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
    "M21 3v5h-5",
    "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
    "M8 16H3v5",
  ],
} as const;

function Spinner({
  className,
  icon = "circle",
  ...props
}: React.ComponentProps<"svg"> & { icon?: keyof typeof PATHS }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={16}
      height={16}
      aria-hidden="true"
      data-slot="spinner"
      className={cn("shrink-0", className)}
      {...props}
    >
      <g>
        {PATHS[icon].map((d) => (
          <path key={d} d={d} />
        ))}
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="1s"
          repeatCount="indefinite"
        />
      </g>
    </svg>
  );
}

export { Spinner };
