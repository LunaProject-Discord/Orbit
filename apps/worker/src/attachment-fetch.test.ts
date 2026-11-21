import { describe, expect, it } from "vitest";
import {
  type AttachmentTarget,
  graphAttachmentDownloader,
} from "./attachment-fetch.js";
import { GraphClient } from "./graph-client.js";
import { listGraphAttachments } from "./graph-sync.js";

function setup(responses: Response[]) {
  const urls: string[] = [];
  const client = new GraphClient({
    getToken: async () => "token",
    fetchFn: (async (url: unknown) => {
      urls.push(String(url));
      const response = responses.shift();
      if (!response) throw new Error("応答が足りません");
      return response;
    }) as typeof fetch,
    sleep: async () => {},
  });
  return { client, urls };
}

const target: AttachmentTarget = {
  id: "00000000-0000-7000-8000-000000000001",
  userId: "00000000-0000-7000-8000-000000000002",
  partId: "ATT/1=",
  providerMessageId: "MSG/1=",
  locations: [],
};

async function read(body: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const part of body) parts.push(part);
  return Buffer.concat(parts).toString("utf8");
}

describe("graphAttachmentDownloader", () => {
  it("添付ファイルの実体を $value から読む", async () => {
    const { client, urls } = setup([new Response("PDF の中身")]);
    let received = "";
    const found = await graphAttachmentDownloader(client)(
      target,
      async (body) => {
        received = await read(body);
      },
    );
    expect(found).toBe(true);
    expect(received).toBe("PDF の中身");
    expect(urls).toEqual([
      "https://graph.microsoft.com/v1.0/me/messages/MSG%2F1%3D/attachments/ATT%2F1%3D/$value",
    ]);
  });

  it("サーバーから無くなっていたら false を返す", async () => {
    const { client } = setup([
      Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 }),
    ]);
    const found = await graphAttachmentDownloader(client)(target, async () => {
      throw new Error("呼ばれないはず");
    });
    expect(found).toBe(false);
  });
});

describe("listGraphAttachments", () => {
  it("項目を絞って一覧を取得し、続きのページも読む", async () => {
    const { client, urls } = setup([
      Response.json({
        value: [{ id: "A", name: "a.txt", contentType: "text/plain" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/next",
      }),
      Response.json({ value: [{ id: "B", name: "b.png", isInline: true }] }),
    ]);
    const files = await listGraphAttachments(client, "MSG/1=");
    expect(files.map((file) => [file.partId, file.inline])).toEqual([
      ["A", false],
      ["B", true],
    ]);
    expect(urls[0]).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/MSG%2F1%3D/attachments?$select=id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId",
    );
  });

  it("絞った要求を断られたら、絞らずに取り直す", async () => {
    const { client, urls } = setup([
      Response.json({ error: { code: "BadRequest" } }, { status: 400 }),
      Response.json({ value: [{ id: "A", contentId: "logo" }] }),
    ]);
    const files = await listGraphAttachments(client, "M");
    expect(files).toHaveLength(1);
    expect(files[0]?.contentId).toBe("logo");
    expect(urls[1]).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/M/attachments",
    );
  });
});
