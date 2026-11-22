import { describe, expect, it } from "vitest";
import { uidValidityUpdate } from "./mailbox-sync.js";

describe("uidValidityUpdate", () => {
  it("最初の同期では、取り込む前に UIDVALIDITY だけを保存する", () => {
    // 取り込みが終わるまで保存しないと、その間に開いたメールへの既読などの操作が
    // UIDVALIDITY 無しで受け付けられ、反映時に失敗する (Gmail の追加直後に発生)。
    expect(uidValidityUpdate(null, 5n)).toEqual({ uidValidity: 5n });
  });

  it("変わっていなければ何も保存しない", () => {
    expect(uidValidityUpdate(5n, 5n)).toBeNull();
  });

  it("変わった場合は、前の番号体系の同期状態も捨てる", () => {
    expect(uidValidityUpdate(5n, 6n)).toEqual({
      uidValidity: 6n,
      uidNext: null,
      highestModseq: null,
      lastSyncedAt: null,
    });
  });
});
