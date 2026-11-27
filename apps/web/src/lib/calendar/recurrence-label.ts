/**
 * 繰り返しの規則 (RRULE) の、画面での選び方と言い表し方。
 * 作成画面で選べるのは簡単な規則だけ (毎日・毎週・毎月・毎年、終わりの日)。
 * それ以外の規則 (プロバイダで作ったもの) は「カスタム」として、そのまま残す。
 */

export type RepeatPreset = "none" | "daily" | "weekly" | "monthly" | "yearly";

const FREQ: Record<Exclude<RepeatPreset, "none">, string> = {
  daily: "DAILY",
  weekly: "WEEKLY",
  monthly: "MONTHLY",
  yearly: "YEARLY",
};

const WEEKDAYS: Record<string, string> = {
  SU: "日",
  MO: "月",
  TU: "火",
  WE: "水",
  TH: "木",
  FR: "金",
  SA: "土",
};

export function parseRule(rule: string | null): Map<string, string> | null {
  if (!rule) return null;
  const parts = new Map<string, string>();
  for (const part of rule.replace(/^RRULE:/i, "").split(";")) {
    const [key, value] = part.split("=");
    if (key && value !== undefined) parts.set(key.toUpperCase(), value);
  }
  return parts.has("FREQ") ? parts : null;
}

/** 簡単な規則なら、その選び方。ほかの指定 (BYDAY の複数指定、INTERVAL など) があれば null。 */
export function presetOf(rule: string | null): {
  preset: RepeatPreset;
  until: string | null;
} | null {
  const parts = parseRule(rule);
  if (!parts) return { preset: "none", until: null };
  const freq = parts.get("FREQ");
  const preset = (Object.keys(FREQ) as (keyof typeof FREQ)[]).find(
    (key) => FREQ[key] === freq,
  );
  if (!preset) return null;
  const allowed = new Set(["FREQ", "UNTIL", "WKST"]);
  // 「毎週」は BYDAY が 1 つ (開始の曜日) までなら同じ扱いにする。
  if (preset === "weekly" && /^[A-Z]{2}$/.test(parts.get("BYDAY") ?? "")) {
    allowed.add("BYDAY");
  }
  if ((parts.get("INTERVAL") ?? "1") === "1") allowed.add("INTERVAL");
  for (const key of parts.keys()) if (!allowed.has(key)) return null;
  const untilRaw = parts.get("UNTIL");
  const until = untilRaw
    ? `${untilRaw.slice(0, 4)}-${untilRaw.slice(4, 6)}-${untilRaw.slice(6, 8)}`
    : null;
  return { preset, until };
}

/**
 * 選び方から規則を作る。until (YYYY-MM-DD、その日を含む) は、終日の予定なら日付で、
 * 時刻付きの予定ならその日の終わり (untilEnd、UTC の ISO 8601) で書く。
 */
export function buildRule(
  preset: RepeatPreset,
  until: { date: string; untilEnd: string | null } | null,
): string | null {
  if (preset === "none") return null;
  let rule = `FREQ=${FREQ[preset]}`;
  if (until) {
    if (until.untilEnd) {
      const value = until.untilEnd.replace(/[-:]/g, "").replace(/\.\d+/, "");
      rule += `;UNTIL=${value}`;
    } else {
      rule += `;UNTIL=${until.date.replace(/-/g, "")}`;
    }
  }
  return rule;
}

/** 規則を日本語で言い表す。読めなければ null。 */
export function describeRule(rule: string | null): string | null {
  const parts = parseRule(rule);
  if (!parts) return null;
  const interval = Number(parts.get("INTERVAL") ?? "1");
  const every = (unit: string) =>
    interval > 1 ? `${interval} ${unit}ごと` : `毎${unit}`;
  let text: string;
  switch (parts.get("FREQ")) {
    case "DAILY":
      text = interval > 1 ? `${interval} 日ごと` : "毎日";
      break;
    case "WEEKLY": {
      const days = (parts.get("BYDAY") ?? "")
        .split(",")
        .map((day) => WEEKDAYS[day])
        .filter(Boolean);
      text = `${interval > 1 ? `${interval} 週ごと` : "毎週"}${days.length > 0 ? ` ${days.join("・")}曜日` : ""}`;
      break;
    }
    case "MONTHLY":
      text = interval > 1 ? `${interval} か月ごと` : "毎月";
      break;
    case "YEARLY":
      text = every("年");
      break;
    default:
      return "繰り返し";
  }
  const until = parts.get("UNTIL");
  const count = parts.get("COUNT");
  if (until) {
    text += ` · ${Number(until.slice(4, 6))}月${Number(until.slice(6, 8))}日まで`;
  } else if (count) {
    text += ` · ${count} 回`;
  }
  return text;
}
