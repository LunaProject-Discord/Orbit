import { createHmac, timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import { z } from "zod";

/**
 * IdP (SSO) でのログインの最後の段。IdP の確認が済んだ利用者に、Orbit のセッションを作る。
 *
 * サーバーの中 (routes/sso.ts) からだけ auth.api.signInSso として呼ぶ。HTTP の受け口は作らない
 * (serverOnly)。2 段階認証は Better Auth の twoFactor プラグインがパスワードでのログインにしか
 * 働かないので、同じ手順 (途中の値を two_factor Cookie に置き、コードの確認は
 * /two-factor/verify-totp などに任せる) をここで行う。
 */

/** twoFactor プラグインと同じ名前と期限 (better-auth/plugins/two-factor の constant)。 */
const TWO_FACTOR_COOKIE_NAME = "two_factor";
const TRUST_DEVICE_COOKIE_NAME = "trust_device";
const TWO_FACTOR_COOKIE_MAX_AGE = 600;
const TRUST_DEVICE_MAX_AGE = 30 * 86_400;

const bodySchema = z.object({
  userId: z.string().min(1),
  /** この IdP では Orbit の 2 段階認証を求めない (管理者が IdP ごとに決める)。 */
  skipTwoFactor: z.boolean(),
});

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const ssoSignIn = () =>
  ({
    id: "orbit-sso-sign-in",
    endpoints: {
      signInSso: createAuthEndpoint.serverOnly(
        { method: "POST", body: bodySchema },
        async (ctx) => {
          const user = (await ctx.context.internalAdapter.findUserById(
            ctx.body.userId,
          )) as
            | (Awaited<
                ReturnType<typeof ctx.context.internalAdapter.findUserById>
              > & { twoFactorEnabled?: boolean | null })
            | null;
          if (!user) {
            throw new APIError("UNAUTHORIZED", {
              message: "user not found",
              code: "USER_NOT_FOUND",
            });
          }

          if (user.twoFactorEnabled && !ctx.body.skipTwoFactor) {
            // 「この端末では 30 日間コードの入力を省略する」の印があれば、コードは尋ねない
            // (twoFactor プラグインの readSignInTwoFactorState と同じ確かめ方)。
            const trustCookie = ctx.context.createAuthCookie(
              TRUST_DEVICE_COOKIE_NAME,
              { maxAge: TRUST_DEVICE_MAX_AGE },
            );
            const trusted = await ctx.getSignedCookie(
              trustCookie.name,
              ctx.context.secret,
            );
            let trustedDevice = false;
            if (trusted) {
              const [token, identifier] = trusted.split("!");
              if (
                token &&
                identifier &&
                sameText(
                  token,
                  hmac(ctx.context.secret, `${user.id}!${identifier}`),
                )
              ) {
                const record =
                  await ctx.context.internalAdapter.findVerificationValue(
                    identifier,
                  );
                trustedDevice =
                  !!record &&
                  record.value === user.id &&
                  new Date(record.expiresAt).getTime() > Date.now();
              }
            }

            if (!trustedDevice) {
              const cookie = ctx.context.createAuthCookie(
                TWO_FACTOR_COOKIE_NAME,
                { maxAge: TWO_FACTOR_COOKIE_MAX_AGE },
              );
              const identifier = `2fa-${generateRandomString(20)}`;
              const expiresAt = new Date(
                Date.now() + TWO_FACTOR_COOKIE_MAX_AGE * 1000,
              );
              await ctx.context.internalAdapter.createVerificationValue({
                value: user.id,
                identifier,
                expiresAt,
              });
              await ctx.context.internalAdapter.createVerificationValue({
                value: "0",
                identifier: `2fa-attempts-${identifier}`,
                expiresAt,
              });
              await ctx.setSignedCookie(
                cookie.name,
                identifier,
                ctx.context.secret,
                cookie.attributes,
              );
              return ctx.json({
                twoFactorRedirect: true,
                twoFactorMethods: ["totp"],
              });
            }
          }

          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          if (!session) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "failed to create session",
              code: "FAILED_TO_CREATE_SESSION",
            });
          }
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ twoFactorRedirect: false });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
