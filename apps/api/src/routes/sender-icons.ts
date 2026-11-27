import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import {
  ICON_SOURCES,
  type IconSource,
  type SenderIconService,
} from "../lib/sender-icons.js";

const iconQuery = z.object({
  address: z.string().min(3).max(320),
  /** 探す取得元を、探す順にカンマ区切りで (bimi,gravatar,favicon)。 */
  sources: z.string().max(64).default(""),
});

/** 端末も 1 日は覚えておく (見つからなかった応答も同じ)。 */
const CACHE_CONTROL = "private, max-age=86400";

/**
 * 差出人のアイコン。見つかれば画像を、無ければ 204 を返す。
 * どの取得元を使うかは端末が決める (BIMI は送信元の確認が取れたメールだけ、
 * ファビコンはなりすましの疑いが無いときだけ)。Gravatar は、利用者の設定 (どの端末でも共通)
 * で許したときだけ使う。端末が頼んできても、設定がオフならサーバーで外す。
 */
export function senderIconRoutes({
  icons,
  allowGravatar,
}: {
  icons: SenderIconService;
  /** 利用者が Gravatar を使う設定にしているか。 */
  allowGravatar: (userId: string) => Promise<boolean>;
}) {
  const app = new Hono<AppEnv>();

  app.get("/", zValidator("query", iconQuery), async (c) => {
    const { address, sources } = c.req.valid("query");
    let wanted = [
      ...new Set(
        sources
          .split(",")
          .map((item) => item.trim())
          .filter((item): item is IconSource =>
            ICON_SOURCES.includes(item as IconSource),
          ),
      ),
    ];
    if (wanted.includes("gravatar") && !(await allowGravatar(c.var.user.id))) {
      wanted = wanted.filter((source) => source !== "gravatar");
    }
    let image: Awaited<ReturnType<SenderIconService["find"]>> = null;
    try {
      image = wanted.length > 0 ? await icons.find(address, wanted) : null;
    } catch (error) {
      console.error("差出人のアイコンを取得できませんでした", error);
      return c.body(null, 204, { "cache-control": "no-store" });
    }
    if (!image) return c.body(null, 204, { "cache-control": CACHE_CONTROL });
    return c.body(new Uint8Array(image.data), 200, {
      "content-type": image.contentType,
      "cache-control": CACHE_CONTROL,
      "x-content-type-options": "nosniff",
      // 端末が見せ方 (ファビコンは余白を付けるなど) を変えるのに使う。
      "x-icon-source": image.source,
      // 画像を直接開かれても、SVG の中のスクリプトなどは動かさない。
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
  });

  return app;
}
