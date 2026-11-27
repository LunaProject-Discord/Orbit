import { describe, expect, it } from "vitest";
import { senderIconSources } from "./sender-icon";

describe("senderIconSources", () => {
  const verified = { verified: true, warnings: [], claimed: null, version: 2 };

  it("確認済みなら BIMI から探す", () => {
    expect(senderIconSources(verified, false)).toEqual(["bimi", "favicon"]);
    expect(senderIconSources(verified, true)).toEqual([
      "bimi",
      "gravatar",
      "favicon",
    ]);
  });

  it("確認できていなければ BIMI を使わない", () => {
    expect(
      senderIconSources(
        { verified: false, warnings: [], claimed: null },
        false,
      ),
    ).toEqual(["favicon"]);
  });

  it("古い決まり (版なし) の確認済みには BIMI を使わない (端末の古い控え)", () => {
    expect(
      senderIconSources({ verified: true, warnings: [], claimed: null }, false),
    ).toEqual(["favicon"]);
  });

  it("注意があれば、ロゴもサイトのアイコンも使わない", () => {
    const check = {
      verified: true,
      warnings: ["name_mismatch" as const],
      claimed: "Amazon",
    };
    expect(senderIconSources(check, false)).toEqual([]);
    expect(senderIconSources(check, true)).toEqual(["gravatar"]);
  });

  it("確認結果がまだ無ければ Gravatar だけ", () => {
    expect(senderIconSources(undefined, true)).toEqual(["gravatar"]);
    expect(senderIconSources(null, false)).toEqual([]);
  });

  it("差出人でない相手は、証明書で確かめる BIMI と Gravatar だけ", () => {
    expect(senderIconSources(null, false, true)).toEqual(["bimi"]);
    expect(senderIconSources(null, true, true)).toEqual(["bimi", "gravatar"]);
  });
});
