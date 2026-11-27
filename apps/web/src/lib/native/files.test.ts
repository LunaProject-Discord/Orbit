// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FILE_CHUNK_BYTES,
  openFileNative,
  saveFileNative,
} from "@/lib/native/files";

const mocks = vi.hoisted(() => ({
  native: true,
  calls: [] as [string, unknown][],
  shell: {} as Record<string, (options?: unknown) => Promise<unknown>>,
}));

vi.mock("@/lib/native/app", () => ({
  isNativeApp: () => mocks.native,
  loadAppShell: async () => ({ AppShell: mocks.shell }),
}));

function unimplemented() {
  return Object.assign(new Error("not implemented"), { code: "UNIMPLEMENTED" });
}

beforeEach(() => {
  mocks.native = true;
  mocks.calls = [];
  const record =
    (name: string, result: unknown) => async (options?: unknown) => {
      mocks.calls.push([name, options]);
      return result;
    };
  mocks.shell = {
    beginFile: record("beginFile", { id: "file-1" }),
    appendFile: record("appendFile", undefined),
    saveFile: record("saveFile", { saved: true }),
    openFile: record("openFile", { opened: false }),
  };
});

/** appendFile で送られた base64 をつなげて、元の中身に戻す。 */
function sentBytes(): Uint8Array {
  const parts = mocks.calls
    .filter(([name]) => name === "appendFile")
    .map(([, options]) =>
      Uint8Array.from(atob((options as { data: string }).data), (char) =>
        char.charCodeAt(0),
      ),
    );
  const total = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    total.set(part, offset);
    offset += part.length;
  }
  return total;
}

describe("saveFileNative / openFileNative", () => {
  it("アプリの中でなければ何もせず null を返す", async () => {
    mocks.native = false;
    expect(
      await saveFileNative(new Blob(["a"]), "a.txt", "text/plain"),
    ).toBeNull();
    expect(mocks.calls).toEqual([]);
  });

  it("古いアプリでメソッドが無ければ null を返す", async () => {
    mocks.shell.beginFile = async () => {
      throw unimplemented();
    };
    expect(
      await openFileNative(new Blob(["a"]), "a.txt", "text/plain"),
    ).toBeNull();
  });

  it("中身を小分けにして順に送り、保存を頼む", async () => {
    const bytes = new Uint8Array(FILE_CHUNK_BYTES * 2 + 100).map(
      (_, index) => index % 251,
    );
    const saved = await saveFileNative(
      new Blob([bytes]),
      "見積書.pdf",
      "application/pdf",
    );
    expect(saved).toBe(true);
    const names = mocks.calls.map(([name]) => name);
    expect(names).toEqual([
      "beginFile",
      "appendFile",
      "appendFile",
      "appendFile",
      "saveFile",
    ]);
    for (const [name, options] of mocks.calls) {
      if (name !== "appendFile") continue;
      const { id, data } = options as { id: string; data: string };
      expect(id).toBe("file-1");
      // 元データで 512KB 以下ずつ。
      expect((data.length / 4) * 3).toBeLessThanOrEqual(512 * 1024);
    }
    expect(sentBytes()).toEqual(bytes);
    expect(mocks.calls.at(-1)).toEqual([
      "saveFile",
      { id: "file-1", name: "見積書.pdf", mimeType: "application/pdf" },
    ]);
  });

  it("開けるアプリが無ければ false、失敗は例外のまま返す", async () => {
    expect(
      await openFileNative(
        new Blob(["abc"]),
        "a.bin",
        "application/octet-stream",
      ),
    ).toBe(false);
    mocks.shell.appendFile = async () => {
      throw new Error("disk full");
    };
    await expect(
      saveFileNative(new Blob(["abc"]), "a.bin", "application/octet-stream"),
    ).rejects.toThrow("disk full");
  });
});
