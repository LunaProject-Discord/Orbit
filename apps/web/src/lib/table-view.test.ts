import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLUMNS,
  DEFAULT_TABLE_VIEW,
  gridTemplate,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  moveColumn,
  nextSort,
  parseTableView,
} from "@/lib/table-view";

const order = (columns: { id: string }[]) => columns.map((column) => column.id);

describe("parseTableView", () => {
  it("保存が無い・壊れているときは標準", () => {
    expect(parseTableView(null)).toEqual(DEFAULT_TABLE_VIEW);
    expect(parseTableView("{")).toEqual(DEFAULT_TABLE_VIEW);
  });

  it("知らない列や重複を捨て、足りない列を標準の位置に足す", () => {
    const parsed = parseTableView(
      JSON.stringify({
        columns: [
          { id: "date", visible: true, width: 5000 },
          { id: "unknown", visible: true, width: 10 },
          { id: "subject", visible: false, width: 0 },
          { id: "date", visible: false, width: 100 },
        ],
      }),
    );
    const ids = order(parsed.columns);
    expect(ids.indexOf("date")).toBe(ids.indexOf("subject") - 1);
    expect(parsed.columns).toHaveLength(DEFAULT_COLUMNS.length);
    // 件名の列は隠せない。幅は上限に収める。
    expect(parsed.columns.find((c) => c.id === "subject")?.visible).toBe(true);
    expect(parsed.columns.find((c) => c.id === "date")?.width).toBe(300);
    // 標準で件名の前にある列は、件名の前に足す。
    expect(order(parsed.columns).indexOf("flagged")).toBeLessThan(
      order(parsed.columns).indexOf("subject"),
    );
  });

  it("並び順と一覧の幅を読む", () => {
    const parsed = parseTableView(
      JSON.stringify({ sort: { key: "from", order: "asc" }, paneWidth: 10 }),
    );
    expect(parsed.sort).toEqual({ key: "from", order: "asc" });
    expect(parsed.paneWidth).toBe(MIN_PANE_WIDTH);
    expect(parseTableView(JSON.stringify({ paneHeight: 5 })).paneHeight).toBe(
      MIN_PANE_HEIGHT,
    );
    expect(
      parseTableView(JSON.stringify({ sort: { key: "size", order: "asc" } }))
        .sort,
    ).toEqual(DEFAULT_TABLE_VIEW.sort);
  });
});

describe("moveColumn", () => {
  it("列を別の列の前後へ移す", () => {
    const moved = moveColumn(DEFAULT_COLUMNS, "date", "subject", "before");
    expect(order(moved).indexOf("date")).toBe(
      order(moved).indexOf("subject") - 1,
    );
    const after = moveColumn(DEFAULT_COLUMNS, "flagged", "date", "after");
    expect(order(after).indexOf("flagged")).toBe(
      order(after).indexOf("date") + 1,
    );
    expect(moved).toHaveLength(DEFAULT_COLUMNS.length);
  });
});

describe("nextSort", () => {
  it("同じ列なら向きを変え、別の列なら日時は新しい順・ほかは昇順から", () => {
    expect(nextSort({ key: "date", order: "desc" }, "date")).toEqual({
      key: "date",
      order: "asc",
    });
    expect(nextSort({ key: "date", order: "desc" }, "subject")).toEqual({
      key: "subject",
      order: "asc",
    });
    expect(nextSort({ key: "subject", order: "asc" }, "date")).toEqual({
      key: "date",
      order: "desc",
    });
  });
});

describe("gridTemplate", () => {
  it("件名の列だけ残りの幅に広げる", () => {
    expect(
      gridTemplate([
        { id: "flagged", visible: true, width: 28 },
        { id: "subject", visible: true, width: 0 },
        { id: "date", visible: true, width: 150 },
      ]),
    ).toBe("28px minmax(120px, 1fr) 150px");
  });
});
