import { describe, expect, it } from "vitest";
import type { Calendar } from "@/lib/calendar/api";
import {
  calendarSyncStatus,
  conflictActionLabel,
  conflictMessage,
  conflictReason,
  conflictSummary,
  conflictWhen,
  displayFields,
  errorReasonLabel,
  fieldListLabel,
  fieldValueLabel,
  pendingState,
} from "@/lib/calendar/conflict-labels";
import type { ConflictItem, QueuedOp } from "@/lib/calendar/offline";

const TZ = "Asia/Tokyo";

function item(overrides: Partial<ConflictItem>): ConflictItem {
  return {
    id: "c1",
    source: "server",
    kind: "field_lost",
    calendarId: "cal",
    eventId: "e1",
    recurrenceId: null,
    title: "定例会議",
    fields: ["location"],
    lost: { location: "会議室 A" },
    kept: { location: "会議室 B" },
    snapshot: null,
    reason: null,
    createdAt: "2026-11-27T00:00:00.000Z",
    actions: ["restore", "dismiss"],
    opId: null,
    ...overrides,
  };
}

const google = { source: "google" } as Calendar;

function op(overrides: Partial<QueuedOp>): QueuedOp {
  return {
    id: "o1",
    seq: 1,
    kind: "update",
    calendarId: "cal",
    eventId: "e1",
    recurrenceId: null,
    body: {},
    changedAt: {},
    at: "2026-11-27T00:00:00.000Z",
    before: null,
    state: "pending",
    error: null,
    ...overrides,
  };
}

describe("項目名", () => {
  it("表示の順に並べ、通知の 2 項目は 1 つにまとめる", () => {
    expect(
      displayFields([
        "location",
        "reminders",
        "summary",
        "useDefaultReminders",
      ]),
    ).toEqual(["summary", "location", "reminders"]);
    expect(fieldListLabel(["location"])).toBe("場所");
    expect(fieldListLabel(["location", "summary", "time"])).toBe(
      "タイトル、日時と場所",
    );
    expect(fieldListLabel([])).toBe("変更");
  });
});

describe("値", () => {
  it("時刻付きの予定は、その地域の日付と時刻で出す", () => {
    expect(
      fieldValueLabel(
        "time",
        {
          time: {
            allDay: false,
            startAt: "2026-12-01T01:00:00.000Z",
            endAt: "2026-12-01T02:30:00.000Z",
            startTimeZone: TZ,
          },
        },
        TZ,
      ),
    ).toMatch(/12月1日.*10:00.*11:30/);
  });

  it("終日の予定と、複数日の終日の予定", () => {
    expect(
      fieldValueLabel(
        "time",
        {
          time: {
            allDay: true,
            startDate: "2026-12-01",
            endDate: "2026-12-02",
          },
        },
        TZ,
      ),
    ).toMatch(/12月1日.*終日/);
    expect(
      fieldValueLabel(
        "time",
        {
          time: {
            allDay: true,
            startDate: "2026-12-01",
            endDate: "2026-12-04",
          },
        },
        TZ,
      ),
    ).toMatch(/12月1日.*12月3日/);
  });

  it("空の値・知らない値・通知・参加者", () => {
    expect(fieldValueLabel("location", { location: "" }, TZ)).toBe("(なし)");
    expect(fieldValueLabel("summary", { summary: null }, TZ)).toBe(
      "(タイトルなし)",
    );
    expect(fieldValueLabel("location", {}, TZ)).toBeNull();
    expect(fieldValueLabel("location", null, TZ)).toBeNull();
    expect(
      fieldValueLabel("reminders", { useDefaultReminders: true }, TZ),
    ).toBe("既定の通知");
    expect(
      fieldValueLabel(
        "reminders",
        {
          useDefaultReminders: false,
          reminders: [{ method: "display", minutes: 10 }],
        },
        TZ,
      ),
    ).toBe("10 分前に通知");
    expect(
      fieldValueLabel(
        "attendees",
        {
          attendees: [
            { email: "a@example.com", name: "佐藤" },
            { email: "b@example.com" },
            { email: "c@example.com" },
            { email: "d@example.com" },
          ],
        },
        TZ,
      ),
    ).toBe("佐藤、b@example.com、c@example.com ほか 1 人");
    expect(
      fieldValueLabel(
        "recurrence",
        { recurrence: { rrule: null, rdates: [], exdates: [] } },
        TZ,
      ),
    ).toBe("繰り返さない");
    expect(fieldValueLabel("busy", { busy: false }, TZ)).toBe("空き");
  });

  it("長いメモは切り詰める", () => {
    const label = fieldValueLabel(
      "description",
      { description: "あ".repeat(80) },
      TZ,
    );
    expect(label?.length).toBe(41);
    expect(label?.endsWith("…")).toBe(true);
  });
});

