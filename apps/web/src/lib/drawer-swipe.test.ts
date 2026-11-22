import { describe, expect, it } from "vitest";
import {
  drawerOffset,
  drawerSettlesOpen,
  startsDrawerOpen,
} from "@/lib/drawer-swipe";

describe("startsDrawerOpen", () => {
  it("スマホ幅の、画面の左端から始めた動きだけ", () => {
    expect(startsDrawerOpen(10, 390)).toBe(true);
    expect(startsDrawerOpen(24, 390)).toBe(true);
    expect(startsDrawerOpen(40, 390)).toBe(false);
  });

  it("サイドバーが常に出ている幅では受け付けない", () => {
    expect(startsDrawerOpen(10, 1024)).toBe(false);
  });
});

describe("drawerOffset", () => {
  it("開くときは、閉じた位置から指の分だけ出てくる", () => {
    expect(drawerOffset(0, 288, true)).toBe(-288);
    expect(drawerOffset(100, 288, true)).toBe(-188);
    expect(drawerOffset(500, 288, true)).toBe(0);
  });

  it("閉じるときは、開いた位置から左へだけ動く", () => {
    expect(drawerOffset(-100, 288, false)).toBe(-100);
    expect(drawerOffset(50, 288, false)).toBe(0);
    expect(drawerOffset(-900, 288, false)).toBe(-288);
  });
});

describe("drawerSettlesOpen", () => {
  it("ゆっくり離したら、半分より開いているかで決める", () => {
    expect(drawerSettlesOpen(-100, 288, 0)).toBe(true);
    expect(drawerSettlesOpen(-200, 288, 0.1)).toBe(false);
  });

  it("素早く払ったら、その向きに従う", () => {
    expect(drawerSettlesOpen(-250, 288, 0.8)).toBe(true);
    expect(drawerSettlesOpen(-20, 288, -0.8)).toBe(false);
  });
});
