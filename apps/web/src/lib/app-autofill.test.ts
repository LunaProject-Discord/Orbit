// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  guardFields,
  isCredentialAutocomplete,
  startAutofillGuard,
} from "@/lib/app-autofill";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isCredentialAutocomplete", () => {
  it("ログインの欄だけを資格情報とみなす", () => {
    expect(isCredentialAutocomplete("current-password")).toBe(true);
    expect(isCredentialAutocomplete("username webauthn")).toBe(true);
    expect(isCredentialAutocomplete("New-Password")).toBe(true);
    expect(isCredentialAutocomplete("email")).toBe(false);
    expect(isCredentialAutocomplete("off")).toBe(false);
    expect(isCredentialAutocomplete(null)).toBe(false);
  });
});

describe("guardFields", () => {
  it("資格情報の欄以外に autocomplete=off を付ける", () => {
    document.body.innerHTML = `
      <input id="plain" />
      <input id="email" type="email" autocomplete="email" />
      <textarea id="body"></textarea>
      <input id="password" type="password" autocomplete="current-password" />`;
    expect(guardFields(document)).toBe(true);
    const value = (id: string) =>
      document.getElementById(id)?.getAttribute("autocomplete");
    expect(value("plain")).toBe("off");
    expect(value("email")).toBe("off");
    expect(value("body")).toBe("off");
    expect(value("password")).toBe("current-password");
  });

  it("資格情報の欄がなければ false", () => {
    document.body.innerHTML = `<input />`;
    expect(guardFields(document)).toBe(false);
  });
});

describe("startAutofillGuard", () => {
  it("あとから増えた欄や付け直された値も off にし、パスワード欄の有無を知らせる", async () => {
    const onChange = vi.fn();
    const stop = startAutofillGuard(document, onChange);
    expect(onChange).toHaveBeenLastCalledWith(false);

    const input = document.createElement("input");
    document.body.append(input);
    await flush();
    expect(input.getAttribute("autocomplete")).toBe("off");

    input.setAttribute("autocomplete", "name");
    await flush();
    expect(input.getAttribute("autocomplete")).toBe("off");

    const wrapper = document.createElement("div");
    wrapper.innerHTML = `<input type="password" autocomplete="current-password" />`;
    document.body.append(wrapper);
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(true);

    wrapper.remove();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(3);
    stop();
  });
});
