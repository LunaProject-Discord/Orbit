import { describe, expect, it } from "vitest";
import {
  acceptImage,
  type FetchBytes,
  fetchBimi,
  fetchFavicon,
  findIconLinks,
  gravatarHash,
  type IconDeps,
  isPersonalMailDomain,
  parseBimiRecord,
  sanitizeSvg,
  sniffImage,
} from "./sender-icons.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const LOGO =
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 10 10"><title>Example</title><rect width="10" height="10" fill="#f00"/></svg>';

function deps(
  pages: Record<string, Buffer | string>,
  txt: Record<string, string[][]> = {},
): IconDeps & { requested: string[] } {
  const requested: string[] = [];
  const fetchBytes: FetchBytes = async (url) => {
    requested.push(url);
    const body = pages[url];
    if (body === undefined) return null;
    return {
      contentType: "",
      body: typeof body === "string" ? Buffer.from(body) : body,
      url,
    };
  };
  return {
    requested,
    fetchBytes,
    resolveTxt: async (name) => {
      const records = txt[name];
      if (!records) {
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      }
      return records;
    },
  };
}

describe("sniffImage", () => {
  it("中身から画像の種類を決める", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
    expect(sniffImage(Buffer.from([0, 0, 1, 0, 1]))).toBe("image/x-icon");
    expect(sniffImage(Buffer.from(LOGO))).toBe("image/svg+xml");
    expect(sniffImage(Buffer.from("<html><body>"))).toBeNull();
  });
});

describe("sanitizeSvg", () => {
  it("スクリプト、外部の参照、イベントの属性を取り除く", () => {
    const svg = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><div/></foreignObject><image href="https://tracker.example/a.png"/><use href="https://evil.example/x.svg#a"/><use href="#a"/><rect style="fill:url(https://evil.example/p)" fill="url(#g)" width="1"/><a href="javascript:alert(1)"><path d="M0 0"/></a></svg>',
    );
    expect(svg).not.toBeNull();
    expect(svg).not.toMatch(
      /script|onload|foreignObject|tracker|evil|javascript/i,
    );
    expect(svg).toContain('<use href="#a"');
    expect(svg).toContain('fill="url(#g)"');
  });

  it("実体の定義を含むもの、svg でないものは受け付けない", () => {
    expect(
      sanitizeSvg(
        '<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>',
      ),
    ).toBeNull();
    expect(sanitizeSvg("<html></html>")).toBeNull();
  });

  it("BIMI のロゴはそのまま使える形で残す", () => {
    const svg = sanitizeSvg(LOGO);
    expect(svg).toContain("<rect");
    expect(svg).toContain('baseProfile="tiny-ps"');
  });
});

describe("parseBimiRecord", () => {
  it("l= と a= の https の URL を取り出す", () => {
    expect(
      parseBimiRecord([
        [
          "v=BIMI1; l=https://example.com/logo.svg; ",
          "a=https://example.com/vmc.pem",
        ],
      ]),
    ).toEqual({
      logo: "https://example.com/logo.svg",
      authority: "https://example.com/vmc.pem",
    });
  });

  it("空や http の URL は null、BIMI でないレコードは null", () => {
    expect(parseBimiRecord([["v=BIMI1; l=; a=;"]])).toEqual({
      logo: null,
      authority: null,
    });
    expect(
      parseBimiRecord([["v=BIMI1; l=http://example.com/l.svg"]])?.logo,
    ).toBeNull();
    expect(parseBimiRecord([["v=spf1 -all"]])).toBeNull();
  });
});

