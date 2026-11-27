// @vitest-environment happy-dom
import type { InviteApplyRequest } from "@orbit/core/event-invite";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteCard } from "@/components/mail/invite-card";
import { ApiError, type MessageInvite } from "@/lib/api";
import type { Calendar, EventRange } from "@/lib/calendar/api";
import type { CalendarClient } from "@/lib/calendar/offline";
import { calendar } from "@/lib/calendar/offline/test-support";

/** 招待カードの 8b の操作 (取り込み・更新・取り消し・返事の反映。imip-design 12.5)。 */

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const LOCAL = "00000000-0000-4000-8000-0000000000c1";
const WORK = "00000000-0000-4000-8000-0000000000c2";
const NEW_EVENT = "00000000-0000-4000-8000-000000000e09";

function invite(overrides: Partial<MessageInvite> = {}): MessageInvite {
  return {
    method: "request",
    uid: "invite@example.com",
    sequence: 0,
    recurrenceId: null,
    summary: "企画会議",
    location: "会議室 A",
    time: {
      allDay: false,
      startAt: "2026-12-10T01:00:00Z",
      endAt: "2026-12-10T02:00:00Z",
      startTimeZone: "Asia/Tokyo",
      endTimeZone: "Asia/Tokyo",
    },
    rrule: null,
    organizer: { email: "sato@example.com", name: "佐藤 花子" },
    attendeeCount: 3,
    reply: null,
    eventId: null,
    eventSequence: null,
    dtstamp: "2026-11-27T00:00:00Z",
    sender: { email: "sato@example.com", matches: true, auth: "verified" },
    action: "import",
    actionState: "ready",
    blocked: null,
    calendars: [
      { id: LOCAL, default: true },
      { id: WORK, default: false },
    ],
    ...overrides,
  };
}

function fakeClient(calendars: Calendar[]) {
  const data: EventRange = { events: [], occurrences: [] };
  const none: never[] = [];
  const respond = vi.fn();
  const client = {
    subscribe: () => () => {},
    calendars: () => calendars,
    range: () => data,
    pendingFor: () => none,
    queue: () => none,
    conflicts: () => none,
    respond,
    storageFailed: () => false,
  } as unknown as CalendarClient;
  return { client, respond };
}

const calendars = [
  calendar({ id: LOCAL, name: "マイカレンダー", scheduling: "mail" }),
  calendar({ id: WORK, name: "仕事", scheduling: "mail" }),
];

