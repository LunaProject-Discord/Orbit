# Mail

サーバーが IMAP / SMTP や Microsoft Graph でメールを扱い、各クライアントは REST API と SSE でサーバー経由で送受信するメールアプリです。
複数の端末で既読や新着がリアルタイムに一致することを目的にしています。

## 構成

| パス | 内容 |
| --- | --- |
| `apps/api` | API サーバー (Hono)。REST API、SSE、認証 |
| `apps/worker` | 同期ワーカー。IMAP の常時接続、Microsoft Graph の差分取得、送信キューの処理 |
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

## 本番への配置 (Oracle Cloud)

Docker Compose で一式 (Web、API、同期ワーカー、PostgreSQL、HTTPS を受ける Caddy、バックアップ) を動かします。
サーバーの用意から、独自ドメインと HTTPS、更新、バックアップ、環境変数の一覧までを
[docs/deploy-oracle-cloud.md](docs/deploy-oracle-cloud.md) にまとめています。

```sh
bash deploy/setup.sh mail.example.com   # deploy/.env を作り、秘密の値を生成
cd deploy && docker compose up -d --build
```

## ログインとメールアカウント

- アプリへのログインは [Better Auth](https://www.better-auth.com/) のメールアドレス + パスワードです。
  新規登録は API では受け付けておらず (招待制)、利用者は `pnpm user:create` で作成します。
- クライアントはログインで得たセッショントークンを `Authorization: Bearer` で送ります
  (Web / Tauri / Capacitor で同じ方式を使うため、Cookie には依存しません)。
- 1 人の利用者が複数のメールアカウントを追加できます。現在追加できるのは次の 2 種類です。
  - パスワード (アプリ用パスワードを含む) で IMAP にログインするアカウント
  - Microsoft アカウント (Microsoft 365 の Exchange Online、Outlook.com)。Microsoft のログイン画面で認証し、
    Microsoft Graph で同期します。設定は下の「Microsoft アカウント」を参照してください。

  Gmail の OAuth2 は今後対応します。
- メールアカウントのパスワードやリフレッシュトークンは AES-256-GCM で暗号化して保存します。鍵は `CREDENTIALS_ENCRYPTION_KEY` で、
  DB には入りません。鍵を失うと復号できなくなるため、安全な場所に控えてください。
- ローカルの IMAP サーバー (localhost や内部 IP) で試す場合は、`.env` で `ALLOW_PRIVATE_MAIL_HOSTS=true` にします。

## Microsoft アカウント (Exchange Online / Outlook.com)

Microsoft Graph を使うには、[Microsoft Entra 管理センター](https://entra.microsoft.com/) でアプリを登録します。

1. 「アプリの登録」→「新規登録」を開き、名前を付けます。「サポートされているアカウントの種類」は、
   組織と個人の両方を使うなら「任意の組織ディレクトリ内のアカウントと個人用 Microsoft アカウント」を選びます。
2. リダイレクト URI は種類を「Web」にして、Web の URL に `/oauth/microsoft` を付けたものを登録します
   (ローカルなら `http://localhost:3000/oauth/microsoft`)。`MICROSOFT_REDIRECT_URI` と完全に一致させてください。
3. 「証明書とシークレット」でクライアント シークレットを作り、値を控えます (有効期限が切れたら作り直しが必要です)。
4. 「API のアクセス許可」で Microsoft Graph の委任されたアクセス許可 `offline_access`、`User.Read`、
   `Mail.ReadWrite`、`Mail.Send` を追加します。
5. `.env` の `MICROSOFT_CLIENT_ID` (アプリケーション ID) と `MICROSOFT_CLIENT_SECRET` を設定し、api と worker を再起動します。
   「サポートされているアカウントの種類」で組織のみ / 個人のみを選んだ場合は、`MICROSOFT_TENANT` も合わせます。

設定すると、アカウントの追加画面の「Microsoft アカウントでログイン」から追加できます。
組織のアカウントでは、テナントの設定によって管理者の同意が必要な場合があります。

- 同期は [差分取得 (delta query)](https://learn.microsoft.com/graph/delta-query-messages) で行います。確認の間隔は状況に応じて変わります
  (下の「更新の速さ」を参照)。
- `API_PUBLIC_URL` が公開された HTTPS の URL (localhost や IP アドレスではないもの) なら、
  [変更通知 (Webhook)](https://learn.microsoft.com/graph/change-notifications-delivery-webhooks) を自動で購読し、
  通知が届いたらすぐに差分を確認します。Microsoft Graph から `POST {API_PUBLIC_URL}/v1/webhooks/microsoft` に
  届く必要があります。購読は 6 日の期限で作り、期限の 2 日前に自動で延長します。購読に失敗した場合は
  ワーカーのログに理由を出し、定期的な確認だけで同期を続けます (1 時間後に試し直します)。
- メッセージは [不変 ID](https://learn.microsoft.com/graph/outlook-immutable-id) で識別します。
- フォルダはサブフォルダも含めて取り込みます。
- 現時点では添付ファイルの一覧と返信済みの印は取り込みません。
- リフレッシュトークンが失効した場合 (長期間の未使用、パスワード変更、同意の取り消しなど) は、
  サイドバーに「再ログインが必要です」と表示されます。「Microsoft にログインし直す」から復旧できます。

## 同期の仕組み

1. API がアカウントを保存すると、PostgreSQL の `NOTIFY` で同期ワーカーに伝わります。
2. ワーカーはアカウントごとに IMAP へ常時接続し (Microsoft アカウントでは Microsoft Graph を定期的に確認し)、全フォルダを DB に取り込みます
   (先に一覧、続いて本文を取得)。以降、受信トレイは IMAP IDLE で新着・既読・削除の通知を受けて差分を反映します。
   IDLE で通知を受けられるのは 1 つのフォルダだけなので、他のフォルダは 2 分ごとに件数や変更番号 (STATUS) を確認し、
   変化のあったフォルダだけを開いて突き合わせます。
3. ワーカーは変更を `changes` テーブルに記録して `NOTIFY` し、API が SSE (`GET /v1/events`) で各端末に知らせます。
   端末は `GET /v1/sync?since=<変更番号>` や一覧 API で取り直します。

フォルダはサブフォルダも含めて同期し、サイドバーにアカウントごとのツリーで表示します。送信済み、下書き、ごみ箱、
迷惑メール、アーカイブなどの役割は、IMAP では SPECIAL-USE (無ければフォルダ名)、Microsoft Graph では既定フォルダ名
(`sentitems` など) で判定します。メールを開くと既読になり、既読 / 未読の切り替え、スター、
アーカイブ、削除 (ごみ箱へ移動)、フォルダへの移動ができます。操作はまず画面と DB に反映し、
送信待ちキュー (outbox) から同期ワーカーがメールサーバーへ反映します。

### メールの送信

新規作成、返信、全員に返信、転送ができます。本文には太字・斜体・下線・箇条書き・リンクを使え、
テキスト版と HTML 版の両方を入れて送ります。ファイルを添付できます。

作成画面は、広い画面では右下に開く窓で、開いたままほかのメールを読めます。書きかけの内容は
ブラウザーの中 (その端末) に自動で保存し、再読み込みしても続きから書けます。

添付ファイルは、作成画面で選んだ時点で `POST /v1/attachments` がサーバーの `ATTACHMENTS_DIR`
(既定はリポジトリ直下の `data/attachments`) に置き、送信のときにワーカーが読みます。API サーバーとワーカーの
両方から同じディレクトリが見える必要があります。置いてから 7 日たったファイルは、ワーカーが消します。
上限は 1 通あたり合計 25 MB、20 件です。Microsoft のアカウントでは、Microsoft Graph の制限に収まるよう合計 3 MB までにしています。

1. `POST /v1/messages/send` が送信待ちキューに積み、すぐに応答します。
2. 同期ワーカーが、IMAP のアカウントは SMTP で、Microsoft のアカウントは Microsoft Graph (`sendMail`) で送ります。
3. 送信済みフォルダへの控えは、Gmail / Microsoft はサーバーが自動で保存します。それ以外の IMAP アカウントでは、
   ワーカーが送信済みフォルダへ保存します (同じ Message-ID のメールがすでにあれば保存しません)。
4. 返信した元のメールには、返信済みの印を付けます (Microsoft Graph では、このアプリの中だけの表示です)。

一時的な失敗 (接続できない、4xx の応答) は間隔を空けて 5 回までやり直します。拒否された場合と、
本文の送信中に接続が切れて届いたかどうか分からない場合は、二重に送らないようやり直さず、
画面の一覧の上に理由を表示します (編集して送り直すか、破棄できます)。

SMTP は、`smtpSecure` が有効なら最初から TLS、無効なら STARTTLS を必須にして接続します。
`ALLOW_PRIVATE_MAIL_HOSTS=true` (開発用) のときだけ、TLS の無い SMTP サーバーにも接続します。

### 更新の速さ

同期ワーカーは、状況に応じて確認の方法と間隔を切り替えます。画面を開いている端末は、表示中のフォルダを
30 秒ごとに `POST /v1/focus` で知らせます (知らせが 75 秒途絶えると、開いていない扱いに戻ります)。

| 対象 | IMAP | Microsoft Graph |
| --- | --- | --- |
| 受信トレイ | IDLE で即時 | 画面を開いている間は 5 秒ごと、それ以外は 15 秒ごと |
| 画面で開いているフォルダ | もう 1 本接続を張って IDLE で即時。張れないとき (同時接続数の上限など) は 10 秒ごとに STATUS で確認 | 受信トレイと同じ間隔 |
| 他のフォルダ | 2 分ごとに STATUS で確認 | 2 分ごと |
| 移動などの操作の直後 | すぐに全フォルダを確認 | すぐに全フォルダを確認 |

Microsoft Graph では、さらに次のように調整します。

- 変更通知 (Webhook) が実際に届いている間は、通知を受けてすぐに確認し、定期的な確認は取りこぼしに備えた間隔
  (画面を開いている間は 1 分、それ以外は 5 分) に落とします。定期的な確認のほうが先に変化を見つけた場合は、
  通知が届いていないとみなして元の間隔に戻します。
- 制限 (429) を受けたら `Retry-After` に従って待ち、確認の間隔を倍に延ばします (最大 8 倍)。
  5 分間制限を受けなければ半分に戻します。Outlook の制限は 1 つのメールボックスにつき 10 分で 10,000 回、
  同時 4 件です ([Microsoft Graph の制限](https://learn.microsoft.com/graph/throttling-limits#outlook-service-limits))。

## API (v1)

| メソッドとパス | 内容 |
| --- | --- |
| `POST /v1/auth/sign-in/email` | ログイン。レスポンスヘッダー `set-auth-token` がセッショントークン |
| `POST /v1/auth/sign-out` | ログアウト |
| `GET /v1/me` | ログイン中の利用者 |
| `GET /v1/accounts` / `POST /v1/accounts` | メールアカウントの一覧 / 追加 (IMAP へのログインを確認してから保存) |
| `POST /v1/accounts/microsoft/authorize` | Microsoft のログイン画面の URL を取得 (`accountId` を渡すと再ログイン) |
| `POST /v1/accounts/microsoft/complete` | ログイン後に戻ってきた `code` と `state` を渡して、Microsoft アカウントを追加 |
| `DELETE /v1/accounts/:id` | メールアカウントと取り込んだメールの削除 |
| `GET /v1/accounts/:id/mailboxes` | アカウント 1 件分のフォルダ一覧 |
| `GET /v1/mailboxes` | 全アカウントのフォルダ一覧 (親フォルダの `parentId`、未読数、件数付き) |
| `GET /v1/messages` | メッセージ一覧 (`mailboxId` でフォルダを指定。省略すると受信トレイで、`accountId` も省略すると全アカウント分。`cursor` でページ送り) |
| `GET /v1/messages/:id` | メッセージの本文と添付ファイルの情報 |
| `POST /v1/focus` | 画面で表示中のフォルダを知らせる (`accountId`、`mailboxId`。その間は短い間隔で同期する) |
| `POST /v1/webhooks/microsoft` | Microsoft Graph の変更通知の受け口 (ログイン不要。購読時の合言葉で確かめる) |
| `POST /v1/attachments` / `DELETE /v1/attachments/:id` | 送信するメールに付けるファイルの受け取り (本文がファイルの内容、名前は `X-Filename`) / 取り消し |
| `POST /v1/messages/send` | メールの送信 (新規、返信、転送)。受け付けると 202 を返し、実際の送信は同期ワーカーが行う |
| `GET /v1/messages/outgoing` | まだ送り終えていないメール (送信待ち、送信中、失敗) の一覧 |
| `DELETE /v1/messages/outgoing/:id` | 送信待ちのメールの取り消し、または失敗したメールの破棄 |
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
| `pnpm --filter @mail/db migrate:deploy` | ビルド済みの出力でマイグレーションを適用 (本番用。drizzle-kit が不要) |
| `pnpm user:create <メール> <表示名>` | ログイン用の利用者を作成 |

## UI

`apps/web` は shadcn/ui (プリセット `bIkeymG`) を使っています。コンポーネントは `apps/web` で次のように追加します。

```sh
pnpm dlx shadcn@latest add <コンポーネント名>
```

フォントは Gen Interface JP (見出しは Gen Interface JP Display) を `apps/web/src/app/globals.css` で設定しています。
shadcn/ui の CLI がフォント設定を書き換えた場合は、`--font-sans` と `--font-heading` を元に戻してください。
