# Oracle Cloud へ配置する

Oracle Cloud の無料枠 (Ampere A1) のサーバー 1 台に、Docker Compose で一式を動かす手順です。
独自ドメインで HTTPS を受け、Web も API も同じドメインで公開します。

```
ブラウザー / Microsoft Graph
        │  https://mail.example.com (80, 443)
        ▼
┌─ Oracle Cloud のサーバー (Docker Compose) ───────────────┐
│  web (Caddy)   HTTPS、証明書の自動取得、Web の静的ファイル   │
│     └ /v1/*、/healthz ─▶ api (Hono)                      │
│  worker        IMAP / SMTP / Microsoft Graph との同期と送信 │
│  migrate       起動のたびに未適用のマイグレーションを適用    │
│  postgres      PostgreSQL 19                             │
│  backup        毎日 DB を deploy/backups/ に書き出す       │
└──────────────────────────────────────────────────────────┘
```

関係するファイルは次のとおりです。

| ファイル | 内容 |
| --- | --- |
| `Dockerfile` | 本番用のイメージ (`server`: API・ワーカー・マイグレーション、`web`: Caddy + Web) |
| `deploy/compose.yml` | 本番用の構成 |
| `deploy/Caddyfile` | HTTPS と、Web / API への振り分け |
| `deploy/.env.example` | 設定の見本。`deploy/setup.sh` がここから `deploy/.env` を作る |
| `deploy/setup.sh` | `deploy/.env` を作り、秘密の値を生成する |
| `deploy/deploy.sh` | 最新のコードに更新して起動し直す |
| `deploy/backup.sh` / `deploy/restore.sh` | DB のバックアップと復元 |
| `.github/workflows/deploy.yml` | main の CI が通ったらサーバーを更新する |

> この手順のうち、Docker Compose 一式の起動、HTTPS 経由の表示とログイン、添付ファイルの共有、バックアップと復元は
> 手元の環境 (x86_64、ドメインは `localhost`) で確認しています。Oracle Cloud の画面の操作、Arm (Ampere A1) 上での動作、
> Let's Encrypt の証明書の取得、GitHub Actions からの更新は、実際のサーバーでは未確認です。
> Oracle Cloud の画面の項目名や無料枠の内容は変わることがあるので、違っていたら画面の表示を優先してください。

## 1. 用意するもの

- Oracle Cloud のアカウント
- 独自ドメインと、その DNS を設定できる画面
- 手元の PC の SSH 鍵 (無ければ `ssh-keygen -t ed25519` で作れます。Windows の PowerShell でも同じです)

以下では、ドメインを `mail.example.com` として説明します。自分のドメインに読み替えてください。

## 2. サーバーを作る

Oracle Cloud のコンソールで「コンピュート」→「インスタンス」→「インスタンスの作成」を開きます。

| 項目 | 選ぶもの |
| --- | --- |
| イメージ | Canonical Ubuntu 24.04 (Arm 用) |
| シェイプ | Ampere の `VM.Standard.A1.Flex`。2 OCPU・12 GB 以上を推奨 |
| ネットワーク | 新しい仮想クラウド・ネットワーク (VCN) とパブリック・サブネットを作成。パブリック IPv4 アドレスを割り当てる |
| SSH キー | 手元の公開鍵 (`~/.ssh/id_ed25519.pub`) を貼り付ける |
| ブート・ボリューム | 50 GB 以上 |

- 無料枠の A1 は合計 4 OCPU・24 GB まで、ブロック・ストレージは合計 200 GB までのはずですが、
  作成画面の「Always Free 対象」の表示で確認してください。
- 「Out of capacity」と出て作れないことがあります。時間を置くか、可用性ドメインを変えて試してください。
- IP アドレスが変わると DNS の設定をやり直すことになるので、「予約済パブリック IP」にしておくと安心です。

作成できたら、表示されたパブリック IP アドレスへ SSH で入れることを確認します (Ubuntu のイメージの利用者名は `ubuntu`)。

```sh
ssh ubuntu@<サーバーの IP アドレス>
```

## 3. ポートを開ける

外から 80 番と 443 番が届くようにします。2 か所あります。

