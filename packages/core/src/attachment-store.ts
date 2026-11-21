import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * 送信するメールの添付ファイルの置き場。
 * 作成画面で選んだファイルを API サーバーが受け取ってディスクに置き、
 * 同期ワーカーが送信するときに読む。両方から同じディレクトリが見える必要がある。
 */

/** 1 通あたりの添付ファイルの合計の上限。 */
export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;
/**
 * Microsoft Graph で送る場合の上限。MIME 形式での送信は要求全体の大きさに制限があるため、
 * base64 にしても収まる大きさに抑える。
 */
export const MAX_GRAPH_ATTACHMENTS_BYTES = 3 * 1024 * 1024;
/** 1 通あたりの添付ファイルの数の上限。 */
export const MAX_ATTACHMENT_COUNT = 20;

export type StoredAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
};

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * 置き場のディレクトリ。ATTACHMENTS_DIR が無ければ、リポジトリ直下の data/attachments
 * (API もワーカーも apps/* を作業ディレクトリにして起動するので、同じ場所を指す)。
 */
export function attachmentsDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolve(env.ATTACHMENTS_DIR?.trim() || "../../data/attachments");
}

/** 利用者ごとのディレクトリの下に置く。ID は UUID しか受け付けない (パスの差し込み対策)。 */
export function attachmentKey(userId: string, id: string): string {
  if (!UUID.test(userId) || !UUID.test(id)) {
    throw new Error("添付ファイルの ID が不正です。");
  }
  return `${userId}/${id}`;
}

/** storageKey (attachmentKey の戻り値) から、実体のパスを返す。 */
export function attachmentPath(dir: string, storageKey: string): string {
  const [userId = "", id = ""] = storageKey.split("/");
  return join(dir, attachmentKey(userId, id));
}

/** ファイル名から、パスの区切りや制御文字を取り除く。 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .normalize("NFC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を取り除くための正規表現
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 200);
  return cleaned || "attachment";
}

const CONTENT_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export function sanitizeContentType(value: string | undefined | null): string {
  const type = (value ?? "").split(";")[0]?.trim() ?? "";
  return CONTENT_TYPE.test(type) && type.length <= 127
    ? type.toLowerCase()
    : "application/octet-stream";
}

/**
 * 受け取った内容をディスクに書く。maxBytes を超えたら途中でやめて "too_large" を返す。
 */
export async function writeAttachment(
  dir: string,
  userId: string,
  meta: { filename: string; contentType: string },
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<StoredAttachment | "too_large"> {
  const id = randomUUID();
  const path = join(dir, attachmentKey(userId, id));
  await mkdir(join(dir, userId), { recursive: true });
  const file = createWriteStream(path, { flags: "wx", mode: 0o600 });
  let size = 0;
  let tooLarge = false;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        tooLarge = true;
        await reader.cancel().catch(() => {});
        break;
      }
      if (!file.write(value)) {
        await new Promise<void>((ok) => file.once("drain", ok));
      }
    }
  } catch (error) {
    file.destroy();
    await rm(path, { force: true });
    throw error;
  }
  await new Promise<void>((ok, fail) => {
    file.once("error", fail);
    file.end(ok);
  });
  if (tooLarge) {
    await rm(path, { force: true });
    return "too_large";
  }
  const stored: StoredAttachment = {
    id,
    filename: sanitizeFilename(meta.filename),
    contentType: sanitizeContentType(meta.contentType),
    size,
  };
  await writeFile(`${path}.json`, JSON.stringify(stored), { mode: 0o600 });
  return stored;
}

/** 添付ファイルの情報。無ければ (他人のものも含めて) null。 */
export async function readAttachmentMeta(
  dir: string,
  userId: string,
  id: string,
): Promise<StoredAttachment | null> {
  try {
    const path = join(dir, attachmentKey(userId, id));
    const meta = JSON.parse(
      await readFile(`${path}.json`, "utf8"),
    ) as StoredAttachment;
    const { size } = await stat(path);
    return { ...meta, id, size };
  } catch {
    return null;
  }
}

export async function deleteAttachment(
  dir: string,
  userId: string,
  id: string,
): Promise<void> {
  const path = join(dir, attachmentKey(userId, id));
  await rm(path, { force: true });
  await rm(`${path}.json`, { force: true });
}

/** storageKey の実体があるか。 */
export async function attachmentExists(
  dir: string,
  storageKey: string,
): Promise<boolean> {
  try {
    return (await stat(attachmentPath(dir, storageKey))).isFile();
  } catch {
    return false;
  }
}

/**
 * 古い添付ファイルを消す。送信し終えたものも、作成画面で選んだまま送らなかったものも、
 * 置いてから maxAgeMs が過ぎたらここで消える。戻り値は消したファイルの数。
 * keep は残しておく storageKey (下書きに付いているファイルなど)。
 */
export async function sweepAttachments(
  dir: string,
  maxAgeMs: number,
  now = Date.now(),
  keep: ReadonlySet<string> = new Set(),
): Promise<number> {
  let removed = 0;
  const users = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const user of users) {
    if (!user.isDirectory() || !UUID.test(user.name)) continue;
    const userDir = join(dir, user.name);
    for (const name of await readdir(userDir).catch(() => [])) {
      if (keep.has(`${user.name}/${name.replace(/\.json$/, "")}`)) continue;
      const path = join(userDir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && now - info.mtimeMs > maxAgeMs) {
        await rm(path, { force: true });
        if (!name.endsWith(".json")) removed++;
      }
    }
  }
  return removed;
}
