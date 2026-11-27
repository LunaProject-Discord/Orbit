/**
 * IdP (SSO) でのログインを、実際の PostgreSQL と、テストの中で立てた IdP で確かめる。
 *
 * 管理画面での IdP の登録、ログイン画面に出る IdP、ログインの開始と戻り (端末の合言葉の照合)、
 * 自動発行と許可するドメイン、既存の利用者との結び付け (メールを信頼する設定)、
 * Orbit の 2 段階認証 (IdP ごとに省ける)、IdP の削除を見る。
 *
 * DATABASE_URL が無い環境では実行しない。接続先に確認用の DB を作り、終わったら消す。
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type Database } from "@orbit/db";
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
const encryptionKey = Buffer.alloc(32, 9);
const CLIENT_ID = "orbit-client";
const CLIENT_SECRET = "orbit-secret";

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

type Profile = Record<string, unknown>;

/**
 * テスト用の IdP (Mailcow の OAuth2 と同じく、プロフィールは id / email / full_name)。
 * 認可コードごとに返すプロフィールを決めておく。
 */
function startIdp() {
  const codes = new Map<string, { profile: Profile; challenge?: string }>();
  const tokens = new Map<string, Profile>();
  const seen: { tokenBodies: URLSearchParams[] } = { tokenBodies: [] };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://idp");
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
        if (req.headers.authorization !== expected) {
          return send(401, { error: "invalid_client" });
        }
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        seen.tokenBodies.push(body);
        const entry = codes.get(body.get("code") ?? "");
        if (!entry || body.get("redirect_uri") !== `${ORIGIN}/oauth/sso`) {
          return send(400, { error: "invalid_grant" });
        }
        codes.delete(body.get("code") ?? "");
        const token = randomBytes(16).toString("hex");
        tokens.set(token, entry.profile);
        return send(200, { access_token: token, token_type: "Bearer" });
      }
      if (url.pathname === "/oauth/profile") {
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        const profile = tokens.get(token);
        if (!profile) return send(401, { error: "invalid_token" });
        return send(200, profile);
      }
      send(404, { error: "not_found" });
    });
  });
  return {
    server,
    codes,
    seen,
    /** このプロフィールでログインしたことにする認可コードを作る。 */
    issue(profile: Profile) {
      const code = randomBytes(12).toString("hex");
      codes.set(code, { profile });
      return code;
    },
  };
}

it.runIf(process.env.CI === "true")("CI では DATABASE_URL がある", () => {
  expect(adminUrl).toBeTruthy();
});

