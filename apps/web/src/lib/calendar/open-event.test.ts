import { describe, expect, it } from "vitest";
import { event } from "@/lib/calendar/offline/test-support";
import {
  findOpeningItem,
  nextOpeningStep,
  type OpeningEvent,
} from "@/lib/calendar/open-event";
import { parseCalendarEventRoute } from "@/lib/calendar/route";

const ID = "00000000-0000-4000-8000-000000000e01";
const MASTER = "00000000-0000-4000-8000-000000000e02";
const TZ = "Asia/Tokyo";

/** /calendar/events/<id>?o=<回> から開き始める。 */
function openFromUrl(path: string, search = ""): OpeningEvent {
  const target = parseCalendarEventRoute(path, search);
  if (!target) throw new Error("not an event route");
  return target;
}

function item(eventId: string, masterId: string, recurrenceId: string | null) {
  return {
    event: { id: eventId },
    local: { occurrence: { masterId, recurrenceId } },
  };
}

describe("/calendar/events/<id> から予定を開く流れ", () => {
  it("控えに無ければ pull し、それでも無ければ閉じる", () => {
    const opening = openFromUrl(`/calendar/events/${ID}`);
    const empty = { events: [] };
    expect(nextOpeningStep(opening, empty, true, TZ)).toEqual({ type: "pull" });
    expect(
      nextOpeningStep({ ...opening, pulled: true }, empty, true, TZ),
    ).toEqual({ type: "close" });
  });

  it("pull したあとに控えに入れば、その日へ移る", () => {
    const opening = { ...openFromUrl(`/calendar/events/${ID}`), pulled: true };
    const step = nextOpeningStep(
      opening,
      { events: [event({ id: ID, startAt: "2026-03-02T15:30:00.000Z" })] },
      true,
      TZ,
    );
    // 東京では 3 月 3 日。
    expect(step.type === "locate" && step.day.toString()).toBe("2026-03-03");
    expect(step.type === "locate" && step.masterId).toBe(ID);
  });

  it("控えの初回の同期が済むまでは、カレンダーの一覧を読み終えてから 1 度だけ pull する", () => {
    const opening = openFromUrl(`/calendar/events/${ID}`);
    expect(nextOpeningStep(opening, null, false, TZ)).toEqual({ type: "wait" });
    expect(nextOpeningStep(opening, null, true, TZ)).toEqual({ type: "pull" });
    expect(
      nextOpeningStep({ ...opening, pulled: true }, null, true, TZ),
    ).toEqual({ type: "wait" });
  });

  it("繰り返しの回: 原本に回の ID が付いていれば、その回の日へ移り、その回を開く", () => {
    const opening = openFromUrl(
      `/calendar/events/${MASTER}`,
      "?o=2026-03-09T01%3A00%3A00Z",
    );
    const master = event({
      id: MASTER,
      rrule: "FREQ=WEEKLY",
      startAt: "2026-03-02T01:00:00.000Z",
      endAt: "2026-03-02T02:00:00.000Z",
    });
    const step = nextOpeningStep(opening, { events: [master] }, true, TZ);
    expect(step.type === "locate" && step.day.toString()).toBe("2026-03-09");
    const located: OpeningEvent = {
      ...opening,
      located: true,
      masterId: MASTER,
    };
    const shown = [
      item(MASTER, MASTER, "2026-03-02T01:00:00.000Z"),
      // 書き方が違っても (.000Z の有無) 同じ回とみなす。
      item(MASTER, MASTER, "2026-03-09T01:00:00.000Z"),
    ];
    expect(findOpeningItem(located, shown)).toBe(shown[1]);
  });

  it("繰り返しの例外 (動かした回) は、その行の日時へ移る", () => {
    const exception = event({
      id: ID,
      parentId: MASTER,
      recurrenceId: "2026-03-09T01:00:00.000Z",
      startAt: "2026-03-10T05:00:00.000Z",
      endAt: "2026-03-10T06:00:00.000Z",
    });
    const step = nextOpeningStep(
      openFromUrl(`/calendar/events/${ID}`, "?o=2026-03-09T01:00:00.000Z"),
      { events: [exception] },
      true,
      TZ,
    );
    expect(step.type === "locate" && step.day.toString()).toBe("2026-03-10");
    expect(step.type === "locate" && step.masterId).toBe(MASTER);
  });

  it("終日の予定は開始日へ移る", () => {
    const step = nextOpeningStep(
      openFromUrl(`/calendar/events/${ID}`),
      {
        events: [
          event({
            id: ID,
            allDay: true,
            startAt: null,
            endAt: null,
            startDate: "2026-03-05",
            endDate: "2026-03-06",
          }),
        ],
      },
      true,
      TZ,
    );
    expect(step.type === "locate" && step.day.toString()).toBe("2026-03-05");
  });

  it("非表示のカレンダーの予定は表示に出ないので、詳細は開かない (日付だけ移る)", () => {
    const located: OpeningEvent = {
      eventId: ID,
      recurrenceId: null,
      located: true,
      masterId: ID,
    };
    // 表示中の一覧には、表示しているカレンダーの予定だけが入る。
    expect(findOpeningItem(located, [item(MASTER, MASTER, null)])).toBe(
      undefined,
    );
    expect(findOpeningItem(located, [item(ID, ID, null)])?.event.id).toBe(ID);
  });

  it("日時の読めない予定は閉じる", () => {
    expect(
      nextOpeningStep(
        openFromUrl(`/calendar/events/${ID}`),
        { events: [event({ id: ID, startAt: null })] },
        true,
        TZ,
      ),
    ).toEqual({ type: "close" });
  });
});
