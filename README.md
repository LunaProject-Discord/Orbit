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
| `packages/core` | サーバー側で共有する処理 (認証情報の暗号化、プロセス間通知の定義) |

## 必要なもの

- Node.js 22 以上
- pnpm 10
- Docker (ローカルの PostgreSQL 19 用)。主キーの UUID v7 に `uuidv7()` を使うため、PostgreSQL 18 以降が必要です

## セットアップ

```sh
pnpm install
pnpm env:init          # .env を作成し、秘密の値 (BETTER_AUTH_SECRET など) を自動生成
docker compose up -d   # PostgreSQL を起動
pnpm db:migrate        # テーブルを作成
pnpm user:create you@example.com "あなたの名前"   # ログイン用の利用者を作成 (パスワードを聞かれます)
pnpm dev               # api / worker / web を起動
```

どのコマンドも Windows (PowerShell)、macOS、Linux で同じように動きます。事前のビルドは不要です
(開発時は `packages/*` の TypeScript を直接読み込みます。`pnpm build` は本番用の出力と型チェックのためのものです)。

Node.js 25 以降には Corepack が同梱されていないため、pnpm は `npm install -g pnpm@10` などで入れてください。

- Web: http://localhost:3000
- API: http://localhost:8787 (`/healthz` で DB 接続を確認できます)

## ログインとメールアカウント

- アプリへのログインは [Better Auth](https://www.better-auth.com/) のメールアドレス + パスワードです。
  新規登録は API では受け付けておらず (招待制)、利用者は `pnpm user:create` で作成します。
- クライアントはログインで得たセッショントークンを `Authorization: Bearer` で送ります
  (Web / Tauri / Capacitor で同じ方式を使うため、Cookie には依存しません)。
- 1 人の利用者が複数のメールアカウントを追加できます。現在追加できるのは、パスワード
  (アプリ用パスワードを含む) で IMAP にログインするアカウントです。OAuth2 (Gmail / Microsoft) は今後対応します。
- メールアカウントのパスワードは AES-256-GCM で暗号化して保存します。鍵は `CREDENTIALS_ENCRYPTION_KEY` で、
  DB には入りません。鍵を失うと復号できなくなるため、安全な場所に控えてください。
- ローカルの IMAP サーバー (localhost や内部 IP) で試す場合は、`.env` で `ALLOW_PRIVATE_MAIL_HOSTS=true` にします。

## 同期の仕組み

1. API がアカウントを保存すると、PostgreSQL の `NOTIFY` で同期ワーカーに伝わります。
2. ワーカーはアカウントごとに IMAP へ常時接続し、受信トレイを DB に取り込みます
   (先に一覧、続いて本文を新しい順に取得)。以降は IMAP IDLE で新着・既読・削除の通知を受けて差分を反映します。
3. ワーカーは変更を `changes` テーブルに記録して `NOTIFY` し、API が SSE (`GET /v1/events`) で各端末に知らせます。
   端末は `GET /v1/sync?since=<変更番号>` や一覧 API で取り直します。

現時点で同期するのは受信トレイのみで、読み取り専用です (既読の変更や送信は今後追加します)。

## API (v1)

| メソッドとパス | 内容 |
| --- | --- |
| `POST /v1/auth/sign-in/email` | ログイン。レスポンスヘッダー `set-auth-token` がセッショントークン |
| `POST /v1/auth/sign-out` | ログアウト |
| `GET /v1/me` | ログイン中の利用者 |
| `GET /v1/accounts` / `POST /v1/accounts` | メールアカウントの一覧 / 追加 (IMAP へのログインを確認してから保存) |
| `DELETE /v1/accounts/:id` | メールアカウントと取り込んだメールの削除 |
| `GET /v1/accounts/:id/mailboxes` | フォルダ一覧 |
| `GET /v1/messages` | メッセージ一覧 (`accountId` 省略で全アカウントの受信トレイ、`cursor` でページ送り) |
| `GET /v1/messages/:id` | メッセージの本文と添付ファイルの情報 |
| `GET /v1/sync?since=` | 変更番号より後の変更履歴 |
| `GET /v1/events` | 変更の通知 (SSE) |

## よく使うコマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm env:init` | `.env` を作成し、未設定の秘密の値を生成 (設定済みの値は変更しない) |
| `pnpm dev` | 全アプリを開発モードで起動 |
| `pnpm build` | 全パッケージをビルド |
| `pnpm typecheck` | 型チェック |
| `pnpm test` | 単体テスト (Vitest) |
| `pnpm lint` / `pnpm format` | Biome による検査 / 整形 |
| `pnpm db:generate` | スキーマの変更からマイグレーションを生成 |
| `pnpm db:migrate` | マイグレーションを適用 |
| `pnpm user:create <メール> <表示名>` | ログイン用の利用者を作成 |

## UI

`apps/web` は shadcn/ui (プリセット `bIkeymG`) を使っています。コンポーネントは `apps/web` で次のように追加します。

```sh
pnpm dlx shadcn@latest add <コンポーネント名>
```

フォントは Gen Interface JP (見出しは Gen Interface JP Display) を `apps/web/src/app/globals.css` で設定しています。
shadcn/ui の CLI がフォント設定を書き換えた場合は、`--font-sans` と `--font-heading` を元に戻してください。
