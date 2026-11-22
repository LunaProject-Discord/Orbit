/**
 * 色の計算。アカウントの色を自由に選ぶ画面 (components/mail/color-picker.tsx) と、
 * 選んだ色を画面の配色に合わせて読みやすくする調整 (lib/account-colors.ts) で使う。
 * 色は "#rrggbb" (小文字) の文字列で受け渡す。
 */

export type Rgb = { r: number; g: number; b: number };
/** 色相 h は 0〜360、彩度 s と明るさ v は 0〜1。 */
export type Hsv = { h: number; s: number; v: number };

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * 入力された文字列を "#rrggbb" に直す。色として読めなければ null。
 * 「#」は無くてもよく、3 桁 (#f80) や全角・大文字でも受け付ける。
 */
export function normalizeHex(input: string): string | null {
  const text = input.normalize("NFKC").trim().toLowerCase().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/.test(text)) return `#${text}`;
  if (/^[0-9a-f]{3}$/.test(text)) {
    return `#${[...text].map((digit) => digit + digit).join("")}`;
  }
  return null;
}

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((channel) =>
      clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0"),
    )
    .join("")}`;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max / 255 };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    return 255 * (v - v * s * clamp(Math.min(k, 4 - k), 0, 1));
  };
  return { r: channel(5), g: channel(3), b: channel(1) };
}

export const hexToHsv = (hex: string): Hsv => rgbToHsv(hexToRgb(hex));
export const hsvToHex = (hsv: Hsv): string => rgbToHex(hsvToRgb(hsv));

/** 見た目の明るさ (WCAG の相対輝度、0〜1)。 */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** 2 つの色のコントラスト比 (WCAG、1〜21)。 */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/** base の上に、color を割合 amount (0〜1) で重ねた色。 */
export function mix(base: string, color: string, amount: number): string {
  const from = hexToRgb(base);
  const to = hexToRgb(color);
  return rgbToHex({
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  });
}

/**
 * 背景の上で見分けられるように、色の明るさを調整する。
 * 色そのものを薄めた背景 (tint の割合で重ねたもの) の上に置いても ratio 以上の
 * コントラストになるまで、背景が明るければ暗く、暗ければ明るくしていく。
 * もともと足りている色は変えない。
 */
export function readableOn(
  hex: string,
  background: string,
  { ratio = 3, tint = 0.15 }: { ratio?: number; tint?: number } = {},
): string {
  const target = luminance(background) > 0.5 ? "#000000" : "#ffffff";
  for (let step = 0; step <= 20; step += 1) {
    const candidate = mix(hex, target, step / 20);
    if (contrast(candidate, mix(background, candidate, tint)) >= ratio) {
      return candidate;
    }
  }
  return target;
}

/** この色の上に置く文字の色 (白か黒の、読みやすい方)。 */
export function textOn(hex: string): string {
  return contrast(hex, "#ffffff") >= contrast(hex, "#000000")
    ? "#ffffff"
    : "#171717";
}
