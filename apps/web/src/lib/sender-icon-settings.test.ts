import { afterEach, describe, expect, it } from "vitest";
import {
  changeSenderIconGravatar,
  currentSenderIconGravatar,
  refreshSenderIconSettings,
  resetSenderIconSettingsForTest,
} from "./sender-icon-settings";

afterEach(() => resetSenderIconSettingsForTest());

describe("差出人のアイコンの Gravatar の設定", () => {
  it("サーバーの値を使い、古いサーバー (項目が無い) ではオフにする", async () => {
    await refreshSenderIconSettings(async () => ({ senderIconGravatar: true }));
    expect(currentSenderIconGravatar()).toBe(true);
    await refreshSenderIconSettings(async () => ({}));
    expect(currentSenderIconGravatar()).toBe(false);
  });

  it("保存できなければ元に戻し、false を返す", async () => {
    expect(
      await changeSenderIconGravatar(true, async () => {
        throw new Error("offline");
      }),
    ).toBe(false);
    expect(currentSenderIconGravatar()).toBe(false);
    expect(await changeSenderIconGravatar(true, async () => {})).toBe(true);
    expect(currentSenderIconGravatar()).toBe(true);
  });
});
