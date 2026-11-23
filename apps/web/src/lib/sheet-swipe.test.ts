import { describe, expect, it } from "vitest";
import { sheetDismisses, sheetDragIntent, sheetOffset } from "./sheet-swipe";

describe("sheetDragIntent", () => {
  it("ほとんど動いていない間は決めない", () => {
    expect(sheetDragIntent(3, 5)).toBeNull();
  });
  it("下向きの動きを引き下ろしとして扱う", () => {
    expect(sheetDragIntent(2, 12)).toBe(true);
  });
  it("上向きや横向きの動きは扱わない", () => {
    expect(sheetDragIntent(0, -12)).toBe(false);
    expect(sheetDragIntent(20, 10)).toBe(false);
    expect(sheetDragIntent(-20, 10)).toBe(false);
  });
});

describe("sheetOffset", () => {
  it("上へは動かさない", () => {
    expect(sheetOffset(-30)).toBe(0);
    expect(sheetOffset(40)).toBe(40);
  });
});

describe("sheetDismisses", () => {
  it("高さの 3 分の 1 より下げたら閉じる", () => {
    expect(sheetDismisses(90, 300, 0)).toBe(false);
    expect(sheetDismisses(110, 300, 0)).toBe(true);
  });
  it("背の高いシートは、決まった長さまで引けば閉じる", () => {
    expect(sheetDismisses(170, 900, 0)).toBe(true);
    expect(sheetDismisses(120, 900, 0)).toBe(false);
  });
  it("素早く下へ払ったら、短くても閉じる", () => {
    expect(sheetDismisses(30, 600, 0.8)).toBe(true);
  });
  it("上へ戻しながら離したら閉じない", () => {
    expect(sheetDismisses(250, 600, -0.8)).toBe(false);
  });
  it("動いていなければ閉じない", () => {
    expect(sheetDismisses(0, 600, 1)).toBe(false);
  });
});