**Oracle Cloud 側 (セキュリティ・リスト)**: インスタンスの詳細 → サブネット → セキュリティ・リスト → 「イングレス・ルールの追加」で、
ソース `0.0.0.0/0` に対して次の 3 つを追加します。

| プロトコル | 宛先ポート | 用途 |
| --- | --- | --- |
| TCP | 80 | 証明書の取得、HTTPS への転送 |
| TCP | 443 | HTTPS |
| UDP | 443 | HTTP/3 (無くても動きます) |

**サーバー側 (iptables)**: Oracle Cloud の Ubuntu イメージは、最初から SSH 以外を拒否する設定になっています。

```sh
sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 4. DNS を設定する

ドメインの DNS に、サーバーの IP アドレスを指す A レコードを追加します。

| 種類 | 名前 | 値 |
| --- | --- | --- |
| A | `mail` (`mail.example.com` の場合) | サーバーのパブリック IP アドレス |

Cloudflare を使っている場合は、プロキシ (オレンジ色の雲) を切って「DNS のみ」にしてください。
反映されたかは、手元の PC で `nslookup mail.example.com` を実行して確認できます。

## 5. Docker を入れる

サーバーに SSH で入って実行します。

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
```

グループの変更を反映するため、いったん `exit` で抜けて SSH で入り直します。`docker compose version` が表示されれば準備完了です。

## 6. コードを置いて起動する

```sh
sudo mkdir -p /opt/mail && sudo chown ubuntu:ubuntu /opt/mail
git clone https://github.com/LunaProject-Discord/Mail.git /opt/mail
cd /opt/mail
bash deploy/setup.sh mail.example.com
```

リポジトリが非公開の場合は、そのままでは clone できません。サーバーで `ssh-keygen -t ed25519 -f ~/.ssh/github_mail -N ""` を実行し、
できた `~/.ssh/github_mail.pub` を GitHub のリポジトリの「Settings」→「Deploy keys」に登録 (書き込み権限は不要) したうえで、次のように clone します。

```sh
git clone -c core.sshCommand="ssh -i ~/.ssh/github_mail" git@github.com:LunaProject-Discord/Mail.git /opt/mail
```

`deploy/setup.sh` は `deploy/.env` を作り、DB のパスワード、ログイン用の秘密の値、認証情報を暗号化する鍵を自動で生成します。

**`CREDENTIALS_ENCRYPTION_KEY` は必ずサーバーの外にも控えてください** (`grep CREDENTIALS deploy/.env` で表示できます)。
この鍵を失うと、DB をバックアップから戻しても、メールアカウントのパスワードやトークンを復号できません。

Microsoft アカウントを使う場合は、ここで `deploy/.env` の `MICROSOFT_CLIENT_ID` と `MICROSOFT_CLIENT_SECRET` を書き込みます (`nano deploy/.env`)。
そのうえで起動します。初回はイメージのビルドに数分かかります。

```sh
cd /opt/mail/deploy
docker compose up -d --build
docker compose ps
```

`api` が `healthy`、`migrate` が `Exited (0)`、ほかが `Up` になっていれば起動できています。
証明書は最初のアクセスまでに Caddy が自動で取得します。

続けて、ログイン用の利用者を作ります (パスワードは 12 文字以上で、入力を求められます)。

```sh
docker compose run --rm api node apps/api/dist/cli/create-user.js you@example.com "あなたの名前"
```

ブラウザーで `https://mail.example.com` を開き、ログインできれば完了です。

## 7. Microsoft アカウント (Exchange) の設定を本番用にする

