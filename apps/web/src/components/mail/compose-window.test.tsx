// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeWindow } from "@/components/mail/compose-window";
import type { Account, UploadedAttachment } from "@/lib/api";
import { type ComposeDraft, newDraft } from "@/lib/compose";

type Pending = {
  file: File;
  resolve: (uploaded: UploadedAttachment) => void;
};

const mocks = vi.hoisted(() => ({ pending: [] as Pending[] }));

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  uploadAttachment: (file: File) => ({
    promise: new Promise<UploadedAttachment>((resolve) => {
      mocks.pending.push({ file, resolve });
    }),
    abort: () => {},
  }),
  deleteAttachment: () => Promise.resolve(),
}));

const account = {
  id: "account-1",
  protocol: "imap",
  email: "me@example.test",
  displayName: "自分",
} as unknown as Account;

/** 画面 (mail-app) と同じように、作成画面から届いた下書きを状態として持ち直す。 */
function Harness({ onDraft }: { onDraft: (draft: ComposeDraft) => void }) {
  const [draft, setDraft] = useState<ComposeDraft>(() => newDraft(account.id));
  onDraft(draft);
  return (
    <ComposeWindow
      draft={draft}
      open
      accounts={[account]}
      notice={null}
      savedAt={null}
      saveProblem={null}
      contentVersion={0}
      onOpenChange={() => {}}
      onChange={setDraft}
      onBeforeSend={async () => {}}
      onSendFailed={() => {}}
      onSent={() => {}}
      onDiscard={() => {}}
    />
  );
}

function uploaded(file: File, index: number): UploadedAttachment {
  return {
    id: `attachment-${index}`,
    filename: file.name,
    contentType: file.type,
    size: file.size,
  };
}

describe("ComposeWindow の添付ファイル", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ComposeDraft;

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.pending.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <Harness
          onDraft={(draft) => {
            latest = draft;
          }}
        />,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function choose(names: string[]) {
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("ファイルの入力欄が無い");
    const files = names.map(
      (name) => new File([name], name, { type: "text/plain" }),
    );
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("同時に送り終えた複数のファイルがすべて残る", async () => {
    await choose(["a.txt", "b.txt", "c.txt", "d.txt"]);
    expect(mocks.pending).toHaveLength(4);

    // 4 件の送信が、画面の描き直しを挟まずに続けて終わる。
    await act(async () => {
      mocks.pending.forEach((item, index) => {
        item.resolve(uploaded(item.file, index));
      });
    });

    expect(latest.attachments.map((file) => file.filename)).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
      "d.txt",
    ]);
    expect(container.textContent).toContain("a.txt");
    expect(container.textContent).toContain("d.txt");
  });

  it("送信が終わるのと同時に件名を変えても、どちらも残る", async () => {
    await choose(["a.txt"]);
    const subject = container.querySelector<HTMLInputElement>(
      'input[id$="-subject"]',
    );
    if (!subject) throw new Error("件名の入力欄が無い");

    await act(async () => {
      const first = mocks.pending[0];
      first?.resolve(uploaded(first.file, 0));
      // 送信の完了が反映される前の画面で、件名を入力する。
      await Promise.resolve();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(subject, "打ち合わせの件");
      subject.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(latest.subject).toBe("打ち合わせの件");
    expect(latest.attachments.map((file) => file.filename)).toEqual(["a.txt"]);
  });
});
