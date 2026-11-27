import { describe, expect, it } from "vitest";
import type { Attachment } from "@/lib/api";
import {
  attachmentKind,
  hasInvitePart,
  previewOf,
  referencedContentIds,
  replaceCidReferences,
  safeMimeType,
  splitAttachments,
  withoutInvitePart,
} from "@/lib/attachments";

const file = (values: Partial<Attachment>): Attachment => ({
  id: "00000000-0000-7000-8000-000000000001",
  filename: null,
  contentType: "application/octet-stream",
  size: 1000,
  contentId: null,
  inline: false,
  ...values,
});

describe("attachmentKind", () => {
  it("種類か拡張子から判定する", () => {
    expect(attachmentKind(file({ contentType: "image/png" }))).toBe("image");
    expect(attachmentKind(file({ contentType: "application/pdf" }))).toBe(
      "pdf",
    );
    expect(attachmentKind(file({ filename: "要望一覧.XLSX" }))).toBe("sheet");
    expect(
      attachmentKind(
        file({
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      ),
    ).toBe("document");
    expect(attachmentKind(file({ contentType: "message/rfc822" }))).toBe(
      "mail",
    );
    expect(attachmentKind(file({ filename: "data.bin" }))).toBe("file");
  });
});

describe("previewOf", () => {
  it("画像、PDF、テキストはプレビューできる", () => {
    expect(previewOf(file({ contentType: "image/jpeg" }))).toEqual({
      kind: "image",
      type: "image/jpeg",
    });
    expect(previewOf(file({ filename: "photo.PNG" }))).toEqual({
      kind: "image",
      type: "image/png",
    });
    expect(previewOf(file({ contentType: "application/pdf" }))).toEqual({
      kind: "pdf",
    });
    expect(previewOf(file({ contentType: "text/plain" }))).toEqual({
      kind: "text",
    });
  });

  it("SVG や HTML、大きすぎるファイルはプレビューしない", () => {
    expect(previewOf(file({ contentType: "image/svg+xml" }))).toBeNull();
    expect(
      previewOf(file({ contentType: "text/html", filename: "a.html" })),
    ).toBeNull();
    expect(
      previewOf(file({ contentType: "image/png", size: 31 * 1024 * 1024 })),
    ).toBeNull();
    expect(
      previewOf(file({ contentType: "text/plain", size: 2 * 1024 * 1024 })),
    ).toBeNull();
  });
});

describe("cid の参照", () => {
  const html =
    "<p><img src=\"cid:logo@example.com\"><img src='cid:photo%201'></p>" +
    '<div style="background:url(cid:bg)">cid:本文の文字は対象外</div>';

  it("参照している Content-ID を取り出す", () => {
    expect([...referencedContentIds(html)]).toEqual([
      "logo@example.com",
      "photo 1",
      "bg",
    ]);
  });

  it("参照されている画像だけを本文に埋め込む扱いにする", () => {
    const logo = file({
      id: "a",
      contentType: "image/png",
      contentId: "<logo@example.com>",
      inline: true,
    });
    const unused = file({
      id: "b",
      contentType: "image/png",
      contentId: "<other>",
      inline: true,
    });
    const pdf = file({ id: "c", contentType: "application/pdf" });
    expect(splitAttachments(html, [logo, unused, pdf])).toEqual({
      embedded: [logo],
      listed: [unused, pdf],
    });
    expect(splitAttachments(null, [logo]).listed).toEqual([logo]);
  });

  it("取得済みの画像の URL に置き換える", () => {
    const replaced = replaceCidReferences(
      html,
      new Map([
        ["logo@example.com", "data:image/png;base64,AAAA"],
        ["bg", "data:image/gif;base64,BBBB"],
      ]),
    );
    expect(replaced).toContain('<img src="data:image/png;base64,AAAA">');
    expect(replaced).toContain("url(data:image/gif;base64,BBBB)");
    // 取得していない画像と、本文の文字はそのまま。
    expect(replaced).toContain("cid:photo%201");
    expect(replaced).toContain("cid:本文の文字は対象外");
  });
});

describe("招待の添付", () => {
  const body = file({ id: "a", contentType: "text/calendar; method=REQUEST" });
  const ics = file({
    id: "b",
    contentType: "application/ics",
    filename: "invite.ics",
  });
  const pdf = file({ id: "c", contentType: "application/pdf" });

  it("text/calendar か .ics があれば招待として読む", () => {
    expect(hasInvitePart([pdf, body])).toBe(true);
    expect(hasInvitePart([ics])).toBe(true);
    expect(
      hasInvitePart([
        file({ contentType: "application/octet-stream", filename: "a.ICS" }),
      ]),
    ).toBe(true);
    expect(hasInvitePart([pdf])).toBe(false);
  });

  it("名前の無い text/calendar だけを一覧から外し、.ics のファイルは残す", () => {
    expect(withoutInvitePart([body, ics, pdf])).toEqual([ics, pdf]);
    const named = file({ contentType: "text/calendar", filename: "a.ics" });
    expect(withoutInvitePart([named])).toEqual([named]);
  });
});

describe("safeMimeType", () => {
  it("拡張子から種類を選ぶ (メールに書かれた種類より優先する)", () => {
    expect(safeMimeType(file({ filename: "見積書.PDF" }))).toBe(
      "application/pdf",
    );
    expect(
      safeMimeType(file({ filename: "写真.jpg", contentType: "text/html" })),
    ).toBe("image/jpeg");
    expect(safeMimeType(file({ filename: "議事録.docx" }))).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("拡張子で決まらなければ、既知の種類だけをメールから使う", () => {
    expect(safeMimeType(file({ contentType: "application/pdf" }))).toBe(
      "application/pdf",
    );
    expect(safeMimeType(file({ contentType: "Image/PNG; name=a.png" }))).toBe(
      "image/png",
    );
    expect(safeMimeType(file({ contentType: "image/jpg" }))).toBe("image/jpeg");
  });

  it("危ない種類や分からない種類は application/octet-stream にする", () => {
    expect(
      safeMimeType(file({ filename: "請求書.html", contentType: "text/html" })),
    ).toBe("application/octet-stream");
    expect(
      safeMimeType(
        file({
          filename: "update.apk",
          contentType: "application/vnd.android.package-archive",
        }),
      ),
    ).toBe("application/octet-stream");
    expect(
      safeMimeType(
        file({ filename: "logo.svg", contentType: "image/svg+xml" }),
      ),
    ).toBe("application/octet-stream");
    expect(safeMimeType(file({}))).toBe("application/octet-stream");
  });
});
