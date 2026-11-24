// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  isSelectAllKey,
  SELECT_ALL_SCOPE_ATTRIBUTE,
  selectAllTargetsList,
} from "@/lib/shortcuts";

const key = (overrides: Partial<Parameters<typeof isSelectAllKey>[0]>) => ({
  key: "a",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...overrides,
});

describe("isSelectAllKey", () => {
  it("Ctrl+A と ⌘+A", () => {
    expect(isSelectAllKey(key({ ctrlKey: true }))).toBe(true);
    expect(isSelectAllKey(key({ metaKey: true }))).toBe(true);
    // Caps Lock などで大文字になっていても同じ。
    expect(isSelectAllKey(key({ ctrlKey: true, key: "A" }))).toBe(true);
  });
  it("ほかの組み合わせは対象にしない", () => {
    expect(isSelectAllKey(key({}))).toBe(false);
    expect(isSelectAllKey(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSelectAllKey(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSelectAllKey(key({ ctrlKey: true, isComposing: true }))).toBe(
      false,
    );
  });
});

describe("selectAllTargetsList", () => {
  document.body.innerHTML = `
    <section ${SELECT_ALL_SCOPE_ATTRIBUTE}>
      <button id="row">行</button>
      <input id="search" />
    </section>
    <article id="view"><p id="text">本文</p></article>
  `;
  const $ = (id: string) => document.getElementById(id);

  it("一覧の中の行にいるときは一覧を選ぶ", () => {
    expect(selectAllTargetsList($("row"), null)).toBe(true);
  });
  it("入力欄では文字の全選択に任せる", () => {
    expect(selectAllTargetsList($("search"), $("search"))).toBe(false);
  });
  it("どこにも入っていなければ、最後に押した場所で決める", () => {
    expect(selectAllTargetsList(document.body, $("row"))).toBe(true);
    expect(selectAllTargetsList(document.body, $("text"))).toBe(false);
  });
  it("まだどこも押していなければ一覧", () => {
    expect(selectAllTargetsList(document.body, null)).toBe(true);
  });
  it("一覧の外の要素にいるときは任せる", () => {
    expect(selectAllTargetsList($("view"), $("row"))).toBe(false);
  });
});
