import { describe, expect, it } from "vitest";
import { resolveMailboxRoles } from "./mailbox-roles.js";

describe("フォルダの役割の決め方", () => {
  it("上書きが無ければ、メールサーバーが知らせた役割を使う", () => {
    const roles = resolveMailboxRoles([
      { id: "a", detected: "inbox", override: null },
      { id: "b", detected: null, override: null },
    ]);
    expect(roles.get("a")).toBe("inbox");
    expect(roles.get("b")).toBeNull();
  });

  it("利用者が付けた役割を優先し、同じ役割だった元のフォルダは役割なしにする", () => {
    const roles = resolveMailboxRoles([
      { id: "server-junk", detected: "junk", override: null },
      { id: "docomo-junk", detected: null, override: "junk" },
      { id: "trash", detected: "trash", override: null },
    ]);
    expect(roles.get("docomo-junk")).toBe("junk");
    expect(roles.get("server-junk")).toBeNull();
    expect(roles.get("trash")).toBe("trash");
  });

  it("「役割なし」にしたフォルダは、ふつうのフォルダとして扱う", () => {
    const roles = resolveMailboxRoles([
      { id: "a", detected: "archive", override: "none" },
    ]);
    expect(roles.get("a")).toBeNull();
  });

  it("上書きを外すと、元の役割に戻る", () => {
    const roles = resolveMailboxRoles([
      { id: "server-junk", detected: "junk", override: null },
      { id: "docomo-junk", detected: null, override: null },
    ]);
    expect(roles.get("server-junk")).toBe("junk");
    expect(roles.get("docomo-junk")).toBeNull();
  });
});
