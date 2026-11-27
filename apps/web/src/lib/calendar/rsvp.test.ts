import { describe, expect, it } from "vitest";
import type { Attendee, CalendarEvent } from "@/lib/calendar/api";
import { calendar, event } from "@/lib/calendar/offline/test-support";
import {
  canRespondTo,
  needsAccounts,
  serverHandlesRsvp,
} from "@/lib/calendar/rsvp";

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const self = (email: string): Attendee => ({
  email,
  name: null,
  role: "required",
  status: "needs_action",
  self: true,
});
const invited = (email = "me@example.com"): CalendarEvent =>
  event({
    organizer: { email: "boss@example.com", self: false },
    attendees: [self(email)],
  });

describe("出欠を返してよいか (review-invites の 3 と 6)", () => {
  it("カレンダーに scheduling が無い古いサーバーでは返さない", () => {
    expect(serverHandlesRsvp(calendar())).toBe(false);
    expect(canRespondTo(invited(), calendar({ source: "google" }))).toBe(false);
    expect(canRespondTo(invited(), calendar({ scheduling: "none" }))).toBe(
      true,
    );
    expect(canRespondTo(invited(), undefined)).toBe(false);
  });

  it("参加者でない (主催者・他人の予定) なら返さない", () => {
    const cal = calendar({ scheduling: "server" });
    expect(
      canRespondTo(
        { ...invited(), organizer: { email: "me@example.com", self: true } },
        cal,
      ),
    ).toBe(false);
    expect(canRespondTo({ ...invited(), attendees: [] }, cal)).toBe(false);
  });

  it("primary / accessRole の無いサーバー・カレンダーは今までどおり返せる", () => {
    const cal = calendar({ scheduling: "server", accountId: ACCOUNT });
    expect(canRespondTo(invited("other@example.com"), cal, [])).toBe(true);
    expect(needsAccounts(cal)).toBe(false);
  });

  it("共有カレンダー: primary か owner、または self がアカウントのアドレスのときだけ", () => {
    const shared = calendar({
      source: "google",
      scheduling: "server",
      accountId: ACCOUNT,
      primary: false,
      accessRole: "writer",
    });
    const accounts = [{ id: ACCOUNT, email: "ME@example.com " }];
    expect(needsAccounts(shared)).toBe(true);
    expect(
      canRespondTo(invited("colleague@example.com"), shared, accounts),
    ).toBe(false);
    expect(canRespondTo(invited("me@example.com"), shared, accounts)).toBe(
      true,
    );
    expect(canRespondTo(invited("me@example.com"), shared, null)).toBe(false);
    expect(
      canRespondTo(invited("colleague@example.com"), {
        ...shared,
        primary: true,
      }),
    ).toBe(true);
    expect(
      canRespondTo(invited("colleague@example.com"), {
        ...shared,
        accessRole: "owner",
      }),
    ).toBe(true);
    expect(needsAccounts({ ...shared, accessRole: "owner" })).toBe(false);
  });
});
