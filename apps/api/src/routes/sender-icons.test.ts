import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../context.js";
import type { IconSource, SenderIconService } from "../lib/sender-icons.js";
import { senderIconRoutes } from "./sender-icons.js";

/** 頼まれた取得元を覚えておき、何も見つからなかったことにする、取得の代わり。 */
function setup(allowed: boolean) {
  const asked: IconSource[][] = [];
  const refreshes: boolean[] = [];
  const icons = {
    find: async (
      _address: string,
      sources: IconSource[],
      options?: { refresh?: boolean },
    ) => {
      asked.push(sources);
      refreshes.push(options?.refresh === true);
      return null;
    },
  } as unknown as SenderIconService;
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("user", { id: "u1" } as AppEnv["Variables"]["user"]);
    await next();
  });
  app.route(
    "/sender-icons",
    senderIconRoutes({ icons, allowGravatar: async () => allowed }),
  );
  const get = (sources: string, headers: Record<string, string> = {}) =>
    app.request(
      `/sender-icons?address=a@example.com&sources=${encodeURIComponent(sources)}`,
      { headers },
    );
  return { asked, refreshes, get };
}

describe("差出人のアイコンの受け口", () => {
  it("Gravatar の設定がオフなら、端末が頼んでも Gravatar を外す", async () => {
    const { asked, get } = setup(false);
    expect((await get("bimi,gravatar,favicon")).status).toBe(204);
    expect(asked).toEqual([["bimi", "favicon"]]);
  });

  it("Gravatar だけを頼まれて設定がオフなら、何も探さない", async () => {
    const { asked, get } = setup(false);
    expect((await get("gravatar")).status).toBe(204);
    expect(asked).toEqual([]);
  });

  it("設定がオンなら、頼まれた順のまま探す", async () => {
    const { asked, get } = setup(true);
    await get("gravatar,favicon");
    expect(asked).toEqual([["gravatar", "favicon"]]);
  });

  it("更新の見出しがあるときだけ、サーバーの控えも古ければ取り直すよう頼む", async () => {
    const { refreshes, get } = setup(false);
    await get("favicon");
    await get("favicon", { "X-Icon-Refresh": "1" });
    expect(refreshes).toEqual([false, true]);
  });
});
