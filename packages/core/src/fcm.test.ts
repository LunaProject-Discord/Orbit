import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  FcmClient,
  type FcmConfig,
  FcmError,
  loadFcmConfig,
  signServiceAccountJwt,
  toFcmMessage,
} from "./fcm.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const config: FcmConfig = {
  projectId: "orbit-test",
  clientEmail: "push@orbit-test.iam.gserviceaccount.com",
  privateKey,
};
const serviceAccount = JSON.stringify({
  type: "service_account",
  project_id: config.projectId,
  client_email: config.clientEmail,
  private_key: privateKey,
});
const message = {
  title: "佐藤 美咲",
  body: "ご確認",
  tag: "mail:m1",
  messageId: "m1",
};

describe("loadFcmConfig", () => {
  it("未設定なら null", () => {
    expect(loadFcmConfig({})).toBeNull();
    expect(loadFcmConfig({ FCM_SERVICE_ACCOUNT: "  " })).toBeNull();
  });

  it("JSON でも base64 でも読める", () => {
    expect(loadFcmConfig({ FCM_SERVICE_ACCOUNT: serviceAccount })).toEqual(
      config,
    );
    expect(
      loadFcmConfig({
        FCM_SERVICE_ACCOUNT: Buffer.from(serviceAccount).toString("base64"),
      }),
    ).toEqual(config);
  });

  it("形が違えば起動時に止める", () => {
    expect(() => loadFcmConfig({ FCM_SERVICE_ACCOUNT: "abc" })).toThrow();
    expect(() =>
      loadFcmConfig({ FCM_SERVICE_ACCOUNT: '{"project_id":"x"}' }),
    ).toThrow();
  });
});

describe("signServiceAccountJwt", () => {
  it("サービスアカウントの鍵で署名し、FCM 用の範囲を求める", () => {
    const jwt = signServiceAccountJwt(config, 1_700_000_000_000);
    const [header, claims, signature] = jwt.split(".");
    expect(
      JSON.parse(Buffer.from(claims ?? "", "base64url").toString()),
    ).toEqual({
      iss: config.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${claims}`)
        .verify(publicKey, Buffer.from(signature ?? "", "base64url")),
    ).toBe(true);
  });
});

describe("toFcmMessage", () => {
  it("通知の中身を data に載せる (notification は付けない)", () => {
    const { message: sent } = toFcmMessage("device-token", message);
    expect(sent.token).toBe("device-token");
    expect(sent).not.toHaveProperty("notification");
    expect(sent.data).toEqual({
      title: "佐藤 美咲",
      body: "ご確認",
      tag: "mail:m1",
      messageId: "m1",
      channel: "new-mail",
    });
    expect(sent.android.priority).toBe("HIGH");
  });

  it("本文の冒頭があれば preview に載せる", () => {
    const { message: sent } = toFcmMessage("t", {
      ...message,
      preview: "お世話になっております。",
    });
    expect(sent.data.preview).toBe("お世話になっております。");
  });

  it("届いたアカウントが分かれば、ID と名前を載せる", () => {
    const { message: sent } = toFcmMessage("t", {
      ...message,
      accountId: "a1",
      accountName: "仕事用",
    });
    expect(sent.data).toMatchObject({ accountId: "a1", accountName: "仕事用" });
  });

  it("まとめた通知では messageId を空にする (data は文字列のみ)", () => {
    const { message: sent } = toFcmMessage("t", {
      ...message,
      messageId: null,
    });
    expect(sent.data.messageId).toBe("");
  });

  it("ボタンは JSON の文字列にして、送り先と合言葉と一緒に載せる", () => {
    const { message: sent } = toFcmMessage("t", {
      ...message,
      actions: {
        buttons: [{ id: "read", title: "既読にする" }],
        url: "https://x/v1/notification-actions",
        token: "1.abc",
        reply: false,
      },
    });
    expect(sent.data).toMatchObject({
      actions: '[{"id":"read","title":"既読にする"}]',
      actionUrl: "https://x/v1/notification-actions",
      actionToken: "1.abc",
    });
    expect(sent.data).not.toHaveProperty("actionReply");
  });

  it("返信欄を出すときは actionReply を付ける", () => {
    const { message: sent } = toFcmMessage("t", {
      ...message,
      actions: {
        buttons: [],
        url: "https://x/v1/notification-actions",
        token: "1.abc",
        reply: true,
      },
    });
    expect(sent.data).toMatchObject({ actions: "[]", actionReply: "1" });
  });
});

describe("FcmClient", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });

  it("アクセストークンを取り、使い回して送る", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("oauth2")
        ? json(200, { access_token: "ya29.token", expires_in: 3600 })
        : json(200, { name: "projects/orbit-test/messages/1" }),
    );
    const client = new FcmClient(config, fetcher as unknown as typeof fetch);
    await client.send("device-1", message);
    await client.send("device-2", message);
    const urls = fetcher.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://fcm.googleapis.com/v1/projects/orbit-test/messages:send",
      "https://fcm.googleapis.com/v1/projects/orbit-test/messages:send",
    ]);
    const init = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer ya29.token",
    );
    expect(JSON.parse(String(init.body)).message.token).toBe("device-1");
  });

  it("期限が近いアクセストークンは取り直す", async () => {
    let now = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("oauth2")
        ? json(200, { access_token: "t", expires_in: 3600 })
        : json(200, {}),
    );
    const client = new FcmClient(
      config,
      fetcher as unknown as typeof fetch,
      () => now,
    );
    await client.send("d", message);
    now = 3600_000 - 30_000;
    await client.send("d", message);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("oauth2")),
    ).toHaveLength(2);
  });

  it("使えなくなった送り先を見分ける", async () => {
    const fetcher = (async (url: string | URL | Request) =>
      String(url).includes("oauth2")
        ? json(200, { access_token: "t", expires_in: 3600 })
        : json(404, {
            error: {
              code: 404,
              message: "Requested entity was not found.",
              status: "NOT_FOUND",
              details: [{ errorCode: "UNREGISTERED" }],
            },
          })) as unknown as typeof fetch;
    const error = await new FcmClient(config, fetcher)
      .send("gone", message)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(FcmError);
    expect((error as FcmError).code).toBe("UNREGISTERED");
    expect((error as FcmError).tokenGone).toBe(true);
  });

  it("一時的な失敗では送り先を残す", async () => {
    const fetcher = (async (url: string | URL | Request) =>
      String(url).includes("oauth2")
        ? json(200, { access_token: "t", expires_in: 3600 })
        : json(503, {
            error: { status: "UNAVAILABLE", message: "busy" },
          })) as unknown as typeof fetch;
    const error = (await new FcmClient(config, fetcher)
      .send("d", message)
      .catch((cause: unknown) => cause)) as FcmError;
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.tokenGone).toBe(false);
  });

  it("アクセストークンを取れなければ FcmError", async () => {
    const fetcher = (async () =>
      json(400, {
        error: "invalid_grant",
        error_description: "Invalid JWT Signature.",
      })) as unknown as typeof fetch;
    await expect(
      new FcmClient(config, fetcher).send("d", message),
    ).rejects.toThrow(/Invalid JWT Signature/);
  });
});
