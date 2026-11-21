import { describe, expect, it } from "vitest";
import { GraphClient } from "./graph-client.js";
import { listGraphFolders } from "./graph-sync.js";

const BASE = "https://graph.microsoft.com/v1.0";

function fakeGraph(pages: Record<string, unknown>) {
  const requested: string[] = [];
  const client = new GraphClient({
    getToken: async () => "token",
    fetchFn: (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const body = pages[url];
      return body
        ? Response.json(body)
        : Response.json(
            { error: { code: "ErrorItemNotFound" } },
            { status: 404 },
          );
    }) as typeof fetch,
  });
  return { client, requested };
}

describe("listGraphFolders", () => {
  it("サブフォルダを持つフォルダをたどり、ページの続きも取得する", async () => {
    const query =
      "$select=id,displayName,parentFolderId,childFolderCount&$top=100";
    const { client, requested } = fakeGraph({
      [`${BASE}/me/mailFolders?${query}`]: {
        value: [
          {
            id: "inbox",
            displayName: "受信トレイ",
            parentFolderId: "root",
            childFolderCount: 1,
          },
          {
            id: "sent",
            displayName: "送信済み",
            parentFolderId: "root",
            childFolderCount: 0,
          },
        ],
        "@odata.nextLink": `${BASE}/me/mailFolders?page=2`,
      },
      [`${BASE}/me/mailFolders?page=2`]: {
        value: [
          {
            id: "a/b",
            displayName: "案件",
            parentFolderId: "root",
            childFolderCount: 0,
          },
        ],
      },
      [`${BASE}/me/mailFolders/inbox/childFolders?${query}`]: {
        value: [
          {
            id: "sub",
            displayName: "サブ",
            parentFolderId: "inbox",
            childFolderCount: 2,
          },
        ],
      },
      [`${BASE}/me/mailFolders/sub/childFolders?${query}`]: {
        value: [
          { id: "deep1", displayName: "深い 1", parentFolderId: "sub" },
          {
            id: "deep2",
            displayName: "深い 2",
            parentFolderId: "sub",
            childFolderCount: null,
          },
        ],
      },
    });
    const folders = await listGraphFolders(client);
    expect(folders.map((folder) => [folder.id, folder.parentFolderId])).toEqual(
      [
        ["inbox", "root"],
        ["sent", "root"],
        ["a/b", "root"],
        ["sub", "inbox"],
        ["deep1", "sub"],
        ["deep2", "sub"],
      ],
    );
    // サブフォルダの無いフォルダには問い合わせない。
    expect(requested).toHaveLength(4);
  });
});
