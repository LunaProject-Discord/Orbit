import { describe, expect, it } from "vitest";
import { decideDraftSave } from "./draft-save.js";

const userId = "0192f1c8-0000-7000-8000-000000000001";
const other = "0192f1c8-0000-7000-8000-000000000002";

describe("decideDraftSave", () => {
  it("まだ無い下書きは作る", () => {
    expect(
      decideDraftSave({
        userId,
        baseRevision: null,
        existing: null,
        alreadySent: false,
      }),
    ).toEqual({ action: "create" });
  });

  it("元にした revision が今と同じなら上書きして 1 つ進める", () => {
    expect(
      decideDraftSave({
        userId,
        baseRevision: 3,
        existing: { userId, revision: 3 },
        alreadySent: false,
      }),
    ).toEqual({ action: "update", revision: 4 });
  });

  it("他の端末が先に書き換えていたら上書きしない", () => {
    expect(
      decideDraftSave({
        userId,
        baseRevision: 2,
        existing: { userId, revision: 3 },
        alreadySent: false,
      }),
    ).toEqual({ action: "conflict" });
  });

  it("作ったつもりの下書きがすでにあれば、今の内容を確かめさせる", () => {
    expect(
      decideDraftSave({
        userId,
        baseRevision: null,
        existing: { userId, revision: 1 },
        alreadySent: false,
      }),
    ).toEqual({ action: "conflict" });
  });

  it("他の端末で送信・破棄された下書きは、同じ ID では作り直さない", () => {
    expect(
      decideDraftSave({
        userId,
        baseRevision: 2,
        existing: null,
        alreadySent: false,
      }),
    ).toEqual({ action: "gone" });
    expect(
      decideDraftSave({
        userId,
        baseRevision: null,
        existing: null,
        alreadySent: true,
      }),
    ).toEqual({ action: "gone" });
  });

  it("他人の下書きは見つからない扱いにする", () => {
    expect(
      decideDraftSave({
        userId,
        baseRevision: 1,
        existing: { userId: other, revision: 1 },
        alreadySent: false,
      }),
    ).toEqual({ action: "not_found" });
  });
});
