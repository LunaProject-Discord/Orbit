# Mail

サーバーが IMAP / SMTP でメールを扱い、各クライアントは REST API と SSE でサーバー経由で送受信するメールアプリです。
複数の端末で既読や新着がリアルタイムに一致することを目的にしています。

## 構成

| パス | 内容 |
| --- | --- |
| `apps/api` | API サーバー (Hono)。REST API、SSE、認証 |
| `apps/worker` | 同期ワーカー。IMAP の常時接続と送信キューの処理 |
| `apps/web` | Next.js の UI。静的エクスポートし、Web / Tauri / Capacitor で共用する |
| `packages/db` | PostgreSQL のスキーマとマイグレーション (Drizzle ORM) |

## 必要なもの

- Node.js 22 以上
- pnpm 10
- Docker (ローカルの PostgreSQL 用)

## セットアップ

```sh
cp .env.example .env
pnpm install
docker compose up -d   # PostgreSQL を起動
pnpm db:migrate        # テーブルを作成
pnpm dev               # api / worker / web を起動
```

- Web: http://localhost:3000
- API: http://localhost:8787 (`/healthz` で DB 接続を確認できます)

## よく使うコマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | 全アプリを開発モードで起動 |
| `pnpm build` | 全パッケージをビルド |
| `pnpm typecheck` | 型チェック |
| `pnpm lint` / `pnpm format` | Biome による検査 / 整形 |
| `pnpm db:generate` | スキーマの変更からマイグレーションを生成 |
| `pnpm db:migrate` | マイグレーションを適用 |

## shadcn/ui の初期化 (未実施)

`apps/web` で次を実行すると、指定のプリセットで shadcn/ui が設定されます。

```sh
cd apps/web
pnpm dlx shadcn@latest init --preset bIkeymG
```

フォントは Gen Interface JP (見出しは Gen Interface JP Display) を `apps/web/src/app/globals.css` で設定しています。
shadcn/ui の初期化でフォント設定が上書きされた場合は、`--font-sans` と `--font-heading` を元に戻してください。
