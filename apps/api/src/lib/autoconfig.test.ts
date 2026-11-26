import { describe, expect, it } from "vitest";
import {
  baseDomainOf,
  createFetchText,
  type DiscoveryDeps,
  discoverMailSettings,
  domainOfEmail,
  parseAutodiscover,
  parseThunderbirdConfig,
} from "./autoconfig.js";

const THUNDERBIRD = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="example.jp">
    <domain>example.jp</domain>
    <incomingServer type="pop3">
      <hostname>pop.example.jp</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.%EMAILDOMAIN%</hostname>
      <port>143</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILLOCALPART%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.example.jp</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <username>%EMAILLOCALPART%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.jp</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>OAuth2</authentication>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

const AUTODISCOVER = `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>imap.shin.example</Server>
        <Port>993</Port>
        <LoginName>me@work.example</LoginName>
        <SSL>on</SSL>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>smtp.shin.example</Server>
        <Port>587</Port>
        <LoginName>me@work.example</LoginName>
        <Encryption>TLS</Encryption>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>`;

function deps(overrides: {
  pages?: Record<string, string>;
  posts?: Record<string, string>;
  mx?: Record<string, string[]>;
  srv?: Record<string, { name: string; port: number }[]>;
}): DiscoveryDeps & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    fetchText: async (url, init) => {
      requested.push(`${init ? "POST" : "GET"} ${url}`);
      const table = init ? overrides.posts : overrides.pages;
      const key = Object.keys(table ?? {}).find((prefix) =>
        url.startsWith(prefix),
      );
      return key ? (table?.[key] ?? null) : null;
    },
    resolveMx: async (domain) => overrides.mx?.[domain] ?? [],
    resolveSrv: async (name) =>
      (overrides.srv?.[name] ?? []).map((record) => ({
        ...record,
        priority: 0,
        weight: 0,
      })),
  };
}

describe("domainOfEmail / baseDomainOf", () => {
  it("ホスト名として使えるドメインだけを返す", () => {
    expect(domainOfEmail("Me@Example.JP")).toBe("example.jp");
    expect(domainOfEmail("me@127.0.0.1")).toBeNull();
    expect(domainOfEmail("me@localhost")).toBeNull();
    expect(domainOfEmail("me@exa mple.com")).toBeNull();
  });

  it("MX のホストからサービスのドメインを取り出す", () => {
    expect(baseDomainOf("aspmx.l.google.com.")).toBe("google.com");
    expect(baseDomainOf("mx01.mail.example.co.jp")).toBe("example.co.jp");
    expect(baseDomainOf("example-com.mail.protection.outlook.com")).toBe(
      "outlook.com",
    );
  });
});

describe("parseThunderbirdConfig", () => {
  it("IMAP と SMTP を選び、%EMAILLOCALPART% などを埋める", () => {
    expect(parseThunderbirdConfig(THUNDERBIRD, "taro@example.jp")).toEqual({
      // POP3 は使わず、IMAP のうち最初から TLS のものを選ぶ。
      imap: {
        host: "imap.example.jp",
        port: 993,
        security: "ssl",
        username: "taro",
        auth: "password",
      },
      smtp: {
        host: "smtp.example.jp",
        port: 587,
        security: "starttls",
        username: "taro@example.jp",
        auth: "password",
      },
      incomingProtocol: "imap",
    });
  });

  it("IMAP が無く POP3 しかなければ、POP3 を受信に使う", () => {
    const popOnly = `<clientConfig version="1.1"><emailProvider id="spmode.ne.jp">
      <incomingServer type="pop3"><hostname>mail.spmode.ne.jp</hostname><port>995</port>
        <socketType>SSL</socketType><username>%EMAILLOCALPART%</username>
        <authentication>password-cleartext</authentication></incomingServer>
      <outgoingServer type="smtp"><hostname>mail.spmode.ne.jp</hostname><port>465</port>
        <socketType>SSL</socketType><username>%EMAILLOCALPART%</username>
        <authentication>password-cleartext</authentication></outgoingServer>
    </emailProvider></clientConfig>`;
    expect(parseThunderbirdConfig(popOnly, "taro@docomo.ne.jp")).toEqual({
      imap: {
        host: "mail.spmode.ne.jp",
        port: 995,
        security: "ssl",
        username: "taro",
        auth: "password",
      },
      smtp: {
        host: "mail.spmode.ne.jp",
        port: 465,
        security: "ssl",
        username: "taro",
        auth: "password",
      },
      incomingProtocol: "pop3",
    });
  });

  it("壊れた XML や、片方しか無い設定は使わない", () => {
    expect(parseThunderbirdConfig("<clientConfig>", "a@b.jp")).toBeNull();
    expect(
      parseThunderbirdConfig(
        THUNDERBIRD.replace(/<outgoingServer[\s\S]*<\/outgoingServer>/, ""),
        "a@b.jp",
      ),
    ).toBeNull();
  });

  it("ホスト名に使えない値は捨てる", () => {
    const xml = THUNDERBIRD.replaceAll("imap.example.jp", "imap example");
    expect(parseThunderbirdConfig(xml, "taro@example.jp")?.imap.host).toBe(
      "imap.example.jp",
    );
  });
});

