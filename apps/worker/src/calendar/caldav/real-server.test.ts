/**
 * 本物の CalDAV サーバー (Radicale など) に接続して確かめる。CALDAV_TEST_URL が無ければ実行しない。
 * 例: CALDAV_TEST_URL=http://127.0.0.1:5232/ CALDAV_TEST_USER=user CALDAV_TEST_PASSWORD=secret
 * 名前のカレンダー (CALDAV_TEST_CALENDAR、既定は「仕事」) を作っておくこと。予定を作って消す。
 */
import { describe, expect, it } from "vitest";
import type { ProviderContext } from "../provider.js";
import {
  calendarRowFrom,
  describeCalendarProviderContract,
  makeEventSnapshot,
  makeProviderContext,
  readAllPages,
} from "../testing/provider-contract.js";
import { createCaldavProvider } from "./index.js";

const url = process.env.CALDAV_TEST_URL;
const name = process.env.CALDAV_TEST_CALENDAR ?? "仕事";

function context(): ProviderContext {
  const base = makeProviderContext();
  const username = process.env.CALDAV_TEST_USER ?? "user";
  return {
    ...base,
    account: {
      ...base.account,
      provider: "generic",
      authType: "password",
      email: `${username}@example.com`,
      username,
      caldavUrl: url ?? null,
    },
    auth: {
      type: "password",
      username,
      password: process.env.CALDAV_TEST_PASSWORD ?? "secret",
    },
    // ローカルのサーバーなので、内部ネットワークの検査をしない。
    allowPrivateHosts: true,
  };
}

/** forceEtags なら、sync-collection に対応していても getctag と ETag の比較で取る。 */
async function prepare(forceEtags = false) {
  const provider = createCaldavProvider();
  const ctx = context();
  const list = await provider.listCalendars(ctx);
  const remote = list.find((entry) => entry.name === name);
  if (!remote) throw new Error(`カレンダー「${name}」がありません`);
  const calendar = calendarRowFrom(remote, {
    source: "caldav",
    providerState: forceEtags
      ? { syncCollection: false }
      : (remote.providerState ?? null),
  });
  return { provider, ctx, calendar };
}

describe.skipIf(!url)("本物の CalDAV サーバー", () => {
  describeCalendarProviderContract("CalDAV (本物のサーバー)", () => prepare(), {
    writable: true,
    conflicts: true,
  });
  describeCalendarProviderContract(
    "CalDAV (本物のサーバー、getctag と ETag の比較)",
    () => prepare(true),
    { writable: true, conflicts: true },
  );

  it("繰り返しの予定の回の変更と削除、差分の同期", async () => {
    const { provider, ctx, calendar } = await prepare();
    const first = await readAllPages(provider, ctx, calendar, null);
    const token = first.pages.at(-1)?.nextSyncToken ?? null;
    const known = new Map(
      first.events.map((event) => [event.remoteId, event.etag]),
    );

    const master = makeEventSnapshot({
      summary: "本物のサーバーの週次",
      rrule: "FREQ=WEEKLY;COUNT=5",
      startTimeZone: "America/New_York",
      endTimeZone: "America/New_York",
      reminders: [{ method: "display", minutes: 10 }],
      useDefaultReminders: false,
    });
    const created = await provider.createEvent(ctx, calendar, {
      event: master,
      master: null,
      exceptions: [],
      fields: [],
    });
    if (created.status !== "ok")
      throw new Error(`作れませんでした: ${created.status}`);
    const [row] = created.events;
    if (!row) throw new Error("予定が返りませんでした");
    expect(row.startTimeZone).toBe("America/New_York");
    expect(row.reminders).toEqual([{ method: "display", minutes: 10 }]);

    // 2 回目だけ変える (まだ相手側に無い回の例外)。
    const second = "2026-12-17T01:00:00Z";
    const exception = await provider.updateEvent(
      ctx,
      calendar,
      {
        remoteId: row.remoteId,
        etag: null,
        uid: row.uid as string,
        recurrenceId: second,
        parentRemoteId: row.remoteId,
      },
      {
        event: makeEventSnapshot({
          uid: row.uid as string,
          recurrenceId: second,
          summary: "この回だけ",
          startAt: new Date("2026-12-17T03:00:00Z"),
          endAt: new Date("2026-12-17T04:00:00Z"),
        }),
        master: {
          ...master,
          remoteId: row.remoteId,
          etag: row.etag,
          raw: row.raw,
        },
        exceptions: [],
        fields: ["summary", "time"],
      },
    );
    if (exception.status !== "ok")
      throw new Error(`例外を書けませんでした: ${exception.status}`);
    expect(exception.events.map((event) => event.summary)).toEqual([
      "本物のサーバーの週次",
      "この回だけ",
    ]);

    // 差分に、作った予定が原本と例外の 2 行で出てくる。
    const delta = await provider.syncEvents(ctx, calendar, {
      syncToken: token,
      pageCursor: null,
      knownEtags: async () => known,
      knownEvents: async () => new Map(),
    });
    expect(
      delta.events.filter((event) => event.remoteId === row.remoteId),
    ).toHaveLength(2);

    // 2 回目を消す (EXDATE を足して例外を取り除く)。
    const latest = exception.events[0];
    if (!latest) throw new Error("原本がありません");
    const removed = await provider.updateEvent(
      ctx,
      calendar,
      {
        remoteId: row.remoteId,
        etag: latest.etag,
        uid: row.uid as string,
        recurrenceId: null,
        parentRemoteId: null,
      },
      {
        event: {
          ...master,
          remoteId: row.remoteId,
          etag: latest.etag,
          raw: latest.raw,
          exdates: [second],
        },
        master: null,
        exceptions: [],
        fields: ["recurrence"],
      },
    );
    if (removed.status !== "ok")
      throw new Error(`回を消せませんでした: ${removed.status}`);
    expect(removed.events.map((event) => event.recurrenceId)).toEqual([null]);
    expect(removed.events[0]?.exdates).toEqual([second]);

    const cleanup = await provider.deleteEvent(ctx, calendar, {
      remoteId: row.remoteId,
      etag: removed.events[0]?.etag ?? null,
      uid: row.uid as string,
      recurrenceId: null,
      parentRemoteId: null,
    });
    expect(cleanup.status).toBe("ok");
  });
});
