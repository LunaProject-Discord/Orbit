import { normalizeRecurrenceId } from "@orbit/core/recurrence";
import { ApiError, NetworkError } from "@/lib/api";
import type {
  Calendar,
  CalendarConflict,
  CalendarEvent,
  CalendarSyncPage,
  EventFields,
} from "@/lib/calendar/api";
import type { ClientApi } from "@/lib/calendar/offline/client";
import { expandRange } from "@/lib/calendar/offline/expand";
import {
  applyFields,
  eventFromInput,
  provisionalException,
} from "@/lib/calendar/offline/overlay";
import { searchLocal } from "@/lib/calendar/offline/search";
import { type LocalStore, MemoryStore } from "@/lib/offline/store";

/**
 * テスト用の偽のサーバー (カレンダーの API だけ)。テストからだけ読み込む。
 * 項目ごとの統合は簡略にしてあり、rejectFields に入れた項目を rejected で返す。
 */

export const CALENDAR_ID = "00000000-0000-4000-8000-0000000000c1";

export function calendar(overrides: Partial<Calendar> = {}): Calendar {
  return {
    id: CALENDAR_ID,
    accountId: null,
    source: "local",
    name: "予定",
    description: null,
    color: null,
    timeZone: "Asia/Tokyo",
    readOnly: false,
    visible: true,
    sortOrder: null,
    url: null,
    pollIntervalSeconds: null,
    defaultReminders: [],
    lastSyncedAt: null,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const id = overrides.id ?? "00000000-0000-4000-8000-000000000e01";
  return {
    id,
    calendarId: CALENDAR_ID,
    uid: `${id}@orbit`,
    recurrenceId: null,
    parentId: null,
    summary: "定例",
    location: null,
    description: null,
    status: "confirmed",
    busy: true,
    allDay: false,
    startAt: "2026-03-02T01:00:00.000Z",
    endAt: "2026-03-02T02:00:00.000Z",
    startDate: null,
    endDate: null,
    startTimeZone: "Asia/Tokyo",
    endTimeZone: "Asia/Tokyo",
    rrule: null,
    rdates: [],
    exdates: [],
    organizer: null,
    sequence: 0,
    conferenceUrl: null,
    useDefaultReminders: true,
    reminders: [],
    attendees: [],
    fieldUpdatedAt: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type Change = { seq: number; entity: "calendar" | "event"; id: string };

export class FakeCalendarServer {
  online = true;
  readonly events = new Map<string, CalendarEvent>();
  readonly calendars = new Map<string, Calendar>();
  readonly deleted = new Set<string>();
  readonly changes: Change[] = [];
  readonly calls: string[] = [];
  /** PATCH で rejected にする項目。 */
  rejectFields = new Set<string>();
  /** DELETE で 409 changed_since を返す予定。 */
  changedSince = new Set<string>();
  /** 規則に無い (400 invalid を返す) 回。 */
  invalidOccurrences = new Set<string>();
  /** 409 calendar_sync_stopped を返すカレンダー。 */
  stopped = new Set<string>();
  /** /sync の 1 ページの件数。 */
  pageSize = 100;
  /** /sync に競合の項目を付けるか (古いサーバーでは付かない)。 */
  conflicts: CalendarConflict[] | null = null;
  /** 次の /sync を失敗させる回数。 */
  failSync = 0;
  /** 送られてきた本文 (確かめるため)。 */
  readonly bodies: unknown[] = [];
  private clock = Date.parse("2026-01-01T00:00:00Z");

  constructor() {
    this.addCalendar(calendar());
  }

  private tick(): string {
    this.clock += 1_000;
    return new Date(this.clock).toISOString();
  }

  private record(entity: Change["entity"], id: string) {
    this.changes.push({ seq: this.changes.length + 1, entity, id });
  }

  private guard(name: string) {
    this.calls.push(name);
    if (!this.online) throw new NetworkError();
  }

  addCalendar(value: Calendar): void {
    this.calendars.set(value.id, value);
    this.record("calendar", value.id);
  }

  addEvent(value: CalendarEvent): void {
    this.events.set(value.id, value);
    this.record("event", value.id);
  }

  /** ほかの端末での変更 (サーバーの行を直接変える)。 */
  change(id: string, fields: EventFields): void {
    const current = this.events.get(id);
    if (!current) throw new Error("no event");
    this.events.set(id, {
      ...applyFields(current, fields),
      updatedAt: this.tick(),
    });
    this.record("event", id);
  }

  remove(id: string): void {
    for (const [key, value] of this.events) {
      if (key === id || value.parentId === id) {
        this.events.delete(key);
        this.deleted.add(key);
        this.record("event", key);
      }
    }
  }

  private blocked(calendarId: string) {
    if (this.stopped.has(calendarId)) {
      throw new ApiError(409, "calendar_sync_stopped", {
        error: "calendar_sync_stopped",
      });
    }
  }

  private notFound(): never {
    throw new ApiError(404, "not_found", { error: "not_found" });
  }

  api(): ClientApi {
    return {
      createEvent: async (input, times = {}) => {
        this.guard(`create ${input.id}`);
        this.bodies.push({ ...input, ...times });
        this.blocked(input.calendarId);
        const id = input.id ?? crypto.randomUUID();
        const existing = this.events.get(id);
        if (existing) return existing;
        if (this.deleted.has(id)) throw new ApiError(410, "gone", null);
        const created = {
          ...eventFromInput({ ...input, id }, this.tick()),
          updatedAt: this.tick(),
        };
        this.events.set(id, created);
        this.record("event", id);
        return created;
      },
      updateEvent: async (id, changes, changedAt) => {
        this.guard(`update ${id}`);
        this.bodies.push({ changes, changedAt });
        const current = this.events.get(id) ?? this.notFound();
        this.blocked(current.calendarId);
        const rejected = Object.keys(changes).filter((key) =>
          this.rejectFields.has(key),
        ) as (keyof EventFields)[];
        const accepted = Object.fromEntries(
          Object.entries(changes).filter(
            ([key]) => !this.rejectFields.has(key),
          ),
        );
        const next = {
          ...applyFields(current, accepted),
          updatedAt: this.tick(),
        };
        this.events.set(id, next);
        this.record("event", id);
        return { event: next, rejected };
      },
      updateOccurrence: async (masterId, recurrenceId, changes) => {
        this.guard(`occurrence ${masterId} ${recurrenceId}`);
        const master = this.events.get(masterId) ?? this.notFound();
        this.blocked(master.calendarId);
        const rid = normalizeRecurrenceId(recurrenceId);
        if (this.invalidOccurrences.has(rid)) {
          throw new ApiError(400, "invalid", { error: "invalid" });
        }
        let exception = [...this.events.values()].find(
          (value) => value.parentId === masterId && value.recurrenceId === rid,
        );
        if (!exception) {
          exception = {
            ...provisionalException(master, rid),
            id: crypto.randomUUID(),
          };
        }
        const next = {
          ...applyFields(exception, changes),
          updatedAt: this.tick(),
        };
        this.events.set(next.id, next);
        this.record("event", next.id);
        return { event: next, rejected: [] };
      },
      deleteEvent: async (id, times = {}) => {
        this.guard(`delete ${id}`);
        this.bodies.push(times);
        const current = this.events.get(id) ?? this.notFound();
        this.blocked(current.calendarId);
        if (this.changedSince.has(id)) {
          throw new ApiError(409, "changed_since", {
            error: "changed_since",
            event: current,
          });
        }
        if (current.parentId && current.recurrenceId) {
          const master = this.events.get(current.parentId);
          if (master) {
            this.events.set(master.id, {
              ...master,
              exdates: [...master.exdates, current.recurrenceId],
              updatedAt: this.tick(),
            });
            this.record("event", master.id);
          }
        }
        this.remove(id);
      },
      deleteOccurrence: async (masterId, recurrenceId) => {
        this.guard(`occurrence_delete ${masterId} ${recurrenceId}`);
        const master = this.events.get(masterId) ?? this.notFound();
        this.blocked(master.calendarId);
        const rid = normalizeRecurrenceId(recurrenceId);
        this.events.set(masterId, {
          ...master,
          exdates: [...master.exdates, rid],
          updatedAt: this.tick(),
        });
        this.record("event", masterId);
        for (const [key, value] of this.events) {
          if (value.parentId === masterId && value.recurrenceId === rid) {
            this.events.delete(key);
            this.deleted.add(key);
            this.record("event", key);
          }
        }
      },
      respondToEvent: async (id, input) => {
        this.guard(`respond ${id}`);
        const current = this.events.get(id) ?? this.notFound();
        const next = {
          ...current,
          attendees: current.attendees.map((attendee) =>
            attendee.self ? { ...attendee, status: input.status } : attendee,
          ),
          updatedAt: this.tick(),
        };
        this.events.set(id, next);
        this.record("event", id);
        return next;
      },
      updateCalendar: async (id, changes) => {
        this.guard(`calendar ${id}`);
        const current = this.calendars.get(id) ?? this.notFound();
        const next = { ...current, ...changes, updatedAt: this.tick() };
        this.calendars.set(id, next);
        this.record("calendar", id);
        return next;
      },
      listCalendars: async () => {
        this.guard("calendars");
        return [...this.calendars.values()];
      },
      listEvents: async (range) => {
        this.guard("events");
        return expandRange(this.events.values(), range);
      },
      searchEvents: async (q) => {
        this.guard("search");
        return searchLocal(this.events.values(), q);
      },
      syncCalendars: async (since) => {
        this.guard(`sync ${since}`);
        if (this.failSync > 0) {
          this.failSync -= 1;
          throw new NetworkError();
        }
        const after = this.changes.filter((c) => c.seq > Number(since));
        const page = after.slice(0, this.pageSize);
        const calendarIds = [
          ...new Set(
            page.filter((c) => c.entity === "calendar").map((c) => c.id),
          ),
        ];
        const eventIds = [
          ...new Set(page.filter((c) => c.entity === "event").map((c) => c.id)),
        ];
        const result: CalendarSyncPage = {
          calendars: calendarIds.flatMap((id) => {
            const value = this.calendars.get(id);
            return value ? [value] : [];
          }),
          events: eventIds.flatMap((id) => {
            const value = this.events.get(id);
            return value ? [value] : [];
          }),
          deleted: {
            calendars: calendarIds.filter((id) => !this.calendars.has(id)),
            events: eventIds.filter((id) => !this.events.has(id)),
          },
          latestSeq: String(page.at(-1)?.seq ?? since),
          hasMore: after.length > page.length,
        };
        if (this.conflicts) {
          result.openConflicts = this.conflicts.length;
          result.conflictsAt = this.conflicts[0]?.createdAt ?? null;
        }
        return result;
      },
      listConflicts: async () => {
        this.guard("conflicts");
        return this.conflicts ?? [];
      },
      dismissConflict: async (id) => {
        this.guard(`dismiss ${id}`);
        this.conflicts = (this.conflicts ?? []).filter((c) => c.id !== id);
      },
      retryConflict: async (id) => {
        this.guard(`retry ${id}`);
      },
    };
  }
}

/** 再読み込みしても残る保存先のふり (MemoryStore の persistent を true にしたもの)。 */
export function persistentStore(
  store: MemoryStore = new MemoryStore(),
): LocalStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "persistent") return true;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
