import { describe, expect, it } from "vitest";
import {
  createConsoleMailer,
  createGraphMailer,
  loadGraphMailConfig,
  loadSystemMail,
  loadSystemMailConfig,
  renderSystemMail,
} from "./system-mail.js";

describe("loadSystemMailConfig", () => {
  it("SYSTEM_MAIL_HOST が無ければ null", () => {
    expect(loadSystemMailConfig({})).toBe(null);
    expect(loadSystemMailConfig({ SYSTEM_MAIL_HOST: " " })).toBe(null);
  });

  it("既定は 587 番の STARTTLS", () => {
    expect(
      loadSystemMailConfig({
        SYSTEM_MAIL_HOST: "smtp.example.com",
        SYSTEM_MAIL_FROM: "Orbit <no-reply@example.com>",
        SYSTEM_MAIL_USER: "user",
        SYSTEM_MAIL_PASSWORD: "secret",
      }),
    ).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "user",
      password: "secret",
      from: "Orbit <no-reply@example.com>",
    });
  });

  it("465 番は最初から TLS。SYSTEM_MAIL_SECURE で上書きできる", () => {
    const base = {
      SYSTEM_MAIL_HOST: "smtp.example.com",
      SYSTEM_MAIL_FROM: "no-reply@example.com",
    };
    expect(
      loadSystemMailConfig({ ...base, SYSTEM_MAIL_PORT: "465" })?.secure,
    ).toBe(true);
    expect(
      loadSystemMailConfig({
        ...base,
        SYSTEM_MAIL_PORT: "2465",
        SYSTEM_MAIL_SECURE: "true",
      })?.secure,
    ).toBe(true);
  });

  it("書きかけの設定は起動時に止める", () => {
    expect(() =>
      loadSystemMailConfig({ SYSTEM_MAIL_HOST: "smtp.example.com" }),
    ).toThrow(/SYSTEM_MAIL_FROM/);
    expect(() =>
      loadSystemMailConfig({
        SYSTEM_MAIL_HOST: "smtp.example.com",
        SYSTEM_MAIL_FROM: "a@example.com",
        SYSTEM_MAIL_USER: "user",
      }),
    ).toThrow(/SYSTEM_MAIL_PASSWORD/);
    expect(() =>
      loadSystemMailConfig({
        SYSTEM_MAIL_HOST: "smtp.example.com",
        SYSTEM_MAIL_FROM: "a@example.com",
        SYSTEM_MAIL_PORT: "abc",
      }),
    ).toThrow(/SYSTEM_MAIL_PORT/);
  });
});

describe("renderSystemMail", () => {
  const mail = {
    to: "a@example.com",
    subject: "件名",
    lines: ["<b>あおい</b> さん", "本文です。"],
    action: { label: "開く", url: "https://example.com/?a=1&b=2" },
    footer: ["有効期限は 1 時間です。"],
  };

  it("テキストにはリンクをそのまま書く", () => {
    const { text } = renderSystemMail(mail);
    expect(text).toContain("https://example.com/?a=1&b=2");
    expect(text).toContain("有効期限は 1 時間です。");
  });

  it("HTML では、名前などに含まれる記号を無害にする", () => {
    const { html } = renderSystemMail(mail);
    expect(html).toContain("&lt;b&gt;あおい&lt;/b&gt; さん");
    expect(html).not.toContain("<b>あおい</b>");
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
  });
});

describe("createConsoleMailer", () => {
  it("送らずに、宛先と本文をログへ出す", async () => {
    const logs: string[] = [];
    await createConsoleMailer((message) => logs.push(message)).send({
      to: "a@example.com",
      subject: "件名",
      lines: ["本文"],
      action: { label: "開く", url: "https://example.com/x" },
    });
    expect(logs.join("\n")).toContain("宛先: a@example.com");
    expect(logs.join("\n")).toContain("https://example.com/x");
  });
});

describe("loadGraphMailConfig", () => {
  const base = {
    SYSTEM_MAIL_GRAPH_SENDER: "no-reply@example.com",
    SYSTEM_MAIL_GRAPH_TENANT: "example.onmicrosoft.com",
    SYSTEM_MAIL_GRAPH_CLIENT_ID: "client",
    SYSTEM_MAIL_GRAPH_CLIENT_SECRET: "secret",
  };

  it("SYSTEM_MAIL_GRAPH_SENDER が無ければ null", () => {
    expect(loadGraphMailConfig({})).toBe(null);
  });

  it("設定を読む", () => {
    expect(loadGraphMailConfig(base)).toEqual({
      tenant: "example.onmicrosoft.com",
      clientId: "client",
      clientSecret: "secret",
      sender: "no-reply@example.com",
    });
  });

  it("クライアント ID とシークレットは、メールアカウント用のアプリ登録を既定で使う", () => {
    expect(
      loadGraphMailConfig({
        SYSTEM_MAIL_GRAPH_SENDER: "no-reply@example.com",
        SYSTEM_MAIL_GRAPH_TENANT: "tenant-id",
        MICROSOFT_CLIENT_ID: "shared",
        MICROSOFT_CLIENT_SECRET: "shared-secret",
      }),
    ).toMatchObject({ clientId: "shared", clientSecret: "shared-secret" });
  });

  it("テナントが common などのときは止める", () => {
    expect(() =>
      loadGraphMailConfig({ ...base, SYSTEM_MAIL_GRAPH_TENANT: "" }),
    ).toThrow(/SYSTEM_MAIL_GRAPH_TENANT/);
    expect(() =>
      loadGraphMailConfig({
        ...base,
        SYSTEM_MAIL_GRAPH_TENANT: "",
        MICROSOFT_TENANT: "common",
      }),
    ).toThrow(/SYSTEM_MAIL_GRAPH_TENANT/);
  });

  it("足りない値や、アドレスでない差出人は止める", () => {
    expect(() =>
      loadGraphMailConfig({ ...base, SYSTEM_MAIL_GRAPH_CLIENT_SECRET: "" }),
    ).toThrow(/CLIENT_SECRET/);
    expect(() =>
      loadGraphMailConfig({ ...base, SYSTEM_MAIL_GRAPH_SENDER: "Orbit" }),
    ).toThrow(/SYSTEM_MAIL_GRAPH_SENDER/);
  });
});

