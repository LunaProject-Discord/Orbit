import { describe, expect, it } from "vitest";
import { layoutPickerRows } from "./picker";

describe("layoutPickerRows", () => {
  it("区切りごとに見出しを置き、決まった列数で折り返す", () => {
    const { rows, count } = layoutPickerRows(
      [
        { id: "a", label: "A", items: ["a1", "a2", "a3"] },
        { id: "empty", label: "空", items: [] },
        { id: "b", label: "B", items: ["b1"] },
      ],
      2,
    );
    expect(count).toBe(4);
    expect(rows).toEqual([
      { kind: "heading", section: "a", label: "A" },
      { kind: "items", section: "a", names: ["a1", "a2"], offset: 0 },
      { kind: "items", section: "a", names: ["a3"], offset: 2 },
      { kind: "heading", section: "b", label: "B" },
      { kind: "items", section: "b", names: ["b1"], offset: 3 },
    ]);
  });
});
