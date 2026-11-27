// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageAttachments } from "@/components/mail/message-attachments";
import type { Attachment } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  native: true,
  opened: [] as [string, string][],
  saved: [] as [string, string][],
  openResult: true as boolean | null,
  notices: [] as string[],
}));

vi.mock("@/lib/native/app", async (original) => ({
  ...(await original<typeof import("@/lib/native/app")>()),
  isNativeApp: () => mocks.native,
}));

vi.mock("@/lib/native/files", () => ({
  openFileNative: async (_blob: Blob, name: string, type: string) => {
    mocks.opened.push([name, type]);
    return mocks.openResult;
  },
  saveFileNative: async (_blob: Blob, name: string, type: string) => {
    mocks.saved.push([name, type]);
    return true;
  },
}));

vi.mock("@/components/mail/toasts", () => ({
  showNotice: (message: string) => mocks.notices.push(message),
}));

vi.mock("@/lib/offline", () => ({
  fetchAttachment: async () => new Blob(["data"]),
}));

const file = (values: Partial<Attachment>): Attachment => ({
  id: "00000000-0000-7000-8000-000000000001",
  filename: null,
  contentType: "application/octet-stream",
  size: 1000,
  contentId: null,
  inline: false,
  ...values,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.native = true;
  mocks.opened = [];
  mocks.saved = [];
  mocks.openResult = true;
  mocks.notices = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(label: RegExp, scope: ParentNode = document) {
  return Array.from(scope.querySelectorAll("button")).find((element) =>
    label.test(element.textContent ?? ""),
  );
}

describe("MessageAttachments (スマホアプリ)", () => {
  it("プレビューできないファイルは、押すと別のアプリで開く (種類は拡張子から選ぶ)", async () => {
    const zip = file({ filename: "資料.zip", contentType: "text/html" });
    await act(async () => {
      root.render(<MessageAttachments messageId="m1" files={[zip]} />);
    });
    await act(async () => button(/資料\.zip/, container)?.click());
    await flush();
    expect(mocks.opened).toEqual([["資料.zip", "application/zip"]]);
    expect(mocks.saved).toEqual([]);
  });

  it("開けるアプリが無ければ知らせる", async () => {
    mocks.openResult = false;
    const zip = file({ filename: "資料.zip" });
    await act(async () => {
      root.render(<MessageAttachments messageId="m1" files={[zip]} />);
    });
    await act(async () => button(/資料\.zip/, container)?.click());
    await flush();
    expect(mocks.notices[0]).toContain("開けるアプリが見つかりませんでした");
  });

  it("古いアプリで別のアプリで開けなければ、保存する", async () => {
    mocks.openResult = null;
    const zip = file({ filename: "資料.zip" });
    await act(async () => {
      root.render(<MessageAttachments messageId="m1" files={[zip]} />);
    });
    await act(async () => button(/資料\.zip/, container)?.click());
    await flush();
    expect(mocks.saved).toEqual([["資料.zip", "application/zip"]]);
  });

  it("プレビューに「保存」と「別のアプリで開く」を出す", async () => {
    const text = file({ filename: "メモ.txt", contentType: "text/plain" });
    await act(async () => {
      root.render(<MessageAttachments messageId="m1" files={[text]} />);
    });
    await act(async () => button(/メモ\.txt/, container)?.click());
    await flush();
    await act(async () => button(/別のアプリで開く/)?.click());
    await flush();
    expect(mocks.opened).toEqual([["メモ.txt", "text/plain"]]);
    await act(async () => button(/^保存$/)?.click());
    await flush();
    expect(mocks.saved).toEqual([["メモ.txt", "text/plain"]]);
  });

  it("ブラウザーでは「別のアプリで開く」を出さない", async () => {
    mocks.native = false;
    const text = file({ filename: "メモ.txt", contentType: "text/plain" });
    await act(async () => {
      root.render(<MessageAttachments messageId="m1" files={[text]} />);
    });
    await act(async () => button(/メモ\.txt/, container)?.click());
    await flush();
    expect(button(/^保存$/)).toBeDefined();
    expect(button(/別のアプリで開く/)).toBeUndefined();
  });
});
