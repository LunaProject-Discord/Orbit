import { type SsoProfile, ssoEmailDomainAllowed } from "@orbit/core";
import { authAccounts, type Database, users } from "@orbit/db";
import { and, eq, sql } from "drizzle-orm";
import { type SsoProviderRow, ssoAccountProviderId } from "./sso-providers.js";

export type SsoUserResult =
  | {
      ok: true;
      userId: string;
      /** このログインで Orbit の利用者を作った。 */
      created: boolean;
    }
  | {
      ok: false;
      error:
        /** IdP がメールアドレスを返さず、結び付ける先も作る先も決められない。 */
        | "email_missing"
        /** 同じメールアドレスの利用者がいるが、この IdP のメールアドレスは信頼しない設定。 */
        | "link_required"
        /** この IdP では利用者を自動で作らない設定。 */
        | "sign_up_disabled"
        /** 自動で作ってよいドメインではない。 */
        | "domain_not_allowed";
    };

type Provider = Pick<
  SsoProviderRow,
  "id" | "allowSignUp" | "allowedDomains" | "trustEmail"
>;

/** IdP のアカウントを結び付けた利用者を探す。 */
async function findLinkedUser(
  db: Database,
  providerKey: string,
  subject: string,
): Promise<string | null> {
  const [row] = await db
    .select({ userId: authAccounts.userId })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.providerId, providerKey),
        eq(authAccounts.accountId, subject),
      ),
    );
  return row?.userId ?? null;
}

async function findUserByEmail(
  db: Database,
  email: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`);
  return row?.id ?? null;
}

/** 利用者に IdP のアカウントを結び付ける。すでに誰かに結び付いていれば、その利用者を返す。 */
export async function linkSsoAccount(
  db: Database,
  providerKey: string,
  subject: string,
  userId: string,
): Promise<string> {
  await db
    .insert(authAccounts)
    .values({ userId, providerId: providerKey, accountId: subject })
    .onConflictDoNothing({
      target: [authAccounts.providerId, authAccounts.accountId],
    });
  return (await findLinkedUser(db, providerKey, subject)) ?? userId;
}

/** メールアドレスの @ より前 (名前が返らないときの表示名)。 */
function localPart(email: string): string {
  return email.slice(0, email.lastIndexOf("@")) || email;
}

/**
 * IdP で確かめた人を、Orbit の利用者に当てはめる。管理者が IdP ごとに決めた設定に従う。
 *   1. この IdP のアカウントを結び付けた利用者がいれば、その人。
 *   2. 同じメールアドレスの利用者がいれば、メールアドレスを信頼する IdP なら結び付ける。
 *   3. いなければ、自動で作る設定で、ドメインも許されていれば作る。
 */
export async function resolveSsoUser(
  db: Database,
  provider: Provider,
  profile: SsoProfile,
): Promise<SsoUserResult> {
  const providerKey = ssoAccountProviderId(provider.id);
  const linked = await findLinkedUser(db, providerKey, profile.subject);
  if (linked) return { ok: true, userId: linked, created: false };

  const email = profile.email;
  if (!email) return { ok: false, error: "email_missing" };

  const existing = await findUserByEmail(db, email);
  if (existing) {
    if (!provider.trustEmail) return { ok: false, error: "link_required" };
    const userId = await linkSsoAccount(
      db,
      providerKey,
      profile.subject,
      existing,
    );
    return { ok: true, userId, created: false };
  }

  if (!provider.allowSignUp) return { ok: false, error: "sign_up_disabled" };
  if (!ssoEmailDomainAllowed(email, provider.allowedDomains)) {
    return { ok: false, error: "domain_not_allowed" };
  }

  const created = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email,
        name: profile.name ?? localPart(email),
        // 確かめたかどうかは IdP 次第なので、信頼する設定のときだけ確認済みにする。
        emailVerified: provider.trustEmail,
      })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (!user) return null;
    await tx.insert(authAccounts).values({
      userId: user.id,
      providerId: providerKey,
      accountId: profile.subject,
    });
    return user.id;
  });
  if (created) return { ok: true, userId: created, created: true };

  // 同時に同じ人が作った (2 つのタブでログインしたなど)。もう一度当てはめ直す。
  const again = await findLinkedUser(db, providerKey, profile.subject);
  if (again) return { ok: true, userId: again, created: false };
  return provider.trustEmail
    ? resolveSsoUser(db, { ...provider, allowSignUp: false }, profile)
    : { ok: false, error: "link_required" };
}
