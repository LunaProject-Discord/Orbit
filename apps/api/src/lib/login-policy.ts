import {
  type Database,
  devices,
  pushSubscriptions,
  serverSettings,
  sessions,
  users,
} from "@orbit/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

/**
 * パスワードでのログインに関わる Better Auth の受け口 (/v1/auth の下)。
 * 管理者がパスワードでのログインを止めたときは、ここを 403 にする。
 * パスワードの変更 (/change-password) は、ログイン中の利用者の操作なので止めない。
 */
export const PASSWORD_LOGIN_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/email",
  "/request-password-reset",
  "/reset-password",
]);

/** パスワードでのログインに関わる受け口か (/reset-password/:token も含む)。 */
export function isPasswordLoginPath(path: string): boolean {
  // 書き方の違い (// の重ね、末尾の /、大文字、%xx) で通り抜けられないよう、そろえてから比べる。
  let normalized = path;
  try {
    normalized = decodeURIComponent(path);
  } catch {
    // 正しくない %xx はそのまま比べる。
  }
  normalized = normalized
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (PASSWORD_LOGIN_PATHS.has(normalized)) return true;
  return normalized.startsWith("/reset-password/");
}

/** 一般の利用者がパスワードでログインできるか (設定の行が無ければできる)。 */
export async function passwordLoginEnabled(
  db: Pick<Database, "select">,
): Promise<boolean> {
  const [row] = await db
    .select({ value: serverSettings.passwordLogin })
    .from(serverSettings)
    .where(eq(serverSettings.id, true));
  return row?.value ?? true;
}

/** パスワードでのログインを許すかを変える。 */
export async function setPasswordLogin(
  db: Database,
  enabled: boolean,
): Promise<void> {
  await db
    .insert(serverSettings)
    .values({ id: true, passwordLogin: enabled })
    .onConflictDoUpdate({
      target: serverSettings.id,
      set: { passwordLogin: enabled, updatedAt: sql`now()` },
    });
}

/**
 * 利用者が無効にされているか。見つからない利用者は false (作ったばかりで、まだ確定して
 * いない利用者のセッションを作るとき (新規登録) に読むことがあるため)。
 */
export async function isUserDisabled(
  db: Pick<Database, "select">,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId));
  return row !== undefined && row.disabledAt !== null;
}

/**
 * 利用者を無効にする。全端末のセッションと通知の送り先 (Web Push、アプリ) を消し、
 * ログインも API も使えなくする。メールなどのデータは消さない。
 * いなければ "not_found"、すでに無効なら "already"。
 */
export async function disableUser(
  db: Database,
  userId: string,
): Promise<"ok" | "not_found" | "already"> {
  return db.transaction(async (tx) => {
    // ログインの最中 (セッションを作る直前) と重ならないよう、利用者の行を押さえる。
    const [row] = await tx
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!row) return "not_found";
    if (row.disabledAt === null) {
      await tx
        .update(users)
        .set({ disabledAt: sql`now()` })
        .where(and(eq(users.id, userId), isNull(users.disabledAt)));
    }
    // すでに無効でも、残っているものがあれば消す。
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    await tx.delete(devices).where(eq(devices.userId, userId));
    return row.disabledAt === null ? "ok" : "already";
  });
}

/** 無効にした利用者を戻す。いなければ false。 */
export async function enableUser(
  db: Database,
  userId: string,
): Promise<boolean> {
  const [exists] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId));
  if (!exists) return false;
  await db
    .update(users)
    .set({ disabledAt: null })
    .where(and(eq(users.id, userId), isNotNull(users.disabledAt)));
  return true;
}
