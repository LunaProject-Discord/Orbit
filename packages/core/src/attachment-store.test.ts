import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachmentExists,
  attachmentKey,
  attachmentPath,
  copyToOutgoingAttachment,
  readAttachmentMeta,
  storeReceivedAttachment,
  sweepAttachments,
} from "./attachment-store.js";

async function* chunks(...parts: string[]) {
  for (const part of parts) yield Buffer.from(part);
}

describe("受信メールの添付ファイルの置き場", () => {
  let dir: string;
  const userId = randomUUID();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "attachments-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("実体を置き、送信用に複製できる", async () => {
    const id = randomUUID();
    const size = await storeReceivedAttachment(
      dir,
      userId,
      id,
      chunks("hello ", "world"),
    );
    expect(size).toBe(11);
    const key = attachmentKey(userId, id);
    expect(await attachmentExists(dir, key)).toBe(true);
    expect(await readFile(attachmentPath(dir, key), "utf8")).toBe(
      "hello world",
    );
    // 受信した添付ファイルそのものは、送信用の添付ファイルとしては使えない。
    expect(await readAttachmentMeta(dir, userId, id)).toBeNull();

    const copy = await copyToOutgoingAttachment(
      dir,
      userId,
      id,
      { filename: "議題/12月.pdf", contentType: "Application/PDF; x=1" },
      100,
    );
    expect(copy).toMatchObject({
      filename: "議題_12月.pdf",
      contentType: "application/pdf",
      size: 11,
    });
    if (!copy || copy === "too_large") throw new Error("複製できていない");
    expect(copy.id).not.toBe(id);
    expect(await readAttachmentMeta(dir, userId, copy.id)).toEqual(copy);
  });

  it("上限を超えたら置かず、書きかけも残さない", async () => {
    const id = randomUUID();
    expect(
      await storeReceivedAttachment(dir, userId, id, chunks("12345", "6"), 5),
    ).toBe("too_large");
    expect(await attachmentExists(dir, attachmentKey(userId, id))).toBe(false);
    expect(await readdir(join(dir, userId))).toEqual([]);
  });

  it("読み取りの途中で失敗したら、書きかけを残さない", async () => {
    const id = randomUUID();
    async function* broken() {
      yield Buffer.from("abc");
      throw new Error("切断");
    }
    await expect(
      storeReceivedAttachment(dir, userId, id, broken()),
    ).rejects.toThrow("切断");
    expect(await readdir(join(dir, userId))).toEqual([]);
  });

  it("複製元が無い、または大きすぎる場合は複製しない", async () => {
    const meta = { filename: "a.txt", contentType: "text/plain" };
    expect(
      await copyToOutgoingAttachment(dir, userId, randomUUID(), meta, 100),
    ).toBeNull();
    const id = randomUUID();
    await storeReceivedAttachment(dir, userId, id, chunks("123456"));
    expect(await copyToOutgoingAttachment(dir, userId, id, meta, 5)).toBe(
      "too_large",
    );
  });

  it("古くなった写しは消える", async () => {
    const id = randomUUID();
    await storeReceivedAttachment(dir, userId, id, chunks("x"));
    const path = attachmentPath(dir, attachmentKey(userId, id));
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await utimes(path, old, old);
    expect(await sweepAttachments(dir, 7 * 24 * 60 * 60_000)).toBe(1);
    expect(await attachmentExists(dir, attachmentKey(userId, id))).toBe(false);
  });
});
