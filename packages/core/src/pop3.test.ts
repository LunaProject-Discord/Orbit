import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Pop3Client, Pop3Error, unstuff } from "./pop3.js";

type Mail = { uidl: string; raw: string };

/** テスト用の POP3 サーバー (暗号化なし)。受けたコマンドを記録する。 */
function fakeServer(mails: Mail[], options: { password?: string } = {}) {
  const commands: string[] = [];
  const deleted = new Set<number>();
  const committed: number[] = [];
  const server = net.createServer((socket) => {
    let authed = false;
    let buffer = "";
    const pending = new Set<number>();
    socket.write("+OK fake ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      let end = buffer.indexOf("\r\n");
      while (end !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\r\n");
        commands.push(line.startsWith("PASS") ? "PASS ***" : line);
        const [verb = "", arg] = line.split(" ");
        const n = Number(arg);
        switch (verb.toUpperCase()) {
          case "CAPA":
            socket.write("+OK\r\nUSER\r\nUIDL\r\n.\r\n");
            break;
          case "USER":
            socket.write("+OK\r\n");
            break;
          case "PASS":
            if (arg === (options.password ?? "secret")) {
              authed = true;
              socket.write("+OK logged in\r\n");
            } else {
              socket.write("-ERR [AUTH] invalid password\r\n");
            }
            break;
          case "UIDL":
            if (!authed) return void socket.write("-ERR not authed\r\n");
            socket.write(
              `+OK\r\n${mails
                .map((mail, i) => `${i + 1} ${mail.uidl}\r\n`)
                .join("")}.\r\n`,
            );
            break;
          case "LIST":
            socket.write(
              `+OK\r\n${mails
                .map((mail, i) => `${i + 1} ${Buffer.byteLength(mail.raw)}\r\n`)
                .join("")}.\r\n`,
            );
            break;
          case "RETR": {
            const mail = mails[n - 1];
            if (!mail) return void socket.write("-ERR no such message\r\n");
            const stuffed = mail.raw.replace(/^\./gm, "..");
            // 応答を細かく分けて送り、受け取り側のつなぎ合わせを確かめる。
            const data = `+OK ${mail.raw.length} octets\r\n${stuffed}\r\n.\r\n`;
            for (let i = 0; i < data.length; i += 7) {
              socket.write(data.slice(i, i + 7));
            }
            break;
          }
          case "DELE":
            pending.add(n);
            socket.write("+OK\r\n");
            break;
          case "QUIT":
            for (const item of pending) {
              deleted.add(item);
              committed.push(item);
            }
            socket.end("+OK bye\r\n");
            break;
          default:
            socket.write("-ERR unknown\r\n");
        }
      }
    });
  });
  return {
    commands,
    deleted,
    committed,
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () =>
          resolve((server.address() as net.AddressInfo).port),
        );
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function start(mails: Mail[], options?: { password?: string }) {
  const server = fakeServer(mails, options);
  const port = await server.listen();
  cleanup = server.close;
  return { server, port };
}

const settings = (port: number, password = "secret") => ({
  host: "127.0.0.1",
  port,
  secure: false,
  username: "user",
  password,
  allowInsecure: true,
});

describe("unstuff", () => {
  it("行頭の重ねたドットを 1 つ外す", () => {
    expect(
      unstuff(Buffer.from("..a\r\nb\r\n...c\r\nd..e\r\n")).toString(),
    ).toBe(".a\r\nb\r\n..c\r\nd..e\r\n");
  });
});

describe("Pop3Client", () => {
  it("ログインして、UIDL・LIST・RETR・DELE を使える", async () => {
    const mails = [
      { uidl: "a1", raw: "Subject: one\r\n\r\nhello\r\n.dot line" },
      { uidl: "b2", raw: "Subject: two\r\n\r\nworld" },
    ];
    const { server, port } = await start(mails);
    const client = new Pop3Client(settings(port));
    await client.connect();
    expect(await client.uidl()).toEqual(
      new Map([
        [1, "a1"],
        [2, "b2"],
      ]),
    );
    expect((await client.list()).get(2)).toBe(
      Buffer.byteLength(mails[1]?.raw ?? ""),
    );
    expect((await client.retr(1)).toString()).toBe(`${mails[0]?.raw}\r\n`);
    await client.dele(2);
    await client.quit();
    expect(server.committed).toEqual([2]);
    expect(server.commands).toContain("PASS ***");
  });

  it("パスワードの誤りは auth の失敗として返す", async () => {
    const { port } = await start([]);
    const client = new Pop3Client(settings(port, "wrong"));
    const error = await client.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Pop3Error);
    expect((error as Pop3Error).kind).toBe("auth");
    expect((error as Pop3Error).responseText).toContain("invalid password");
  });

  it("STLS の無いサーバーには、許可が無ければパスワードを送らない", async () => {
    const { server, port } = await start([]);
    const client = new Pop3Client({ ...settings(port), allowInsecure: false });
    const error = await client.connect().catch((e: unknown) => e);
    expect((error as Pop3Error).kind).toBe("connection");
    expect(server.commands.some((line) => line.startsWith("PASS"))).toBe(false);
  });

  it("つながらなければ connection の失敗として返す", async () => {
    const { port } = await start([]);
    await cleanup?.();
    cleanup = null;
    const client = new Pop3Client(settings(port));
    const error = await client.connect().catch((e: unknown) => e);
    expect((error as Pop3Error).kind).toBe("connection");
  });

  it("QUIT せずに切れば DELE は取り消される", async () => {
    const { server, port } = await start([{ uidl: "x", raw: "a" }]);
    const client = new Pop3Client(settings(port));
    await client.connect();
    await client.dele(1);
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.committed).toEqual([]);
  });
});
