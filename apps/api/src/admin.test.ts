/**
 * 管理者アカウントの API を、実際の PostgreSQL で確かめる。
 *
 * 初回セットアップ (合言葉)、ログイン (名前 + パスワード、2 段階認証)、
 * 管理者と一般の利用者のトークンが互いに使えないこと、許可リスト外の受け口が 404 になることを見る。
 *
 * DATABASE_URL が無い環境では実行しない。接続先に確認用の DB を作り、終わったら消す。
 */
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { adminUsers, createDb, type Database, invitations } from "@orbit/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminAuth } from "./admin-auth.js";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { SetupCode } from "./lib/admin-setup.js";
import { EventsHub } from "./lib/events-hub.js";
import { createAdmin } from "./routes/admin.js";

const adminUrl = process.env.DATABASE_URL;
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery staple";
const encryptionKey = Buffer.alloc(32, 7);

/** base32 (RFC 4648) を bytes に戻す。otpauth URI の secret はこの形。 */
function base32Decode(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error(`base32 ではない文字: ${char}`);
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** 認証アプリと同じ TOTP (RFC 6238: HMAC-SHA1、30 秒、6 桁) を計算する。 */
function totp(secretBase32: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac("sha1", base32Decode(secretBase32))
    .update(counter)
    .digest();
  const offset = (hmac[hmac.length - 1] as number) & 0x0f;
  const code =
    (((hmac[offset] as number) & 0x7f) << 24) |
    ((hmac[offset + 1] as number) << 16) |
    ((hmac[offset + 2] as number) << 8) |
    (hmac[offset + 3] as number);
  return String(code % 1_000_000).padStart(6, "0");
}

/** 応答の X-Auth-State (JSON) を、要求の X-Auth-State (「名前=値; 名前=値」) にする。 */
function authStateRequestHeader(response: Response): string {
  const raw = response.headers.get("x-auth-state");
  if (!raw) throw new Error("X-Auth-State が返っていません。");
  const state = JSON.parse(raw) as Record<
    string,
    { value: string; maxAge: number | null }
  >;
  return Object.entries(state)
    .filter(([, entry]) => entry.value !== "")
    .map(([name, entry]) => `${name}=${entry.value}`)
    .join("; ");
}

it.runIf(process.env.CI === "true")("CI では DATABASE_URL がある", () => {
  expect(adminUrl).toBeTruthy();
});

describe.skipIf(!adminUrl)("管理者アカウントの API", () => {
  const dbName = `mail_admin_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let dir: string;
  let signUp: ReturnType<typeof createAuth>;
  let adminSignUp: ReturnType<typeof createAdminAuth>;
  /** SetupCode に渡した log が受け取った合言葉。 */
  const logged: string[] = [];

  const json = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        origin: ORIGIN,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const setupBody = (over: Record<string, unknown> = {}) => ({
    code: logged.at(-1) ?? "",
    username: "Root",
    name: "最初の管理者",
    password: PASSWORD,
    ...over,
  });
  const adminLogin = async (username: string, password = PASSWORD) => {
    const response = await json("POST", "/v1/admin/auth/sign-in/username", {
      username,
      password,
    });
    return { response, token: response.headers.get("set-auth-token") };
  };
  const adminCount = async () => {
    const result = await db.execute(
      sql`select count(*)::int as n from admin_users`,
    );
    return (result.rows[0] as { n: number }).n;
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    ({ db, pool } = createDb(url.toString()));
    // uuidv7() は PostgreSQL 18 から。古い版で確かめるときだけ、代わりの関数を置く。
    await db.execute(sql`do $$ begin
      if to_regproc('uuidv7') is null then
        create function uuidv7() returns uuid language sql volatile
          as 'select gen_random_uuid()';
      end if;
    end $$`);
    await migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/db/drizzle", import.meta.url),
      ),
    });

    dir = await mkdtemp(join(tmpdir(), "mail-admin-"));
    process.env.ATTACHMENTS_DIR = dir;
    const authOptions = {
      db,
      secret: "admin-test-secret-admin-test-secret-admin",
      baseURL: "http://localhost:8787",
      trustedOrigins: [ORIGIN],
    };
    signUp = createAuth({ ...authOptions, allowSignUp: true });
    adminSignUp = createAdminAuth({ ...authOptions, allowSignUp: true });
    app = createApp({
      db,
      auth: createAuth(authOptions),
      signUpAuth: signUp,
      adminAuth: createAdminAuth(authOptions),
      adminSignUpAuth: adminSignUp,
      setupCode: new SetupCode((code) => logged.push(code)),
      hub: new EventsHub(url.toString()),
      allowedOrigins: [ORIGIN],
      encryptionKey,
      allowPrivateMailHosts: false,
      microsoft: null,
      google: null,
      webPushPublicKey: "test-public-key",
      fcmEnabled: true,
      webOrigin: ORIGIN,
      mailer: null,
      build: { version: "0.0.0-test", commit: null },
      updatePolicy: {
        channel: "stable",
        pinnedVersion: null,
        serverAutoUpdate: false,
        appUpdate: "auto",
      },
      appReleasesDir: null,
      publicUrl: "http://localhost:8787",
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    // 接続が閉じ終わるまで少しかかることがあるので、消せるまで繰り返す。
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await admin?.query(`drop database if exists ${dbName}`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await admin?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // 上から順に実行する (最初は管理者が 0 人で、途中で最初の管理者ができる)。
  describe("初回セットアップ", () => {
    it("管理者が 0 人なら needed: true で、ログインが要る API は 401", async () => {
      const response = await json("GET", "/v1/admin/setup");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ needed: true });
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
      // もう一度呼んでも、合言葉は作り直さない。
      await json("GET", "/v1/admin/setup");
      expect(logged).toHaveLength(1);
      expect((await json("GET", "/v1/admin/me")).status).toBe(401);
    });

    it("合言葉が違うと 403 invalid_code で、作られない", async () => {
      const response = await json(
        "POST",
        "/v1/admin/setup",
        setupBody({ code: "AAAAA-AAAAA-AAAAA-AAAAA" }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "invalid_code" });
      expect(await adminCount()).toBe(0);
    });

    it.each([
      ["空白を含む名前", "a b"],
      ["記号を含む名前", "a@b!"],
      ["2 文字の名前", "ab"],
    ])("%s は 400 で、作られない", async (_label, username) => {
      const response = await json(
        "POST",
        "/v1/admin/setup",
        setupBody({ username }),
      );
      expect(response.status).toBe(400);
      expect(await adminCount()).toBe(0);
    });

    it("短いパスワードは 400 password_too_short", async () => {
      const response = await json(
        "POST",
        "/v1/admin/setup",
        setupBody({ password: "short" }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "password_too_short" });
      expect(await adminCount()).toBe(0);
    });

    it("同時に 2 回送っても、管理者は 1 人しかできない", async () => {
      const [first, second] = await Promise.all([
        json("POST", "/v1/admin/setup", setupBody()),
        json("POST", "/v1/admin/setup", setupBody()),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      const rejected = first.status === 409 ? first : second;
      expect(await rejected.json()).toEqual({ error: "already_set_up" });
      expect(await adminCount()).toBe(1);
    });

    it("作成後は GET が needed: false、POST は 409 already_set_up", async () => {
      const get = await json("GET", "/v1/admin/setup");
      expect(await get.json()).toEqual({ needed: false });
      const post = await json("POST", "/v1/admin/setup", setupBody());
      expect(post.status).toBe(409);
      expect(await post.json()).toEqual({ error: "already_set_up" });
      expect(await adminCount()).toBe(1);
    });

    it("正しければ 201 で、名前は小文字になる", async () => {
      const [row] = await db.select().from(adminUsers);
      expect(row?.username).toBe("root");
      expect(row?.name).toBe("最初の管理者");
    });
  });

  describe("ログインと許可リスト", () => {
    let token = "";

    it("名前とパスワードでログインでき、set-auth-token が返る", async () => {
      const { response, token: issued } = await adminLogin("root");
      expect(response.status).toBe(200);
      expect(issued).toBeTruthy();
      token = issued as string;
      const me = await json("GET", "/v1/admin/me", undefined, bearer(token));
      expect(me.status).toBe(200);
      const body = (await me.json()) as { admin: { username: string } };
      expect(body.admin.username).toBe("root");
    });

    it("名前は大文字小文字を区別せず、パスワード違いは失敗する", async () => {
      expect((await adminLogin("ROOT")).token).toBeTruthy();
      const wrong = await adminLogin("root", "wrong password 123");
      expect(wrong.response.status).toBe(401);
      expect(wrong.token).toBeNull();
    });

    it.each([
      [
        "POST",
        "/sign-in/email",
        { email: "root@admin.orbit.invalid", password: PASSWORD },
      ],
      [
        "POST",
        "/sign-up/email",
        {
          email: "x@admin.orbit.invalid",
          name: "x",
          password: PASSWORD,
          username: "xxx",
        },
      ],
      ["POST", "/update-user", { name: "改名" }],
      ["POST", "/change-email", { newEmail: "new@example.com" }],
      ["POST", "/is-username-available", { username: "someone" }],
      [
        "POST",
        "/request-password-reset",
        { email: "root@admin.orbit.invalid" },
      ],
    ])("許可リストに無い %s %s は 404", async (method, path, body) => {
      const response = await json(
        method,
        `/v1/admin/auth${path}`,
        body,
        bearer(token),
      );
      expect(response.status).toBe(404);
      expect(await adminCount()).toBe(1);
    });

    it("一般の /v1/auth では、管理者の名前やダミーアドレスでログインできない", async () => {
      for (const email of ["root", "root@admin.orbit.invalid"]) {
        const response = await json("POST", "/v1/auth/sign-in/email", {
          email,
          password: PASSWORD,
        });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.headers.get("set-auth-token")).toBeNull();
      }
    });
  });

  describe("管理者と一般の利用者の分離", () => {
    it("管理者のトークンでは /v1/me と /v1/accounts は 401", async () => {
      const { token } = await adminLogin("root");
      expect(token).toBeTruthy();
      for (const path of ["/v1/me", "/v1/accounts"]) {
        const response = await json(
          "GET",
          path,
          undefined,
          bearer(token as string),
        );
        expect(response.status).toBe(401);
      }
    });

    it("一般の利用者のトークンでは /v1/admin/me は 401", async () => {
      const email = "plain-user@example.com";
      await signUp.api.signUpEmail({
        body: { email, name: "利用者", password: PASSWORD },
      });
      const response = await json("POST", "/v1/auth/sign-in/email", {
        email,
        password: PASSWORD,
      });
      const userToken = response.headers.get("set-auth-token");
      expect(userToken).toBeTruthy();
      // 利用者としては有効なトークン。
      expect(
        (await json("GET", "/v1/me", undefined, bearer(userToken as string)))
          .status,
      ).toBe(200);
      for (const path of [
        "/v1/admin/me",
        "/v1/admin/security",
        "/v1/admin/admins",
        "/v1/admin/users",
      ]) {
        const denied = await json(
          "GET",
          path,
          undefined,
          bearer(userToken as string),
        );
        expect(denied.status).toBe(401);
      }
    });
  });

  describe("管理者の API", () => {
    let token = "";
    let adminId = "";

    it("GET /security、PUT /security/name、GET /admins、GET /users", async () => {
      token = (await adminLogin("root")).token as string;
      const [row] = await db.select().from(adminUsers);
      adminId = row?.id as string;

      const security = await json(
        "GET",
        "/v1/admin/security",
        undefined,
        bearer(token),
      );
      expect(security.status).toBe(200);
      expect(await security.json()).toEqual({
        username: "root",
        twoFactorEnabled: false,
        passkeyCount: 0,
      });

      const rename = await json(
        "PUT",
        "/v1/admin/security/name",
        { name: "  新しい表示名  " },
        bearer(token),
      );
      expect(rename.status).toBe(200);
      expect(await rename.json()).toEqual({ name: "新しい表示名" });
      const me = await json("GET", "/v1/admin/me", undefined, bearer(token));
      expect(
        ((await me.json()) as { admin: { name: string } }).admin.name,
      ).toBe("新しい表示名");
      const empty = await json(
        "PUT",
        "/v1/admin/security/name",
        { name: " " },
        bearer(token),
      );
      expect(empty.status).toBe(400);

      const admins = await json(
        "GET",
        "/v1/admin/admins",
        undefined,
        bearer(token),
      );
      const listed = (await admins.json()) as {
        admins: { id: string; username: string; name: string }[];
      };
      expect(listed.admins.map((a) => a.username)).toEqual(["root"]);
      expect(listed.admins[0]?.id).toBe(adminId);

      const usersResponse = await json(
        "GET",
        "/v1/admin/users",
        undefined,
        bearer(token),
      );
      expect(usersResponse.status).toBe(200);
      const userList = (await usersResponse.json()) as {
        users: { email: string }[];
      };
      // 管理者は利用者の一覧に出ない。
      expect(userList.users.map((u) => u.email)).not.toContain(
        "root@admin.orbit.invalid",
      );
    });

    it("招待を発行すると、createdBy が管理者の id になる", async () => {
      const response = await json(
        "POST",
        "/v1/admin/invitations",
        { label: "テスト" },
        bearer(token),
      );
      expect(response.status).toBe(201);
      const rows = await db.select().from(invitations);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.createdBy).toBe(adminId);
      expect(rows[0]?.label).toBe("テスト");
    });
  });

  describe("2 段階認証", () => {
    it("有効にすると、ログインは twoFactorRedirect になり、コードでログインできる", async () => {
      const created = await createAdmin(db, adminSignUp, {
        username: "twofa",
        name: "二段階",
        password: PASSWORD,
      });
      expect(created.ok).toBe(true);
      const { token } = await adminLogin("twofa");
      expect(token).toBeTruthy();

      const enable = await json(
        "POST",
        "/v1/admin/auth/two-factor/enable",
        { password: PASSWORD },
        bearer(token as string),
      );
      expect(enable.status).toBe(200);
      const { totpURI } = (await enable.json()) as { totpURI: string };
      const secret = new URL(totpURI).searchParams.get("secret");
      expect(secret).toBeTruthy();

      const verify = await json(
        "POST",
        "/v1/admin/auth/two-factor/verify-totp",
        { code: totp(secret as string) },
        {
          ...bearer(token as string),
          ...(enable.headers.get("x-auth-state")
            ? { "x-auth-state": authStateRequestHeader(enable) }
            : {}),
        },
      );
      expect(verify.status).toBe(200);
      // 有効にした時点で Better Auth はセッションを作り直す (古いトークンは使えなくなる)。
      const renewed = verify.headers.get("set-auth-token");
      expect(renewed).toBeTruthy();
      expect(renewed).not.toBe(token);
      expect(
        (await json("GET", "/v1/admin/me", undefined, bearer(token as string)))
          .status,
      ).toBe(401);
      const security = await json(
        "GET",
        "/v1/admin/security",
        undefined,
        bearer(renewed as string),
      );
      expect(
        ((await security.json()) as { twoFactorEnabled: boolean })
          .twoFactorEnabled,
      ).toBe(true);

      // 次のログインは、パスワードだけでは通らない。
      const login = await adminLogin("twofa");
      expect(login.response.status).toBe(200);
      // Better Auth は set-auth-token を返すが、2 段階認証が済むまでセッションは無く、使えない。
      if (login.token) {
        const early = await json(
          "GET",
          "/v1/admin/me",
          undefined,
          bearer(login.token),
        );
        expect(early.status).toBe(401);
      }
      expect(await login.response.json()).toMatchObject({
        twoFactorRedirect: true,
      });
      const state = JSON.parse(
        login.response.headers.get("x-auth-state") ?? "{}",
      ) as Record<string, unknown>;
      expect(Object.keys(state).length).toBeGreaterThan(0);
      // 管理者用の Cookie の名前は orbit-admin で始まる (利用者のものと取り違えない)。
      for (const name of Object.keys(state)) {
        expect(name.startsWith("orbit-admin")).toBe(true);
      }
      expect(login.response.headers.get("set-cookie")).toBeNull();

      // 状態を返さないコードの確認は通らない。
      const withoutState = await json(
        "POST",
        "/v1/admin/auth/two-factor/verify-totp",
        {
          code: totp(secret as string),
        },
      );
      expect(withoutState.status).toBeGreaterThanOrEqual(400);
      expect(withoutState.headers.get("set-auth-token")).toBeNull();

      // 状態を返し、正しいコードを入れるとログインできる。
      const second = await json(
        "POST",
        "/v1/admin/auth/two-factor/verify-totp",
        { code: totp(secret as string) },
        { "x-auth-state": authStateRequestHeader(login.response) },
      );
      expect(second.status).toBe(200);
      const secondToken = second.headers.get("set-auth-token");
      expect(secondToken).toBeTruthy();
      const me = await json(
        "GET",
        "/v1/admin/me",
        undefined,
        bearer(secondToken as string),
      );
      expect(me.status).toBe(200);
    });
  });
});
