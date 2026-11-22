import type { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { readFromLocations } from "./attachment-fetch.js";

/** フォルダごとの UIDVALIDITY だけを持つ、IMAP 接続の代わり。無いフォルダは開けない。 */
function fakeClient(folders: Record<string, bigint>) {
  const opened: string[] = [];
  let released = 0;
  const client = {
    mailbox: false as false | { path: string; uidValidity: bigint },
    async getMailboxLock(path: string, options?: { readOnly?: boolean }) {
      const uidValidity = folders[path];
      if (uidValidity === undefined) {
        throw Object.assign(new Error("no such mailbox"), {
          responseStatus: "NO",
        });
      }
      expect(options?.readOnly).toBe(true);
      opened.push(path);
      client.mailbox = { path, uidValidity };
      return {
        release: () => {
          released += 1;
        },
      };
    },
  };
  return {
    client: client as unknown as ImapFlow,
    opened,
    released: () => released,
  };
}

describe("readFromLocations", () => {
  it("最初に読めたフォルダの結果を返し、残りは開かない", async () => {
    const { client, opened, released } = fakeClient({ INBOX: 1n, Archive: 1n });
    const result = await readFromLocations(
      client,
      [
        { path: "INBOX", uid: 7, uidValidity: 1n },
        { path: "Archive", uid: 3, uidValidity: 1n },
      ],
      async (uid) => `uid ${uid}`,
    );
    expect(result).toBe("uid 7");
    expect(opened).toEqual(["INBOX"]);
    expect(released()).toBe(1);
  });

  it("消されたフォルダ、UID が振り直されたフォルダ、メールが無いフォルダは飛ばす", async () => {
    const { client, opened, released } = fakeClient({
      Renumbered: 2n,
      Empty: 1n,
      Archive: 1n,
    });
    const read: number[] = [];
    const result = await readFromLocations(
      client,
      [
        { path: "Deleted", uid: 1, uidValidity: 1n },
        { path: "Renumbered", uid: 2, uidValidity: 1n },
        { path: "Empty", uid: 3, uidValidity: 1n },
        { path: "Archive", uid: 4, uidValidity: 1n },
      ],
      async (uid) => {
        read.push(uid);
        return uid === 4 ? "本文" : null;
      },
    );
    expect(result).toBe("本文");
    expect(opened).toEqual(["Renumbered", "Empty", "Archive"]);
    expect(read).toEqual([3, 4]);
    expect(released()).toBe(3);
  });

  it("取り込みの途中で UIDVALIDITY をまだ保存していないフォルダからも読む", async () => {
    const { client } = fakeClient({ INBOX: 9n });
    const result = await readFromLocations(
      client,
      [{ path: "INBOX", uid: 5, uidValidity: null }],
      async (uid) => uid,
    );
    expect(result).toBe(5);
  });

  it("どこからも読めなければ null を返す", async () => {
    const { client } = fakeClient({ INBOX: 1n });
    const result = await readFromLocations(
      client,
      [{ path: "INBOX", uid: 5, uidValidity: 1n }],
      async () => null,
    );
    expect(result).toBeNull();
  });

  it("接続の問題はそのまま投げる", async () => {
    const client = {
      mailbox: false,
      async getMailboxLock() {
        throw new Error("connection closed");
      },
    } as unknown as ImapFlow;
    await expect(
      readFromLocations(
        client,
        [{ path: "INBOX", uid: 5, uidValidity: 1n }],
        async () => "x",
      ),
    ).rejects.toThrow("connection closed");
  });
});
