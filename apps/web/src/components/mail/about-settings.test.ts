import { describe, expect, it } from "vitest";
import type { DesktopBodyStatus } from "@/lib/app-update/body";
import { bodyUpdateView } from "./about-settings";

const status = (over: Partial<DesktopBodyStatus> = {}): DesktopBodyStatus => ({
  configured: true,
  version: "0.2.1",
  mode: "notify",
  phase: { kind: "idle" },
  pending: null,
  installed: null,
  ...over,
});

describe("アプリ本体の更新の表示", () => {
  it("鍵の無いビルドと、止められているときはボタンを出さない", () => {
    expect(bodyUpdateView(status({ configured: false }), "auto")).toMatchObject(
      { canCheck: false, install: null, tone: "muted" },
    );
    expect(bodyUpdateView(status(), "off")).toMatchObject({
      canCheck: false,
      install: null,
    });
  });

  it("確認中・取得中・入れている途中は回る印を出し、進み具合を出す", () => {
    expect(
      bodyUpdateView(status({ phase: { kind: "checking" } }), "auto"),
    ).toMatchObject({ working: true, text: "確認しています…" });
    expect(
      bodyUpdateView(
        status({
          phase: {
            kind: "downloading",
            version: "0.3.0",
            downloaded: 50,
            total: 200,
          },
        }),
        "auto",
      ),
    ).toMatchObject({
      working: true,
      progress: 25,
      text: "v0.3.0 を取得しています… 25%",
    });
    expect(
      bodyUpdateView(
        status({
          phase: {
            kind: "downloading",
            version: "0.3.0",
            downloaded: 50,
            total: null,
          },
        }),
        "auto",
      ),
    ).toMatchObject({ progress: null, text: "v0.3.0 を取得しています…" });
    expect(
      bodyUpdateView(
        status({ phase: { kind: "installing", version: "0.3.0" } }),
        "auto",
      ),
    ).toMatchObject({ working: true });
  });

  it("新しい版があれば「更新して再起動」、取得済みなら「今すぐ更新」、入れ終えていれば「今すぐ再起動」", () => {
    expect(
      bodyUpdateView(
        status({ phase: { kind: "available", version: "0.3.0" } }),
        "notify",
      ),
    ).toMatchObject({
      install: "update-restart",
      text: "新しいバージョン v0.3.0 があります (現在は v0.2.1)。",
    });
    expect(bodyUpdateView(status({ pending: "0.3.0" }), "auto")).toMatchObject({
      install: "install-now",
    });
    expect(
      bodyUpdateView(status({ installed: "0.3.0" }), "auto"),
    ).toMatchObject({ install: "restart" });
  });

  it("確認に失敗しても、取得済みの版があればそちらを出す", () => {
    const error = { kind: "error", message: "つながりません" } as const;
    expect(bodyUpdateView(status({ phase: error }), "auto")).toMatchObject({
      tone: "error",
      text: "つながりません",
    });
    expect(
      bodyUpdateView(status({ phase: error, pending: "0.3.0" }), "auto"),
    ).toMatchObject({ install: "install-now" });
  });

  it("最新のときと、古いアプリ (phase が無い) のとき", () => {
    expect(
      bodyUpdateView(
        status({ phase: { kind: "up-to-date", checkedAt: 1 } }),
        "auto",
      ),
    ).toMatchObject({ tone: "ok", text: "最新のバージョンです (v0.2.1)。" });
    expect(bodyUpdateView(status({ phase: undefined }), "auto")).toMatchObject({
      tone: "muted",
      canCheck: true,
    });
  });
});
