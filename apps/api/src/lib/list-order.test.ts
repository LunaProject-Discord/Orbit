import { describe, expect, it } from "vitest";
import { listOrderSql, nextListCursor } from "./list-order.js";

const ID = "01a20204-fedc-7eb2-a37f-deedef89d227";

describe("nextListCursor", () => {
  it("日時の並びでは、以前と同じ形 (日時_ID) で、細かい部分まで含めた日時を使う", () => {
    const cursor = nextListCursor(
      { sort: "date", order: "desc" },
      {
        receivedAt: new Date("2026-11-24T01:02:03.456Z"),
        id: ID,
        sortKey: "2026-11-24T01:02:03.456789Z",
      },
    );
    expect(cursor).toBe(`2026-11-24T01:02:03.456789Z_${ID}`);
    expect(listOrderSql({ sort: "date", order: "asc" }, cursor)).not.toBeNull();
  });

  it("件名などの並びでは、値・日時・ID を詰めた位置を作り、読み戻せる", () => {
    const cursor = nextListCursor(
      { sort: "subject", order: "asc" },
      {
        receivedAt: new Date("2026-11-24T01:02:03.456Z"),
        id: ID,
        sortKey: ["見積もりについて", "2026-11-24T01:02:03.456789Z"],
      },
    );
    expect(cursor.startsWith("k:")).toBe(true);
    const order = listOrderSql({ sort: "subject", order: "asc" }, cursor);
    expect(order?.after).not.toBeNull();
  });
});

describe("listOrderSql", () => {
  it("続きの位置が無ければ、条件を付けない", () => {
    const order = listOrderSql({ sort: "from", order: "desc" }, undefined);
    expect(order?.after).toBeNull();
    expect(order?.orderBy).toHaveLength(3);
  });

  it("並び順に合わない位置や壊れた位置は読めない (null)", () => {
    const dateCursor = `2026-11-24T01:02:03.456Z_${ID}`;
    expect(
      listOrderSql({ sort: "subject", order: "asc" }, dateCursor),
    ).toBeNull();
    expect(listOrderSql({ sort: "date", order: "desc" }, "k:abc")).toBeNull();
    expect(listOrderSql({ sort: "to", order: "asc" }, "k:!!!")).toBeNull();
    const badId = `k:${Buffer.from(JSON.stringify(["a", "2026-11-24T00:00:00Z", "x"])).toString("base64url")}`;
    expect(listOrderSql({ sort: "to", order: "asc" }, badId)).toBeNull();
    const badDate = `k:${Buffer.from(JSON.stringify(["a", "yesterday", ID])).toString("base64url")}`;
    expect(listOrderSql({ sort: "to", order: "asc" }, badDate)).toBeNull();
  });
});
