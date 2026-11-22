import type { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import {
  clearRejection,
  createRejectionLogger,
  firstRejection,
  rejectionText,
} from "./imap-rejection.js";

describe("サーバーに拒否された命令の応答", () => {
  it("状態・コード・文面をつなげる", () => {
    expect(
      rejectionText({
        err: {
          responseStatus: "NO",
          serverResponseCode: "CANNOT",
          responseText: "Operation not allowed on this folder",
        },
      }),
    ).toBe("NO [CANNOT] Operation not allowed on this folder");
  });

  it("拒否ではないログは無視する", () => {
    expect(rejectionText({ msg: "connected" })).toBeNull();
    expect(rejectionText({ err: new Error("socket closed") })).toBeNull();
    expect(rejectionText(null)).toBeNull();
  });

  it("消した後で最初に拒否された 1 件を、接続ごとに覚える", () => {
    const { logger, attach } = createRejectionLogger();
    const client = {} as ImapFlow;
    attach(client);
    logger.warn({ err: { responseStatus: "NO", responseText: "first" } });
    logger.warn({ err: { responseStatus: "NO", responseText: "second" } });
    expect(firstRejection(client)).toBe("NO first");
    clearRejection(client);
    expect(firstRejection(client)).toBeNull();
    expect(firstRejection({} as ImapFlow)).toBeNull();
  });
});
