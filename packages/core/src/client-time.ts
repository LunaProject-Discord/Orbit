/**
 * 端末の時計のずれの補正。端末は書き込みに clientNow (送る瞬間の端末の時刻) を付け、
 * サーバーは「届いた時刻 − clientNow」をずれとして、端末が付けた時刻 (changedAt など) に足す。
 * こうすると、端末の時計が進んでいても遅れていても、「操作してから送るまでに端末で経った時間」だけが効く。
 * DB には触らない純粋な関数だけを置く。
 */

/**
 * これ以下のずれは直さない (ミリ秒)。通信の遅れを足して、時計の合っている端末どうしの順番を
 * 崩さないため。
 */
export const CLIENT_CLOCK_TOLERANCE_MS = 10_000;

/** ISO 8601 を読む。読めなければ null。 */
function parse(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * 端末の時刻に足すずれ (ミリ秒)。clientNow が無い・読めない、またはずれが
 * CLIENT_CLOCK_TOLERANCE_MS 以内なら 0。
 */
export function clientClockOffset(
  clientNow: string | null | undefined,
  receivedAt: Date,
): number {
  const client = parse(clientNow);
  if (client === null) return 0;
  const offset = receivedAt.getTime() - client;
  return Math.abs(offset) > CLIENT_CLOCK_TOLERANCE_MS ? offset : 0;
}

/**
 * 端末が付けた時刻 1 つを、サーバーの時計の時刻にする。ずれを足し、未来の時刻は届いた時刻に丸める。
 * value が無い・読めなければ届いた時刻。
 */
export function correctClientTime(
  value: string | null | undefined,
  clientNow: string | null | undefined,
  receivedAt: Date,
): Date {
  const time = parse(value);
  if (time === null) return receivedAt;
  const corrected = time + clientClockOffset(clientNow, receivedAt);
  return new Date(Math.min(corrected, receivedAt.getTime()));
}

/**
 * 項目ごとの時刻 (項目名 → ISO 8601) をまとめて直す。読めない値の項目は落とす
 * (受け取った側で「時刻が無い = 届いた時刻」として扱われる)。
 */
export function correctClientTimes(
  values: Readonly<Record<string, string>>,
  clientNow: string | null | undefined,
  receivedAt: Date,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (parse(value) === null) continue;
    result[key] = correctClientTime(value, clientNow, receivedAt).toISOString();
  }
  return result;
}
