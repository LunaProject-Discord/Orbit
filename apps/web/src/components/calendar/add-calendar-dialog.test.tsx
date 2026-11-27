// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddCalendarDialog } from "@/components/calendar/add-calendar-dialog";

/** React が値の変化に気づくように、ネイティブの setter で値を入れて input を起こす。 */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AddCalendarDialog (CalDAV)", () => {
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

  it("サーバーの URL は https:// を省いても送れる (type=url の検証で止めない)", () => {
    const onCreate = vi.fn();
    act(() =>
      root.render(
        <AddCalendarDialog
          open
          busy={false}
          error={null}
          onCreate={onCreate}
          onClose={() => {}}
        />,
      ),
    );
    const radio = (label: string) =>
      [
        ...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      ].find((button) => button.textContent === label);
    act(() => radio("iCloud / CalDAV")?.click());
    act(() => radio("その他の CalDAV")?.click());
    const input = (label: string) =>
      document.body.querySelector<HTMLInputElement>(
        `input[aria-label="${label}"]`,
      ) as HTMLInputElement;
    const server = input("サーバーの URL");
    expect(server.type).toBe("text");
    expect(server.getAttribute("inputmode")).toBe("url");
    act(() => typeInto(server, "dav.example.com"));
    const form = server.form as HTMLFormElement;
    for (const field of form.querySelectorAll("input")) {
      if (field !== server && field.value === "") {
        act(() => typeInto(field, field.type === "password" ? "secret" : "me"));
      }
    }
    expect(form.checkValidity()).toBe(true);
    act(() => form.requestSubmit());
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "caldav", url: "dav.example.com" }),
    );
  });
});