describe("説明の文とボタン", () => {
  it("相手側に負けた変更は、相手側の名前で説明する", () => {
    expect(conflictMessage(item({}), google)).toBe(
      "「定例会議」の場所は、Google カレンダーで後から変更された内容になりました。",
    );
  });

  it("端末どうしの競合と、削除の取りやめ", () => {
    expect(
      conflictMessage(
        item({
          source: "local",
          kind: "rejected",
          fields: ["summary", "time"],
        }),
        undefined,
      ),
    ).toBe(
      "「定例会議」のタイトルと日時は、ほかの端末で後から変更されていたので、変更しませんでした。",
    );
    expect(
      conflictMessage(
        item({ source: "local", kind: "delete_cancelled", fields: [] }),
        undefined,
      ),
    ).toContain("ほかの端末で後から変更されていたので、削除しませんでした");
  });

  it("題名が無ければ snapshot の題名、それも無ければ (タイトルなし)", () => {
    expect(
      conflictMessage(
        item({ kind: "remote_deleted", title: null, snapshot: null }),
        google,
      ),
    ).toBe("「(タイトルなし)」は、Google カレンダーで削除されていました。");
  });

  it("ボタンの文言は kind で変わる", () => {
    expect(conflictActionLabel(item({}), "restore")).toBe("自分の変更に戻す");
    expect(
      conflictActionLabel(item({ kind: "remote_deleted" }), "restore"),
    ).toBe("復元");
    expect(
      conflictActionLabel(item({ kind: "occurrence_gone" }), "restore"),
    ).toBe("単発の予定として作る");
    expect(conflictActionLabel(item({ kind: "create_failed" }), "delete")).toBe(
      "予定を消す",
    );
    expect(
      conflictActionLabel(item({ kind: "delete_cancelled" }), "delete"),
    ).toBe("やはり削除する");
    expect(conflictActionLabel(item({}), "dismiss")).toBe("閉じる");
    expect(conflictActionLabel(item({ opId: "o1" }), "dismiss")).toBe("破棄");
  });

  it("理由: サーバーの記録は文をそのまま、端末の失敗はコードを文にする", () => {
    expect(conflictReason(item({ reason: "権限がありません" }))).toBe(
      "権限がありません",
    );
    expect(
      conflictReason(
        item({ source: "local", kind: "failed", reason: "read_only" }),
      ),
    ).toBe("このカレンダーは読み取り専用です");
    expect(
      conflictReason(item({ source: "local", kind: "rejected", reason: "x" })),
    ).toBeNull();
  });

  it("まとめの文", () => {
    expect(conflictSummary(3)).toBe("3 件の変更が反映されませんでした");
  });
});

describe("送信待ちの印", () => {
  it("無ければ null、断られたものがあれば先に出す", () => {
    expect(pendingState([])).toBeNull();
    expect(pendingState([op({})])).toEqual({
      tone: "pending",
      label: "未送信",
      detail: null,
    });
    expect(
      pendingState([op({}), op({ state: "error", error: "read_only" })]),
    ).toMatchObject({ tone: "error", label: "送信できませんでした" });
    expect(
      pendingState([op({ state: "blocked", error: "calendar_sync_stopped" })]),
    ).toMatchObject({
      tone: "blocked",
      detail: "カレンダーの同期が止まっています",
    });
  });
});

describe("日時と同期の表示", () => {
  it("いまの予定が無ければ、自分の値の日時を出す", () => {
    expect(
      conflictWhen(
        item({
          kept: null,
          lost: {
            time: {
              allDay: true,
              startDate: "2026-12-01",
              endDate: "2026-12-02",
            },
          },
        }),
        undefined,
        TZ,
      ),
    ).toMatch(/12月1日/);
    expect(
      conflictWhen(item({ kept: null, lost: null }), undefined, TZ),
    ).toBeNull();
  });

  it("オフライン・同期中・同期済み", () => {
    expect(
      calendarSyncStatus({ online: false, pending: 2, loaded: true }),
    ).toMatchObject({
      tone: "offline",
      label: "オフライン · 接続後に 2 件の変更を反映",
    });
    expect(
      calendarSyncStatus({ online: true, pending: 1, loaded: true }).tone,
    ).toBe("busy");
    expect(
      calendarSyncStatus({ online: true, pending: 0, loaded: true }).label,
    ).toBe("同期済み");
  });
});

describe("出欠と招待の断りの理由", () => {
  it.each([
    ["not_attendee", "この予定に招待されていません"],
    ["organizer", "自分が主催する予定には返事できません"],
    ["cancelled", "この予定は取り消されています"],
    ["no_scheduling", "このカレンダーからは招待を送れません"],
  ])("%s", (code, label) => {
    expect(errorReasonLabel(code)).toBe(label);
  });
});