describe("メールの招待カード (8b の操作)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (
    value: MessageInvite,
    apply: (body: InviteApplyRequest) => Promise<unknown>,
    client: CalendarClient = fakeClient(calendars).client,
    onReload?: () => void,
  ) =>
    act(() =>
      root.render(
        <InviteCard
          invite={value}
          accountId={ACCOUNT}
          messageId="m1"
          apply={apply as never}
          onReload={onReload}
          client={client}
          accounts={null}
          timeZone="Asia/Tokyo"
        />,
      ),
    );
  const text = () => document.body.textContent ?? "";
  const button = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label,
    );
  const click = async (label: string) => {
    await act(async () => {
      button(label)?.click();
    });
  };

  it("取り込み: 既定のカレンダーへ追加し、追加したら「カレンダーで開く」を出す", async () => {
    const apply = vi.fn(async () => ({ applied: true, eventId: NEW_EVENT }));
    render(invite(), apply);
    expect(text()).toContain("マイカレンダー");
    expect(text()).toContain("出席しますか?");
    expect(text()).not.toContain("カレンダーで開く");
    await click("カレンダーに追加");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({
      expect: "import",
      calendarId: LOCAL,
    });
    expect(text()).toContain("カレンダーに追加しました");
    expect(text()).toContain("カレンダーで開く");
  });

  it("取り込みと同時に返事: 追加してから client.respond を呼ぶ", async () => {
    const { client, respond } = fakeClient(calendars);
    const apply = vi.fn(async () => ({ applied: true, eventId: NEW_EVENT }));
    render(invite(), apply, client);
    await click("参加");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(NEW_EVENT, "accepted");
  });

  it("送信元を確認できない招待は、注意を出し、確認してから confirmed: true で追加する", async () => {
    const apply = vi.fn(async () => ({ applied: true, eventId: NEW_EVENT }));
    render(
      invite({
        actionState: "confirm",
        sender: { email: "fake@evil.example", matches: false, auth: "failed" },
      }),
      apply,
    );
    expect(text()).toContain(
      "このメールは送信元を確認できませんでした。差出人をよく確かめてから追加してください。",
    );
    expect(text()).toContain(
      "差出人 (fake@evil.example) と主催者 (sato@example.com) が違います",
    );
    await click("カレンダーに追加");
    expect(apply).not.toHaveBeenCalled();
    expect(text()).toContain("送信元を確認できていない招待を追加しますか?");
    await click("追加する");
    expect(apply).toHaveBeenCalledWith({
      expect: "import",
      calendarId: LOCAL,
      confirmed: true,
    });
  });

  it("検証済みの返事も自動では反映しない。古い API が auto を返してもボタンで反映する", async () => {
    const apply = vi.fn(async () => ({ applied: true, eventId: NEW_EVENT }));
    const reply = invite({
      method: "reply",
      action: "apply_reply",
      actionState: "auto",
      calendars: [],
      reply: { email: "tanaka@example.com", name: "田中", status: "accepted" },
    });
    await act(async () => {
      render(reply, apply);
    });
    expect(apply).not.toHaveBeenCalled();
    expect(text()).toContain("田中 さんからの出欠の返事 (参加)");
    await click("出欠に反映");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ expect: "apply_reply" });
    expect(text()).toContain("田中 さんの返事 (参加) を予定に反映しました");
  });

  it("送信元を確認できていない更新・取り消しは、確認してから confirmed: true で反映する", async () => {
    const apply = vi.fn(async () => ({ applied: true, eventId: "e1" }));
    render(
      invite({
        action: "update",
        actionState: "confirm",
        confirmReason: "sender_unverified",
        eventId: "e1",
        sender: { email: "sato@example.com", matches: true, auth: "unknown" },
      }),
      apply,
    );
    expect(text()).toContain(
      "送信元を確認できていません。主催者からの連絡か確かめてから反映してください。",
    );
    await click("更新を反映");
    expect(apply).not.toHaveBeenCalled();
    expect(text()).toContain("送信元を確認できていないメールを反映しますか?");
    await click("反映する");
    expect(apply).toHaveBeenCalledWith({ expect: "update", confirmed: true });
  });

  it("SEQUENCE が大きく飛んだ更新は、その理由で確認する", async () => {
    const apply = vi.fn(async () => ({ applied: true, eventId: "e1" }));
    render(
      invite({
        action: "update",
        actionState: "confirm",
        confirmReason: "sequence_jump",
        eventId: "e1",
      }),
      apply,
    );
    expect(text()).toContain("招待の版 (SEQUENCE) が大きく飛んでいます");
    await click("更新を反映");
    expect(text()).toContain("版が大きく飛んだ招待を反映しますか?");
  });

  it("未検証の返事はボタンで反映する", async () => {
    const apply = vi.fn(async () => ({ applied: true, eventId: NEW_EVENT }));
    render(
      invite({
        method: "reply",
        action: "apply_reply",
        actionState: "ready",
        sender: { email: "tanaka@example.com", matches: true, auth: "unknown" },
        calendars: [],
        reply: {
          email: "tanaka@example.com",
          name: "田中",
          status: "tentative",
        },
      }),
      apply,
    );
    expect(apply).not.toHaveBeenCalled();
    expect(text()).toContain("田中 さんからの出欠の返事 (未定)");
    expect(text()).toContain("送信元を確認できていません");
    await click("出欠に反映");
    expect(apply).toHaveBeenCalledWith({ expect: "apply_reply" });
  });

  it("送信元を確認中のあいだは押せず、送信元の理由より「確認中」を先に出す", () => {
    const apply = vi.fn();
    render(
      invite({
        sender: { email: "sato@example.com", matches: true, auth: "pending" },
      }),
      apply,
    );
    expect(text()).toContain("送信元を確認中です");
    expect(button("カレンダーに追加")?.disabled).toBe(true);
    render(
      invite({
        action: "update",
        actionState: "blocked",
        blocked: "sender_unverified",
        sender: { email: "sato@example.com", matches: true, auth: "pending" },
      }),
      apply,
    );
    expect(text()).toContain("送信元を確認中です");
    expect(text()).not.toContain("送信元の確認に失敗したメール");
  });

  it("更新・取り消し・済み・止められた状態の文言", async () => {
    const apply = vi.fn(async () => ({ applied: true, eventId: "e1" }));
    render(invite({ action: "update", actionState: "ready" }), apply);
    expect(text()).toContain("この招待は更新されています");
    await click("更新を反映");
    expect(apply).toHaveBeenCalledWith({ expect: "update" });
    expect(text()).toContain("更新を反映しました");

    render(
      invite({ action: "update", actionState: "done", eventId: "e1" }),
      apply,
    );
    expect(text()).toContain("カレンダーに追加済みです");

    render(
      invite({ method: "cancel", action: "remove", actionState: "done" }),
      apply,
    );
    expect(text()).toContain("この予定は取り消されました");
    expect(text()).not.toContain("削除済み");

    render(
      invite({
        action: "update",
        actionState: "blocked",
        blocked: "server_calendar",
      }),
      apply,
    );
    expect(text()).toContain("出欠はカレンダーのサービスが反映します");

    render(
      invite({
        method: "reply",
        action: "apply_reply",
        actionState: "blocked",
        blocked: "sender_mismatch",
      }),
      apply,
    );
    expect(text()).toContain("差出人と返事をした人が違うため、反映できません");
  });

  it("取り消しは「カレンダーから削除」で消し、カレンダーで開くを出さない", async () => {
    const apply = vi.fn(async () => ({ applied: true, eventId: "e1" }));
    render(
      invite({
        method: "cancel",
        action: "remove",
        actionState: "ready",
        eventId: "e1",
      }),
      apply,
    );
    await click("カレンダーから削除");
    expect(apply).toHaveBeenCalledWith({ expect: "remove" });
    expect(text()).toContain("カレンダーから削除しました");
    expect(text()).not.toContain("カレンダーで開く");
  });

  it("状況が変わっていたら (409 changed) 読み直す", async () => {
    const apply = vi.fn(async () => {
      throw new ApiError(409, "changed", null);
    });
    const onReload = vi.fn();
    render(invite(), apply, undefined, onReload);
    await click("カレンダーに追加");
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(text()).toContain("カードを出した後に予定の状況が変わりました");
  });

  it("8b の項目の無い古いサーバーでは、操作を出さない", () => {
    const apply = vi.fn();
    const {
      action: _a,
      actionState: _s,
      blocked: _b,
      calendars: _c,
      sender: _e,
      dtstamp: _d,
      ...old
    } = invite();
    render(old, apply);
    expect(button("カレンダーに追加")).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
  });
});