describe("parseAutodiscover", () => {
  it("Encryption と SSL からセキュリティを決める", () => {
    expect(parseAutodiscover(AUTODISCOVER, "me@work.example")).toEqual({
      kind: "settings",
      imap: {
        host: "imap.shin.example",
        port: 993,
        security: "ssl",
        username: "me@work.example",
        auth: "password",
      },
      smtp: {
        host: "smtp.shin.example",
        port: 587,
        security: "starttls",
        username: "me@work.example",
        auth: "password",
      },
      incomingProtocol: "imap",
    });
  });

  it("転送の案内を読む", () => {
    const redirect = `<Autodiscover><Response><Account><Action>redirectUrl</Action><RedirectUrl>https://ad.example/autodiscover/autodiscover.xml</RedirectUrl></Account></Response></Autodiscover>`;
    expect(parseAutodiscover(redirect, "a@b.jp")).toEqual({
      kind: "redirectUrl",
      url: "https://ad.example/autodiscover/autodiscover.xml",
    });
  });
});

describe("discoverMailSettings", () => {
  it("よく使われるサービスは問い合わせずに返す", async () => {
    const d = deps({});
    const found = await discoverMailSettings("me@gmail.com", d);
    expect(found).toMatchObject({
      source: "preset",
      provider: "gmail",
      imap: { host: "imap.gmail.com", port: 993, security: "ssl" },
    });
    expect(d.requested).toEqual([]);
  });

  it("autoconfig.<ドメイン> を最優先する", async () => {
    const d = deps({
      pages: {
        "https://autoconfig.example.jp/mail/config-v1.1.xml": THUNDERBIRD,
        "https://autoconfig.thunderbird.net/v1.1/example.jp":
          THUNDERBIRD.replaceAll("imap.example.jp", "other.example.jp"),
      },
    });
    const found = await discoverMailSettings("taro@example.jp", d);
    expect(found?.source).toBe("autoconfig");
    expect(found?.imap.host).toBe("imap.example.jp");
    expect(d.requested).toContain(
      "GET https://autoconfig.example.jp/mail/config-v1.1.xml?emailaddress=taro%40example.jp",
    );
  });

  it("autoconfig が無ければ Outlook 形式 (Autodiscover) を使う", async () => {
    const d = deps({
      posts: {
        "https://autodiscover.work.example/autodiscover/autodiscover.xml":
          AUTODISCOVER,
      },
    });
    const found = await discoverMailSettings("me@work.example", d);
    expect(found).toMatchObject({
      source: "autodiscover",
      provider: "generic",
      imap: { host: "imap.shin.example" },
      smtp: { host: "smtp.shin.example", security: "starttls" },
    });
  });

  it("Google Workspace の独自ドメインは MX から Gmail と分かる", async () => {
    const d = deps({ mx: { "corp.example": ["aspmx.l.google.com"] } });
    const found = await discoverMailSettings("me@corp.example", d);
    expect(found).toMatchObject({ source: "mx", provider: "gmail" });
  });

  it("最後に SRV レコード (RFC 6186) を見る", async () => {
    const d = deps({
      srv: {
        "_imaps._tcp.srv.example": [{ name: "mail.srv.example", port: 993 }],
        "_submission._tcp.srv.example": [
          { name: "mail.srv.example.", port: 587 },
        ],
      },
    });
    const found = await discoverMailSettings("me@srv.example", d);
    expect(found).toMatchObject({
      source: "srv",
      imap: { host: "mail.srv.example", port: 993, security: "ssl" },
      smtp: { host: "mail.srv.example", port: 587, security: "starttls" },
    });
  });

  it("どこにも無ければ null", async () => {
    expect(await discoverMailSettings("me@none.example", deps({}))).toBeNull();
  });

  it("期限を過ぎたら、終わったものから選ぶ", async () => {
    const d = deps({
      srv: {
        "_imaps._tcp.slow.example": [{ name: "mail.slow.example", port: 993 }],
        "_submissions._tcp.slow.example": [
          { name: "mail.slow.example", port: 465 },
        ],
      },
    });
    // autoconfig の応答がいつまでも返らない。
    d.fetchText = () => new Promise(() => {});
    const found = await discoverMailSettings("me@slow.example", d, {
      deadlineMs: 50,
    });
    expect(found?.source).toBe("srv");
  });
});

describe("createFetchText", () => {
  it("内部ネットワークを指すホストには問い合わせない", async () => {
    let called = false;
    const fetchText = createFetchText({
      allowPrivate: false,
      fetchImpl: (async () => {
        called = true;
        return new Response("x");
      }) as typeof fetch,
    });
    expect(await fetchText("https://127.0.0.1/x")).toBeNull();
    expect(await fetchText("http://example.com/x")).toBeNull();
    expect(called).toBe(false);
  });

  it("転送先が内部ネットワークなら、そこで止める", async () => {
    const seen: string[] = [];
    const fetchText = createFetchText({
      allowPrivate: false,
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "https://10.0.0.1/config.xml" },
        });
      }) as unknown as typeof fetch,
    });
    // 名前解決をしないで済むよう、公開の IP アドレスで始める。
    expect(await fetchText("https://93.184.215.14/x")).toBeNull();
    expect(seen).toEqual(["https://93.184.215.14/x"]);
  });

  it("大きすぎる応答は読まない", async () => {
    const fetchText = createFetchText({
      allowPrivate: true,
      fetchImpl: (async () =>
        new Response("a".repeat(300 * 1024))) as unknown as typeof fetch,
    });
    expect(await fetchText("https://example.test/x")).toBeNull();
  });
});
