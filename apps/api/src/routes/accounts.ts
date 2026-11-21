import { zValidator } from "@hono/zod-validator";
import { CHANNEL_ACCOUNTS, encryptCredentials } from "@mail/core";
import { changes, mailAccounts, mailboxes } from "@mail/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import { resolvesToPrivateAddress } from "../lib/host-check.js";
import { verifyImap } from "../lib/imap-verify.js";

const server = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
});

const createAccountBody = z.object({
  email: z.email().max(320),
  displayName: z.string().trim().max(200).optional(),
  provider: z
    .enum(["gmail", "microsoft", "icloud", "generic"])
    .default("generic"),
  imap: server,
  smtp: server,
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

const idParam = z.object({ id: z.uuid() });

/** クライアントへ返す形。認証情報は暗号文であっても返さない。 */
const publicColumns = {
  id: mailAccounts.id,
  email: mailAccounts.email,
  displayName: mailAccounts.displayName,
  provider: mailAccounts.provider,
  authType: mailAccounts.authType,
  imapHost: mailAccounts.imapHost,
  imapPort: mailAccounts.imapPort,
  imapSecure: mailAccounts.imapSecure,
  smtpHost: mailAccounts.smtpHost,
  smtpPort: mailAccounts.smtpPort,
  smtpSecure: mailAccounts.smtpSecure,
  username: mailAccounts.username,
  status: mailAccounts.status,
  lastError: mailAccounts.lastError,
  createdAt: mailAccounts.createdAt,
};

export function accountRoutes({
  db,
  encryptionKey,
  allowPrivateMailHosts,
}: RouteDeps) {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const rows = await db
      .select(publicColumns)
      .from(mailAccounts)
      .where(eq(mailAccounts.userId, c.var.user.id))
      .orderBy(asc(mailAccounts.createdAt));
    return c.json({ accounts: rows });
  });

  app.post("/", zValidator("json", createAccountBody), async (c) => {
    const body = c.req.valid("json");
    const user = c.var.user;

    if (!allowPrivateMailHosts) {
      for (const host of [body.imap.host, body.smtp.host]) {
        const isPrivate = await resolvesToPrivateAddress(host).catch(
          () => null,
        );
        if (isPrivate === null) {
          return c.json({ error: "host_not_found", host }, 422);
        }
        if (isPrivate) {
          return c.json({ error: "host_not_allowed", host }, 422);
        }
      }
    }

    const [existing] = await db
      .select({ id: mailAccounts.id })
      .from(mailAccounts)
      .where(
        and(
          eq(mailAccounts.userId, user.id),
          eq(mailAccounts.email, body.email),
        ),
      );
    if (existing) {
      return c.json({ error: "account_exists" }, 409);
    }

    const verified = await verifyImap({
      ...body.imap,
      username: body.username,
      password: body.password,
    });
    if (!verified.ok) {
      return c.json({ error: verified.reason, detail: verified.detail }, 422);
    }

    const account = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(mailAccounts)
        .values({
          userId: user.id,
          email: body.email,
          displayName: body.displayName || null,
          provider: body.provider,
          authType: "password",
          imapHost: body.imap.host,
          imapPort: body.imap.port,
          imapSecure: body.imap.secure,
          smtpHost: body.smtp.host,
          smtpPort: body.smtp.port,
          smtpSecure: body.smtp.secure,
          username: body.username,
          credentialsEncrypted: encryptCredentials(
            { type: "password", password: body.password },
            encryptionKey,
            user.id,
          ),
        })
        .onConflictDoNothing()
        .returning(publicColumns);
      if (!row) return null;
      await tx.insert(changes).values({
        userId: user.id,
        entity: "account",
        entityId: row.id,
        op: "upsert",
      });
      // コミット時に同期ワーカーへ届き、すぐに同期が始まる。
      await tx.execute(sql`select pg_notify(${CHANNEL_ACCOUNTS}, ${row.id})`);
      return row;
    });
    if (!account) {
      return c.json({ error: "account_exists" }, 409);
    }
    return c.json({ account }, 201);
  });

  app.delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const user = c.var.user;
    const deleted = await db.transaction(async (tx) => {
      const [row] = await tx
        .delete(mailAccounts)
        .where(and(eq(mailAccounts.id, id), eq(mailAccounts.userId, user.id)))
        .returning({ id: mailAccounts.id });
      if (!row) return false;
      await tx.insert(changes).values({
        userId: user.id,
        entity: "account",
        entityId: id,
        op: "delete",
      });
      await tx.execute(sql`select pg_notify(${CHANNEL_ACCOUNTS}, ${id})`);
      return true;
    });
    if (!deleted) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.body(null, 204);
  });

  app.get("/:id/mailboxes", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const rows = await db
      .select({
        id: mailboxes.id,
        path: mailboxes.path,
        name: mailboxes.name,
        specialUse: mailboxes.specialUse,
        lastSyncedAt: mailboxes.lastSyncedAt,
      })
      .from(mailboxes)
      .innerJoin(mailAccounts, eq(mailboxes.accountId, mailAccounts.id))
      .where(
        and(eq(mailAccounts.id, id), eq(mailAccounts.userId, c.var.user.id)),
      )
      .orderBy(asc(mailboxes.path));
    return c.json({ mailboxes: rows });
  });

  return app;
}