[Microsoft Entra 管理センター](https://entra.microsoft.com/) のアプリ登録で、「認証」のリダイレクト URI (種類は「Web」) に次を追加します。
開発用の `http://localhost:3000/oauth/microsoft` は残したままで構いません。

```
https://mail.example.com/oauth/microsoft
```

変更通知 (Webhook) は、追加の設定なしで有効になります。本番では API の公開 URL が `https://mail.example.com` になるので、
同期ワーカーが自動で購読し、Microsoft Graph からの通知を `https://mail.example.com/v1/webhooks/microsoft` で受けます。
購読できたか、失敗したかは、ワーカーのログ (`docker compose logs worker`) に出ます。

開発環境で追加したアカウントは、本番には引き継がれません (DB が別のため)。本番の画面で追加し直してください。

## 8. 更新する

サーバーで次を実行すると、main の最新に更新して起動し直します。マイグレーションも自動で適用されます。

```sh
bash /opt/mail/deploy/deploy.sh
```

更新中は数秒から数十秒、画面や API に繋がらなくなります。

### GitHub Actions で自動更新する

設定すると、main に入った変更の CI が通るたびに、GitHub Actions が SSH でサーバーに入って上のスクリプトを実行します。
設定するまでは、このワークフローは何もしません。

1. 手元の PC で、更新専用の鍵を作ります (パスフレーズは空にします)。

   ```sh
   ssh-keygen -t ed25519 -f mail-deploy -N "" -C "github-actions-deploy"
   ```

2. サーバーの `~/.ssh/authorized_keys` に、次の 1 行を追加します。末尾の `ssh-ed25519 ...` の部分は、`mail-deploy.pub` の中身に置き換えます。
   この書き方にすると、この鍵でできるのは更新スクリプトの実行だけになります (鍵が漏れても、サーバーを自由には操作できません)。

   ```
   command="bash /opt/mail/deploy/deploy.sh \"$SSH_ORIGINAL_COMMAND\"",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... github-actions-deploy
   ```

3. 手元の PC で、サーバーの身元を確かめるための情報を取得します。

   ```sh
   ssh-keyscan -t ed25519 mail.example.com
   ```

4. GitHub のリポジトリの「Settings」→「Secrets and variables」→「Actions」で、次を登録します。

   | 種類 | 名前 | 値 |
   | --- | --- | --- |
   | Secret | `DEPLOY_HOST` | `mail.example.com` (またはサーバーの IP アドレス) |
   | Secret | `DEPLOY_USER` | `ubuntu` |
   | Secret | `DEPLOY_SSH_KEY` | `mail-deploy` (秘密鍵) の中身すべて |
   | Secret | `DEPLOY_KNOWN_HOSTS` | 手順 3 の出力 (`#` で始まる行は不要) |
   | Variable | `DEPLOY_ENABLED` | `true` |

5. Oracle Cloud のセキュリティ・リストで 22 番を自分の IP アドレスだけに絞っている場合は、GitHub Actions から届くように開けておく必要があります。

「Actions」→「Deploy」→「Run workflow」で、手動でも実行できます。止めたいときは `DEPLOY_ENABLED` を `false` にします。

## 9. バックアップと復元

`backup` サービスが、毎日 4 時 (日本時間) に DB を `/opt/mail/deploy/backups/mail-<日時>.dump` へ書き出し、14 日より古いものを消します。
時刻と日数は `deploy/.env` の `BACKUP_HOUR` と `BACKUP_KEEP_DAYS` で変えられます。

```sh
cd /opt/mail/deploy
docker compose run --rm backup once     # 今すぐ 1 回取る
sudo ls -lh backups                     # 取れているか確認
sudo bash restore.sh backups/mail-20261122-040000.dump   # 戻す (今の DB の中身は置き換わります)
```

バックアップに入るのは DB (メールの内容、アカウントの設定、利用者) です。次のものは入りません。

- `deploy/.env` (特に `CREDENTIALS_ENCRYPTION_KEY`)。別に控えてください。
- 送信用に一時的に置いた添付ファイル。7 日で消える一時的なもので、送信済みのメールには影響しません。

バックアップはサーバーの中にあるので、サーバーごと失うと一緒に消えます。ときどき手元へ写しておくことをおすすめします。

```sh
# サーバーで: 最新のバックアップを、利用者 ubuntu が読める場所へ写す (バックアップは root だけが読めるようにしてあります)
sudo install -o ubuntu -m 600 "$(ls -t /opt/mail/deploy/backups/*.dump | head -1)" ~/mail-latest.dump

# 手元の PC で: 受け取る
scp ubuntu@mail.example.com:mail-latest.dump .
```

サーバーを作り直すときは、手順 2 から 6 を行ったあと、控えておいた `deploy/.env` を置き、`restore.sh` で DB を戻します。

## 10. 設定 (環境変数) の一覧

`deploy/.env` に書くものです。変更したら `docker compose up -d` で反映します (`DOMAIN` を変えたときは `docker compose up -d --build`)。

| 名前 | 必須 | 内容 |
| --- | --- | --- |
| `DOMAIN` | ○ | 公開するドメイン (`https://` は付けない)。Web にも埋め込まれる |
| `POSTGRES_PASSWORD` | ○ | DB のパスワード (自動生成)。最初の起動後に変えても DB 側には反映されない |
| `BETTER_AUTH_SECRET` | ○ | ログインセッションの署名に使う秘密の値 (自動生成)。変えると全員がログアウトになる |
| `CREDENTIALS_ENCRYPTION_KEY` | ○ | メールアカウントの認証情報を暗号化する鍵 (自動生成)。変えたり失ったりすると復号できなくなる |
| `MICROSOFT_CLIENT_ID` | | Entra のアプリケーション ID。空なら Microsoft アカウントの追加は無効 |
| `MICROSOFT_CLIENT_SECRET` | | Entra のクライアント シークレット。期限が切れたら作り直して書き換える |
| `MICROSOFT_TENANT` | | 既定は `common`。組織のみなら `organizations`、個人のみなら `consumers` |
| `EXTRA_ALLOWED_ORIGINS` | | Web 以外から API を使うときに許可するオリジン (カンマ区切り)。デスクトップ版やスマホ版を出すときに使う |
| `BACKUP_HOUR` | | バックアップを取る時刻 (0〜23)。既定は 4 |
| `BACKUP_KEEP_DAYS` | | バックアップを残す日数。既定は 14 |
| `TZ` | | ログやバックアップの時刻の基準。既定は `Asia/Tokyo` |

次の値は `DOMAIN` などから `deploy/compose.yml` が決めるので、`deploy/.env` に書く必要はありません (書いても上書きされます)。

| 名前 | 本番での値 |
| --- | --- |
| `DATABASE_URL` | `postgres://mail:<POSTGRES_PASSWORD>@postgres:5432/mail` |
| `API_PUBLIC_URL` | `https://<DOMAIN>` (Microsoft Graph の変更通知の受け口にもなる) |
| `NEXT_PUBLIC_API_URL` | `https://<DOMAIN>` (Web のビルド時に埋め込む) |
| `ALLOWED_ORIGINS` | `https://<DOMAIN>` と `EXTRA_ALLOWED_ORIGINS` |
| `MICROSOFT_REDIRECT_URI` | `https://<DOMAIN>/oauth/microsoft` |
| `ATTACHMENTS_DIR` | `/data/attachments` (API とワーカーが共有するボリューム) |
| `ALLOW_PRIVATE_MAIL_HOSTS` | `false` |
| `API_PORT` | `8787` (外には公開せず、Caddy からだけ届く) |

これ以外に API やワーカーが読む環境変数が今後増えた場合は、`deploy/.env` に書けばそのまま届きます。

## 11. 困ったとき

```sh
cd /opt/mail/deploy
docker compose ps                    # 各サービスの状態
docker compose logs --tail=100 web   # web / api / worker / migrate / postgres / backup
docker compose restart worker        # 1 つだけ再起動
```

| 症状 | 確認すること |
| --- | --- |
| ブラウザーで繋がらない (時間切れ) | 手順 3 の 2 か所でポートが開いているか。DNS がサーバーの IP アドレスを指しているか |
| 証明書のエラーになる | `docker compose logs web` に取得失敗の理由が出ます。DNS の反映前に起動した場合は、反映後に `docker compose restart web` |
| `api` が起動しない | `docker compose logs migrate api`。`deploy/.env` の値が空でないか |
| ログインできない | 利用者を作ったか (手順 6)。パスワードは 12 文字以上 |
| Microsoft のログインで戻ってこられない | Entra のリダイレクト URI が `https://<DOMAIN>/oauth/microsoft` と完全に一致しているか |
| ディスクが足りない | `docker system df` で内訳を確認し、`docker builder prune` で古いビルドの残りを消す |