describe.skipIf(!adminUrl)("IdP (SSO) でのログイン", () => {
  const dbName = `mail_sso_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let dir: string;
  let signUp: ReturnType<typeof createAuth>;
  let adminToken: string;
  let idpBase: string;
  let providerId: string;
  const idp = startIdp();

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
  const asAdmin = (method: string, path: string, body?: unknown) =>
    json(method, path, body, bearer(adminToken));

  const providerBody = (over: Record<string, unknown> = {}) => ({
    name: "Mailcow",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    authorizationUrl: `${idpBase}/oauth/authorize`,
    tokenUrl: `${idpBase}/oauth/token`,
    userInfoUrl: `${idpBase}/oauth/profile`,
    scopes: "profile",
    subjectClaim: "id",
    emailClaim: "email",
    nameClaim: "full_name",
    allowSignUp: true,
    allowedDomains: ["example.com"],
    suggestMailAccount: true,
    ...over,
  });

  const updateProvider = async (over: Record<string, unknown>) => {
    const response = await asAdmin(
      "PUT",
      `/v1/admin/sso/${providerId}`,
      providerBody({ clientSecret: "", ...over }),
    );
    expect(response.status).toBe(200);
  };

  /** ログインを始め、IdP から戻ってくるところまで。 */
  const start = async (binding = randomBytes(32).toString("base64url")) => {
    const response = await json("POST", "/v1/auth/sso/start", {
      providerId,
      binding,
    });
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    return { url: new URL(url), binding };
  };

  const login = async (
    profile: Profile,
    headers: Record<string, string> = {},
  ) => {
    const { url, binding } = await start();
    const state = url.searchParams.get("state") as string;
    const response = await json(
      "POST",
      "/v1/auth/sso/callback",
      { code: idp.issue(profile), state, binding },
      headers,
    );
    return response;
  };

  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      idp.server.listen(0, "127.0.0.1", resolve),
    );
    idpBase = `http://127.0.0.1:${(idp.server.address() as AddressInfo).port}`;

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

    dir = await mkdtemp(join(tmpdir(), "mail-sso-"));
    process.env.ATTACHMENTS_DIR = dir;
    const authOptions = {
      db,
      secret: "sso-test-secret-sso-test-secret-sso-test",
      baseURL: "http://localhost:8787",
      trustedOrigins: [ORIGIN],
    };
    signUp = createAuth({ ...authOptions, allowSignUp: true });
    const adminSignUp = createAdminAuth({ ...authOptions, allowSignUp: true });
    app = createApp({
      db,
      auth: createAuth(authOptions),
      signUpAuth: signUp,
      adminAuth: createAdminAuth(authOptions),
      adminSignUpAuth: adminSignUp,
      setupCode: new SetupCode(() => {}),
      hub: new EventsHub(url.toString()),
      allowedOrigins: [ORIGIN],
      encryptionKey,
      // テストの IdP は http://127.0.0.1 なので、http を許す (開発用の設定)。
      allowPrivateMailHosts: true,
      microsoft: null,
      google: null,
      webPushPublicKey: null,
      fcmEnabled: false,
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

    const created = await createAdmin(db, adminSignUp, {
      username: "root",
      name: "管理者",
      password: PASSWORD,
    });
    expect(created.ok).toBe(true);
    const signIn = await json("POST", "/v1/admin/auth/sign-in/username", {
      username: "root",
      password: PASSWORD,
    });
    adminToken = signIn.headers.get("set-auth-token") as string;
    expect(adminToken).toBeTruthy();
  }, 120_000);

  afterAll(async () => {
    await new Promise((resolve) => idp.server.close(resolve));
    await pool?.end();
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

  // 上から順に実行する。
  describe("管理画面での登録", () => {
    it("管理者でなければ使えない", async () => {
      expect((await json("GET", "/v1/admin/sso")).status).toBe(401);
    });

    it("URL が足りない・使えない形なら保存しない", async () => {
      const missing = await asAdmin(
        "POST",
        "/v1/admin/sso",
        providerBody({ userInfoUrl: null }),
      );
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({
        error: "endpoints_required",
      });
      const bad = await asAdmin(
        "POST",
        "/v1/admin/sso",
        providerBody({ tokenUrl: "javascript:alert(1)" }),
      );
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: "invalid_url" });
    });

    it("登録すると、シークレットを除いて返り、ログイン画面に出る", async () => {
      const response = await asAdmin("POST", "/v1/admin/sso", providerBody());
      expect(response.status).toBe(201);
      const { provider } = (await response.json()) as {
        provider: Record<string, unknown>;
      };
      providerId = provider.id as string;
      expect(provider).not.toHaveProperty("clientSecret");
      expect(provider).not.toHaveProperty("clientSecretEncrypted");
      expect(provider.allowedDomains).toEqual(["example.com"]);

      const list = (await (await asAdmin("GET", "/v1/admin/sso")).json()) as {
        redirectUri: string;
      };
      expect(list.redirectUri).toBe(`${ORIGIN}/oauth/sso`);

      const features = (await (
        await json("GET", "/v1/auth-features")
      ).json()) as { sso: { id: string; name: string }[] };
      expect(features.sso).toEqual([{ id: providerId, name: "Mailcow" }]);

      // シークレットは暗号化して保存する。
      const stored = await db.execute(
        sql`select client_secret_encrypted from sso_providers`,
      );
      expect(
        (stored.rows[0] as { client_secret_encrypted: string })
          .client_secret_encrypted,
      ).not.toContain(CLIENT_SECRET);
    });
  });

  describe("ログイン", () => {
    it("開始すると、IdP のログイン画面の URL (PKCE 付き) を返す", async () => {
      const { url } = await start();
      expect(url.origin + url.pathname).toBe(`${idpBase}/oauth/authorize`);
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/oauth/sso`);
      expect(url.searchParams.get("scope")).toBe("profile");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("別の端末の合言葉では戻れない", async () => {
      const { url } = await start();
      const response = await json("POST", "/v1/auth/sso/callback", {
        code: idp.issue({ id: 1, email: "alice@example.com" }),
        state: url.searchParams.get("state"),
        binding: randomBytes(32).toString("base64url"),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_state" });
    });

    it("初めての人は利用者が作られ、そのままログインできる", async () => {
      const response = await login({
        id: 1,
        email: "Alice@Example.com",
        full_name: "Alice",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        twoFactorRedirect: false,
        created: true,
        suggestMailAccount: true,
        email: "alice@example.com",
      });
      const token = response.headers.get("set-auth-token") as string;
      expect(token).toBeTruthy();
      const me = await json("GET", "/v1/me", undefined, bearer(token));
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({
        user: { email: "alice@example.com", name: "Alice" },
      });
      // PKCE の検証値を IdP に送っている。
      expect(idp.seen.tokenBodies.at(-1)?.get("code_verifier")).toBeTruthy();
    });

    it("2 回目は同じ利用者 (メールアドレスが変わっても ID で見分ける)", async () => {
      const response = await login({ id: 1, email: "alice2@example.com" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ created: false });
      const token = response.headers.get("set-auth-token") as string;
      const me = await json("GET", "/v1/me", undefined, bearer(token));
      expect(await me.json()).toMatchObject({
        user: { email: "alice@example.com" },
      });
    });

    it("許可していないドメインの人は作らない", async () => {
      const response = await login({ id: 2, email: "bob@other.org" });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "domain_not_allowed" });
    });

    it("メールアドレスが無い人は作れない", async () => {
      const response = await login({ id: 3 });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "email_missing" });
    });

    it("利用者 ID が無いプロフィールは受け付けない", async () => {
      const response = await login({ email: "nobody@example.com" });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "profile_invalid" });
    });

    it("認可コードは 1 回しか使えない", async () => {
      const { url, binding } = await start();
      const code = idp.issue({ id: 1, email: "alice@example.com" });
      const body = { code, state: url.searchParams.get("state"), binding };
      expect((await json("POST", "/v1/auth/sso/callback", body)).status).toBe(
        200,
      );
      const again = await json("POST", "/v1/auth/sso/callback", body);
      expect(again.status).toBe(502);
      expect(again.headers.get("set-auth-token")).toBeNull();
    });

    it("自動発行をオフにすると作らない", async () => {
      await updateProvider({ allowSignUp: false });
      const response = await login({ id: 4, email: "dave@example.com" });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "sign_up_disabled" });
      await updateProvider({});
    });
  });

  describe("既存の利用者", () => {
    let carolToken: string;
    let secret: string;

    beforeAll(async () => {
      await signUp.api.signUpEmail({
        body: { email: "carol@example.com", name: "Carol", password: PASSWORD },
      });
      const signIn = await json("POST", "/v1/auth/sign-in/email", {
        email: "carol@example.com",
        password: PASSWORD,
      });
      carolToken = signIn.headers.get("set-auth-token") as string;
      expect(carolToken).toBeTruthy();
    });

    it("メールアドレスを信頼しない IdP では、自動で結び付けない", async () => {
      const response = await login({ id: 10, email: "carol@example.com" });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "link_required" });
    });

    it("信頼する IdP でも、確かめていないメールアドレスどうしは結び付けない", async () => {
      await updateProvider({ trustEmail: true });
      // Orbit 側で確かめていない利用者 (メールアドレスを決めない招待で登録した人など)。
      const unverified = await login({ id: 10, email: "carol@example.com" });
      expect(unverified.status).toBe(403);
      expect(await unverified.json()).toEqual({ error: "link_required" });

      await db.execute(
        sql`update users set email_verified = true where email = 'carol@example.com'`,
      );
      // IdP が確かめていないと返したメールアドレス。
      const notVerified = await login({
        id: 10,
        email: "carol@example.com",
        email_verified: false,
      });
      expect(notVerified.status).toBe(403);
      expect(await notVerified.json()).toEqual({ error: "link_required" });
    });

    it("信頼する IdP なら結び付けてログインし、利用者は増えない", async () => {
      await updateProvider({ trustEmail: true });
      const before = await db.execute(
        sql`select count(*)::int as n from users`,
      );
      const response = await login({ id: 10, email: "carol@example.com" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        created: false,
        suggestMailAccount: false,
      });
      const after = await db.execute(sql`select count(*)::int as n from users`);
      expect((after.rows[0] as { n: number }).n).toBe(
        (before.rows[0] as { n: number }).n,
      );
    });

    it("2 段階認証を有効にした人は、コードの入力を求められる", async () => {
      const enable = await json(
        "POST",
        "/v1/auth/two-factor/enable",
        { password: PASSWORD },
        bearer(carolToken),
      );
      expect(enable.status).toBe(200);
      const { totpURI } = (await enable.json()) as { totpURI: string };
      secret = new URL(totpURI).searchParams.get("secret") as string;
      const verify = await json(
        "POST",
        "/v1/auth/two-factor/verify-totp",
        { code: totp(secret) },
        {
          ...bearer(carolToken),
          ...(enable.headers.get("x-auth-state")
            ? { "x-auth-state": authStateRequestHeader(enable) }
            : {}),
        },
      );
      expect(verify.status).toBe(200);

      const response = await login({ id: 10, email: "carol@example.com" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
      // まだログインにはならない。
      expect(response.headers.get("set-auth-token")).toBeNull();

      const second = await json(
        "POST",
        "/v1/auth/two-factor/verify-totp",
        { code: totp(secret), trustDevice: true },
        { "x-auth-state": authStateRequestHeader(response) },
      );
      expect(second.status).toBe(200);
      const token = second.headers.get("set-auth-token") as string;
      expect(token).toBeTruthy();
      const me = await json("GET", "/v1/me", undefined, bearer(token));
      expect(await me.json()).toMatchObject({
        user: { email: "carol@example.com" },
      });

      // 「この端末では省略する」の印があれば、次からは尋ねない。
      const trusted = await login(
        { id: 10, email: "carol@example.com" },
        { "x-auth-state": authStateRequestHeader(second) },
      );
      expect(await trusted.json()).toMatchObject({ twoFactorRedirect: false });
      expect(trusted.headers.get("set-auth-token")).toBeTruthy();
    });

    it("IdP の設定で 2 段階認証を省ける", async () => {
      await updateProvider({ trustEmail: true, skipTwoFactor: true });
      const response = await login({ id: 10, email: "carol@example.com" });
      expect(await response.json()).toMatchObject({ twoFactorRedirect: false });
      expect(response.headers.get("set-auth-token")).toBeTruthy();
    });
  });

  describe("無効化と削除", () => {
    it("一覧に結び付いた人数が出る", async () => {
      const list = (await (await asAdmin("GET", "/v1/admin/sso")).json()) as {
        providers: { id: string; linkedUsers: number }[];
      };
      expect(list.providers[0]?.linkedUsers).toBe(2);
    });

    it("ID の項目名を変えると、結び付けを解く", async () => {
      const response = await asAdmin(
        "PUT",
        `/v1/admin/sso/${providerId}`,
        providerBody({ clientSecret: "", subjectClaim: "email" }),
      );
      expect(await response.json()).toMatchObject({
        unlinked: true,
        provider: { linkedUsers: 0 },
      });
      // 名前だけの変更では解かない。
      await login({ id: 77, email: "dave@example.com" });
      const rename = await asAdmin(
        "PUT",
        `/v1/admin/sso/${providerId}`,
        providerBody({
          clientSecret: "",
          subjectClaim: "email",
          name: "改名",
        }),
      );
      expect(await rename.json()).toMatchObject({
        unlinked: false,
        provider: { linkedUsers: 1 },
      });
    });

    it("無効にすると、ログイン画面に出ず、始められない", async () => {
      await updateProvider({ enabled: false });
      const features = (await (
        await json("GET", "/v1/auth-features")
      ).json()) as { sso: unknown[] };
      expect(features.sso).toEqual([]);
      const response = await json("POST", "/v1/auth/sso/start", {
        providerId,
        binding: randomBytes(32).toString("base64url"),
      });
      expect(response.status).toBe(404);
    });

    it("削除すると、結び付きも消える", async () => {
      const response = await asAdmin("DELETE", `/v1/admin/sso/${providerId}`);
      expect(response.status).toBe(204);
      const links = await db.execute(
        sql`select count(*)::int as n from auth_accounts where provider_id like 'sso:%'`,
      );
      expect((links.rows[0] as { n: number }).n).toBe(0);
    });
  });
});