describe("loadSystemMail", () => {
  const graph = {
    SYSTEM_MAIL_GRAPH_SENDER: "no-reply@example.com",
    SYSTEM_MAIL_GRAPH_TENANT: "tenant-id",
    SYSTEM_MAIL_GRAPH_CLIENT_ID: "client",
    SYSTEM_MAIL_GRAPH_CLIENT_SECRET: "secret",
  };
  const smtp = {
    SYSTEM_MAIL_HOST: "smtp.example.com",
    SYSTEM_MAIL_FROM: "no-reply@example.com",
  };

  it("設定した方を使い、どちらも無ければ null", () => {
    expect(loadSystemMail({})).toBe(null);
    expect(loadSystemMail(graph)?.kind).toBe("graph");
    expect(loadSystemMail(smtp)?.kind).toBe("smtp");
  });

  it("両方を設定したら止める", () => {
    expect(() => loadSystemMail({ ...graph, ...smtp })).toThrow(/どちらか一方/);
  });
});

describe("createGraphMailer", () => {
  const config = {
    tenant: "tenant-id",
    clientId: "client",
    clientSecret: "secret",
    sender: "no-reply@example.com",
  };
  const mail = {
    to: "user@example.com",
    subject: "件名",
    lines: ["本文"],
    action: { label: "開く", url: "https://example.com/x" },
  };
  type Call = { url: string; init: RequestInit };

  function fakeFetch(respond: (call: Call, calls: Call[]) => Response) {
    const calls: Call[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      return respond(call, calls);
    }) as typeof fetch;
    return { calls, fetchFn };
  }
  const tokenResponse = (token: string) =>
    Response.json({ access_token: token, expires_in: 3600 });

  it("トークンを取り、差出人のメールボックスから送る", async () => {
    const { calls, fetchFn } = fakeFetch((call) =>
      call.url.includes("/oauth2/")
        ? tokenResponse("token-1")
        : new Response(null, { status: 202 }),
    );
    await createGraphMailer(config, fetchFn).send(mail);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token",
    );
    const form = calls[0]?.init.body as URLSearchParams;
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(calls[1]?.url).toBe(
      "https://graph.microsoft.com/v1.0/users/no-reply%40example.com/sendMail",
    );
    expect(
      (calls[1]?.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer token-1");
    const body = JSON.parse(String(calls[1]?.init.body));
    expect(body.saveToSentItems).toBe(false);
    expect(body.message.subject).toBe("件名");
    expect(body.message.toRecipients).toEqual([
      { emailAddress: { address: "user@example.com" } },
    ]);
    expect(body.message.body.contentType).toBe("HTML");
    expect(body.message.body.content).toContain("https://example.com/x");
  });

  it("トークンは期限まで使い回す", async () => {
    const { calls, fetchFn } = fakeFetch((call) =>
      call.url.includes("/oauth2/")
        ? tokenResponse("token-1")
        : new Response(null, { status: 202 }),
    );
    const mailer = createGraphMailer(config, fetchFn);
    await mailer.send(mail);
    await mailer.send(mail);
    expect(calls.filter((call) => call.url.includes("/oauth2/"))).toHaveLength(
      1,
    );
  });

  it("401 が返ったら、トークンを取り直して 1 度だけやり直す", async () => {
    let sends = 0;
    const { calls, fetchFn } = fakeFetch((call, all) => {
      if (call.url.includes("/oauth2/")) {
        return tokenResponse(`token-${all.length}`);
      }
      sends += 1;
      return new Response(null, { status: sends === 1 ? 401 : 202 });
    });
    await createGraphMailer(config, fetchFn).send(mail);
    expect(calls.filter((call) => call.url.includes("/oauth2/"))).toHaveLength(
      2,
    );
    expect(sends).toBe(2);
  });

  it("送れなかったときは、Graph の理由を付けて失敗する", async () => {
    const { fetchFn } = fakeFetch((call) =>
      call.url.includes("/oauth2/")
        ? tokenResponse("token-1")
        : Response.json(
            {
              error: {
                code: "ErrorAccessDenied",
                message: "Access is denied.",
              },
            },
            { status: 403 },
          ),
    );
    await expect(createGraphMailer(config, fetchFn).send(mail)).rejects.toThrow(
      /403.*ErrorAccessDenied/,
    );
  });

  it("トークンを取れなかったときは、理由を付けて失敗する", async () => {
    const { fetchFn } = fakeFetch(() =>
      Response.json(
        { error: "invalid_client", error_description: "bad secret" },
        { status: 401 },
      ),
    );
    await expect(createGraphMailer(config, fetchFn).send(mail)).rejects.toThrow(
      /invalid_client/,
    );
  });
});
