// ---------------------------------------------------------------------------
// 証明書や失効リストの DER (ASN.1) を読むための、最小限の道具。
// ---------------------------------------------------------------------------

/** DER の 1 つの要素。tag はタグの 1 バイト、offset は頭 (タグ) の位置、start〜end は中身。 */
export type DerElement = {
  tag: number;
  offset: number;
  start: number;
  end: number;
};

/** offset にある DER の要素を読む。読めなければ null。 */
export function readElement(data: Buffer, offset: number): DerElement | null {
  if (offset + 2 > data.length) return null;
  const tag = data[offset] as number;
  let length = data[offset + 1] as number;
  let start = offset + 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    if (bytes === 0 || bytes > 4 || start + bytes > data.length) return null;
    length = 0;
    for (let i = 0; i < bytes; i++) {
      length = length * 256 + (data[start + i] as number);
    }
    start += bytes;
  }
  const end = start + length;
  return end <= data.length ? { tag, offset, start, end } : null;
}

/** 構造型の要素の中身を、子の要素の並びとして読む。読めなければ null。 */
export function children(
  data: Buffer,
  parent: DerElement,
): DerElement[] | null {
  const items: DerElement[] = [];
  let offset = parent.start;
  while (offset < parent.end) {
    const element = readElement(data, offset);
    if (!element || element.end > parent.end) return null;
    items.push(element);
    offset = element.end;
  }
  return items;
}

/** 要素の全体 (タグと長さを含む) のバイト列。 */
export function wholeElement(data: Buffer, element: DerElement): Buffer {
  return data.subarray(element.offset, element.end);
}

/**
 * DER の中から、指定したタグの (構造型でない) 文字列を、入れ子もたどってすべて集める。
 * 0x16 は IA5String、0x86 は GeneralName の URI ([6])。
 */
export function collectStrings(
  data: Buffer,
  start: number,
  end: number,
  tag: number,
  found: string[],
  depth = 0,
) {
  if (depth > 16) return;
  let offset = start;
  while (offset < end) {
    const element = readElement(data, offset);
    if (!element || element.end > end) return;
    if (element.tag === tag) {
      found.push(data.subarray(element.start, element.end).toString("latin1"));
    } else if (element.tag & 0x20) {
      collectStrings(data, element.start, element.end, tag, found, depth + 1);
    }
    offset = element.end;
  }
}

/** OBJECT IDENTIFIER の中身を「1.2.840...」の形にする。 */
export function decodeOid(bytes: Buffer): string {
  if (bytes.length === 0) return "";
  const first = bytes[0] as number;
  const parts = [
    Math.min(2, Math.floor(first / 40)),
    first - Math.min(2, Math.floor(first / 40)) * 40,
  ];
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

/** UTCTime (0x17) か GeneralizedTime (0x18) を読む。読めなければ null。 */
export function decodeTime(data: Buffer, element: DerElement): number | null {
  const text = data.subarray(element.start, element.end).toString("latin1");
  let match: RegExpExecArray | null = null;
  let year: number;
  if (element.tag === 0x17) {
    match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
    if (!match) return null;
    const yy = Number(match[1]);
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
  } else if (element.tag === 0x18) {
    match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
    if (!match) return null;
    year = Number(match[1]);
  } else {
    return null;
  }
  const time = Date.UTC(
    year,
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  return Number.isNaN(time) ? null : time;
}

/** INTEGER の中身を、先頭の 0 を除いた大文字の 16 進にする (証明書の通し番号の比較用)。 */
export function integerHex(bytes: Buffer): string {
  return bytes
    .toString("hex")
    .toUpperCase()
    .replace(/^(00)+(?=.)/, "");
}