describe("fetchBimi", () => {
  it("組織のドメインのレコードの証明書を確かめ、中のロゴを無害化して返す", async () => {
    const d = deps(
      { "https://example.co.jp/vmc.pem": "PEM" },
      {
        "default._bimi.example.co.jp": [
          [
            "v=BIMI1; l=https://example.co.jp/logo.svg; a=https://example.co.jp/vmc.pem",
          ],
        ],
      },
    );
    const checked: string[] = [];
    d.verifyMark = (pem, domain) => {
      checked.push(`${pem}@${domain}`);
      return LOGO.toString();
    };
    const image = await fetchBimi(d, "mail.example.co.jp");
    expect(checked).toEqual(["PEM@example.co.jp"]);
    expect(image && image !== "error" ? image.contentType : null).toBe(
      "image/svg+xml",
    );
    // l= のロゴは取りに行かない (証明書の中のロゴを使う)。
    expect(d.requested).toEqual(["https://example.co.jp/vmc.pem"]);
  });

  it("証明書が無い、または確かめられなければ使わない", async () => {
    const d = deps(
      {
        "https://example.com/logo.svg": LOGO,
        "https://example.com/vmc.pem": "PEM",
      },
      {
        "default._bimi.example.com": [
          ["v=BIMI1; l=https://example.com/logo.svg"],
        ],
        "default._bimi.mark.example.com": [
          [
            "v=BIMI1; l=https://example.com/logo.svg; a=https://example.com/vmc.pem",
          ],
        ],
      },
    );
    d.verifyMark = () => null;
    expect(await fetchBimi(d, "example.com")).toBeNull();
    expect(await fetchBimi(d, "mark.example.com")).toBeNull();
    expect(d.requested).toEqual(["https://example.com/vmc.pem"]);
  });

  it("DNS の問い合わせに失敗したら error (短い間だけ覚える)", async () => {
    const d = deps({});
    d.resolveTxt = async () => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    };
    expect(await fetchBimi(d, "example.com")).toBe("error");
  });
});

describe("findIconLinks", () => {
  it("大きいアイコンを先に並べ、相対 URL を解決する", () => {
    const html = `<head>
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="shortcut icon" href="http://insecure.example/i.ico">
      <link href='/icon.svg' rel='icon' type='image/svg+xml'>
    </head>`;
    expect(findIconLinks(html, "https://www.example.com/")).toEqual([
      "https://www.example.com/icon.svg",
      "https://www.example.com/apple.png",
      "https://www.example.com/favicon-16.png",
    ]);
  });
});

describe("fetchFavicon", () => {
  it("トップページのリンクから取り、無ければ /favicon.ico", async () => {
    const d = deps({
      "https://example.com/": '<link rel="icon" href="/a.png" sizes="64x64">',
      "https://example.com/a.png": PNG,
    });
    const image = await fetchFavicon(d, "example.com");
    expect(image && image !== "error" ? image.contentType : null).toBe(
      "image/png",
    );

    const fallback = deps({
      "https://example.org/": "<html></html>",
      "https://example.org/favicon.ico": Buffer.from([0, 0, 1, 0, 1, 0]),
    });
    const ico = await fetchFavicon(fallback, "example.org");
    expect(ico && ico !== "error" ? ico.contentType : null).toBe(
      "image/x-icon",
    );
  });

  it("画像でない応答は使わない", async () => {
    const d = deps({
      "https://example.com/": "<html></html>",
      "https://example.com/favicon.ico": "<html>not found</html>",
    });
    expect(await fetchFavicon(d, "example.com")).toBeNull();
  });
});

describe("その他", () => {
  it("Gravatar のハッシュは小文字にしたアドレスの SHA-256", () => {
    expect(gravatarHash(" Test@Example.com ")).toBe(
      gravatarHash("test@example.com"),
    );
    expect(gravatarHash("test@example.com")).toHaveLength(64);
  });

  it("個人向けのメールサービスはファビコンを使わない", () => {
    expect(isPersonalMailDomain("gmail.com")).toBe(true);
    expect(isPersonalMailDomain("docomo.ne.jp")).toBe(true);
    expect(isPersonalMailDomain("example.co.jp")).toBe(false);
  });

  it("画像でないものは受け付けない", () => {
    expect(acceptImage(Buffer.from("hello world"))).toBeNull();
  });
});
