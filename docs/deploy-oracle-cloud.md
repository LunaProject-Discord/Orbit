# Oracle Cloud へ配置する

Oracle Cloud の既存のサーバー (AlmaLinux 9、arm64) に、Docker Compose で一式を動かす手順です。
80 番はすでに Apache (httpd) が使っているので、アプリはサーバー内のポートだけで動かし、
外への公開は既存の Apache から逆プロキシします。Web も API も同じドメインで公開します。

```
ブラウザー / Microsoft Graph
        │  https://mail.example.com
        ▼
Cloudflare            HTTPS と証明書
        ▼
Linode の Apache      DDoS 対策。ドメインごとの設定で Oracle Cloud へ中継
        │  80 番
        ▼
既存の Apache (httpd)   ほかのサイトと同居。ドメイン名でメールアプリへ振り分け
        │  http://127.0.0.1:18080
        ▼
┌─ Docker Compose ─────────────────────────────────────────┐
│  web (Caddy)   Web の静的ファイル。/v1/*、/healthz は api へ │
│  api (Hono)    REST API、SSE、認証                         │
│  worker        IMAP / SMTP / Microsoft Graph との同期と送信 │
│  migrate       起動のたびに未適用のマイグレーションを適用    │
│  postgres      PostgreSQL 19                             │
│  backup        毎日 DB を deploy/backups/ に書き出す       │
└──────────────────────────────────────────────────────────┘
```

HTTPS を受ける場所によって、手順 2、5、6 が 2 通りに分かれます。

- **A. 手前の Cloudflare が HTTPS を受ける** (上の図。既存のサイトと同じ経路に載せる)。このサーバーでは証明書を取りません。
- **B. このサーバーの Apache が直接 HTTPS を受ける** (Cloudflare などを通さない場合)。certbot で証明書を取ります。

80 番と 443 番をほかに使っていないサーバーなら、Apache を使わずに Caddy が直接公開する構成も選べます
(末尾の「Apache を使わない場合」を参照)。

関係するファイルは次のとおりです。

| ファイル | 内容 |
| --- | --- |
| `Dockerfile` | 本番用のイメージ (`server`: API・ワーカー・マイグレーション、`web`: Caddy + Web) |
| `deploy/compose.yml` | 本番用の構成 (共通部分) |
| `deploy/compose.apache.yml` | 既存の Web サーバーから逆プロキシする場合に重ねる (web は 127.0.0.1 だけで待ち受け) |
| `deploy/compose.caddy.yml` | Caddy が 80 / 443 番で直接公開する場合に重ねる |
| `deploy/apache/mail.conf` | Oracle Cloud 側の Apache の設定の見本 |
| `deploy/apache/mail-relay.conf` | 中継用のサーバー (Linode) 側の Apache の設定の見本 |
| `deploy/Caddyfile` | コンテナ内での Web / API への振り分け |
| `deploy/.env.example` | 設定の見本。`deploy/setup.sh` がここから `deploy/.env` を作る |
| `deploy/setup.sh` | `deploy/.env` を作り、秘密の値を生成する |
| `deploy/deploy.sh` | 最新のコードに更新して起動し直す |
| `deploy/backup.sh` / `deploy/restore.sh` | DB のバックアップと復元 |
| `.github/workflows/deploy.yml` | main の CI が通ったらサーバーを更新する |

> 確認の状況: Docker Compose 一式の起動、Apache (2.4) からの逆プロキシ経由でのログイン、変更の通知 (SSE)、
> 20 MB の添付ファイルの受け取り、バックアップと復元は、手元の環境 (x86_64、Ubuntu の Apache) で確認しています。
> arm64 でのビルドと起動は GitHub Actions の arm64 の実行環境で確認しています。
> AlmaLinux 上での各コマンド (dnf、firewalld、SELinux、certbot)、Cloudflare と Linode を通した経路、
> Let's Encrypt の証明書の取得、GitHub Actions からの更新は、実際のサーバーでは未確認です。うまくいかない箇所があれば、表示された内容を教えてください。

以下では、ドメインを `mail.example.com` として説明します。自分のドメインに読み替えてください。
コマンドは、特に断りがなければサーバーに SSH で入って実行します。

## 1. 事前に確認する

既存のサービスに影響を出さないため、先に今の状態を確認します。

```sh
sudo httpd -S                      # Apache が今どのサイトを公開しているか
sudo ss -ltnp | grep -E ':(443|18080) '   # 443 番と 18080 番を使っているものが無いか (何も出なければ空いている)
free -h                            # メモリの空き
df -h /                            # ディスクの空き
getenforce                         # SELinux の状態
sudo firewall-cmd --state          # firewalld が動いているか
```

- **`httpd -S` の結果に `*:80` の VirtualHost が 1 つも無い場合** (`Main DocumentRoot` などしか出ない場合) は注意が必要です。
  Apache は VirtualHost が 1 つでもあると、80 番に来たすべての要求を VirtualHost に渡すようになるため、
  このままメールアプリの設定を足すと、既存のサイトまでメールアプリに繋がってしまいます。
  その場合は、手順 6 の前に、既存のサイトを受ける空の VirtualHost を先頭に置いてください
  (中身が空の VirtualHost は、これまでの全体の設定をそのまま引き継ぎます)。

  ```sh
  printf '<VirtualHost *:80>\n</VirtualHost>\n' | sudo tee /etc/httpd/conf.d/000-default.conf
  ```

- 18080 番をほかのサービスが使っている場合は、手順 4 で `deploy/.env` の `LOCAL_PORT` を別の番号に変え、
  手順 6 の Apache の設定も同じ番号にします。
- イメージのビルドには、空きメモリが 2 GB ほど、ディスクが 5 GB ほどあると安心です (目安で、実測した値ではありません)。

## 2. ドメインをサーバーへ向ける

### A. Cloudflare → Linode → このサーバー の経路に載せる

既存のサイト (`natsuki-api.lunaproject.jp` など) と同じやり方で、新しいドメインをこの経路に載せます。
Linode 側の作業は、Oracle Cloud 側 (手順 3 から 6) が済んでから行うと、すぐに繋がることを確かめられます。

**1. Cloudflare**: DNS に新しいドメインのレコードを、既存のサイトと同じ向き先 (Linode) で追加し、プロキシを有効 (オレンジ色の雲) にします。

**2. Linode (中継用のサーバーの Apache)**: `/etc/httpd/conf.d/` に、ドメインごとの設定を 1 つ足します。
既存のサイトの設定を写して作るのが確実です (証明書や Oracle Cloud の向き先が、すでに正しく書かれているため)。

```sh
# Linode のサーバーで実行
cd /etc/httpd/conf.d
DOMAIN=mail.example.com    # 自分のドメインに置き換える
sudo cp natsuki-api.lunaproject.jp.conf "$DOMAIN.conf"
sudo sed -i "s/natsuki-api\.lunaproject\.jp/$DOMAIN/g" "$DOMAIN.conf"
sudo vim "$DOMAIN.conf"
```

開いた設定を、次の表のとおりに直します。メールアプリに必要な指定だけを並べた見本が
[`deploy/apache/mail-relay.conf`](../deploy/apache/mail-relay.conf) にあります。

| 指定 | 直し方 | 理由 |
| --- | --- | --- |
| `ServerName` (80 番と 443 番の 2 か所) | 新しいドメインにする | 上の `sed` で置き換わっているはず |
| `ProxyPass` の `timeout` | `timeout=120` にする (既存のサイトは `timeout=30`) | 変更の通知 (SSE) は繋ぎっぱなしで、25 秒ごとに空のイベントが流れる。30 秒だと余裕が無い |
| `ProxyPass` の行末 | `flushpackets=on` を付ける | 変更の通知をため込まずにすぐ流す。無いと、新着や既読の反映が遅れる |
| `LimitRequestBody 52428800` | 443 番の VirtualHost に足す | 添付ファイル (1 通あたり合計 25 MB まで) を受け取るため |
| `ProxyPass` / `ProxyPassReverse` の向き先 | Oracle Cloud のサーバーの 80 番 (`http://<Oracle Cloud のアドレス>/`) のまま | メールアプリは Oracle Cloud 側の Apache (80 番) で受ける |
| `ProxyPreserveHost on` | あることを確かめる | Oracle Cloud 側の Apache がドメイン名でメールアプリへ振り分けるため。無いと既存のサイトの画面が出る |
| `SSLCertificateFile` など | 既存のサイトと同じまま | 証明書が新しいドメインを含んでいること (下のコマンドで確認) |

証明書が新しいドメインを含んでいるかは、次で分かります (`*.lunaproject.jp` のようなワイルドカードか、新しいドメインそのものが出れば使えます)。

```sh
sudo openssl x509 -in /etc/letsencrypt/live/lunaproject.jp/cert.pem -noout -ext subjectAltName
```

文法を確かめてから読み込み直します。

```sh
sudo apachectl configtest      # Syntax OK 以外なら、読み込み直さずに sudo rm "$DOMAIN.conf" で元に戻せる
sudo systemctl reload httpd
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"    # {"status":"ok"} が返れば、Oracle Cloud まで届いている
```

**3. Oracle Cloud**: 80 番は、既存のサイトと同じくすでに Linode から届いているので、新しく開けるポートはありません。

Cloudflare については次の点に注意してください。

- Microsoft Graph の変更通知は、Microsoft のサーバーから `https://mail.example.com/v1/webhooks/microsoft` に届きます。
  Cloudflare の Bot 対策や WAF がこれを止めると、即時の通知が届かず、定期的な確認だけの同期になります (同期自体は続きます)。
  ワーカーのログに購読の失敗が出る場合は、このパスを対象外にするルールを Cloudflare に追加してください。
- アップロードの大きさの上限 (無料プランは 100 MB のはずです) は、添付の上限 25 MB より大きいので問題ありません。

### B. このサーバーで直接 HTTPS を受ける

**DNS**: ドメインの DNS に、サーバーのパブリック IP アドレスを指す A レコードを追加します。

**Oracle Cloud 側 (セキュリティ・リスト)**: コンソールでインスタンスの詳細 → サブネット → セキュリティ・リスト →
「イングレス・ルールの追加」を開き、ソース `0.0.0.0/0`、TCP、宛先ポート 443 を追加します。

**サーバー側 (firewalld)**: 手順 1 で `running` と出た場合だけ実行します。

```sh
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```

## 3. Docker を入れる

```sh
sudo dnf -y install dnf-plugins-core git
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

グループの変更を反映するため、いったん `exit` で抜けて SSH で入り直します。
`docker compose version` と `docker run --rm hello-world` が動けば準備完了です。

## 4. コードを置いて起動する

```sh
sudo mkdir -p /opt/mail && sudo chown "$USER": /opt/mail
git clone https://github.com/LunaProject-Discord/Mail.git /opt/mail
cd /opt/mail
bash deploy/setup.sh mail.example.com
```

リポジトリが非公開の場合は、そのままでは clone できません。サーバーで `ssh-keygen -t ed25519 -f ~/.ssh/github_mail -N ""` を実行し、
できた `~/.ssh/github_mail.pub` を GitHub のリポジトリの「Settings」→「Deploy keys」に登録 (書き込み権限は不要) したうえで、次のように clone します。

```sh
git clone -c core.sshCommand="ssh -i ~/.ssh/github_mail" git@github.com:LunaProject-Discord/Mail.git /opt/mail
```

`deploy/setup.sh` は `deploy/.env` を作り、DB のパスワード、ログイン用の秘密の値、認証情報を暗号化する鍵、通知用の鍵を自動で生成します。

**`CREDENTIALS_ENCRYPTION_KEY` は必ずサーバーの外にも控えてください** (`grep CREDENTIALS deploy/.env` で表示できます)。
この鍵を失うと、DB をバックアップから戻しても、メールアカウントのパスワードやトークンを復号できません。

Microsoft アカウントや Gmail を使う場合は、ここで `deploy/.env` に `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`、
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` を書き込みます (`nano deploy/.env`。開発用の `.env` と同じ値で構いません)。
そのうえで起動します。初回はイメージのビルドに数分かかります。

```sh
cd /opt/mail/deploy
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:18080/healthz
```

`api` が `healthy`、`migrate` が `Exited (0)`、ほかが `Up` で、最後のコマンドが `{"status":"ok"}` を返せば起動できています。
この時点では、まだ外からは見えません。

続けて、ログイン用の利用者を作ります (パスワードは 12 文字以上で、入力を求められます)。

```sh
docker compose run --rm api node apps/api/dist/cli/create-user.js you@example.com "あなたの名前"
```

## 5. Apache から繋ぐ準備をする

Apache からコンテナへ繋ぐことを SELinux に許可します (手順 1 の `getenforce` が `Enforcing` の場合)。

```sh
sudo setsebool -P httpd_can_network_connect 1
```

B (このサーバーで直接 HTTPS を受ける) の場合だけ、HTTPS 用のモジュールと certbot も入れます。

```sh
sudo dnf -y install epel-release
sudo dnf -y install mod_ssl certbot python3-certbot-apache
```

## 6. Apache にサイトを追加する

設定の見本をドメインに合わせて置き、文法を確かめてから読み込み直します。

```sh
DOMAIN=mail.example.com    # 自分のドメインに置き換える
sed "s/mail\.example\.com/$DOMAIN/g" /opt/mail/deploy/apache/mail.conf | sudo tee /etc/httpd/conf.d/mail.conf
sudo apachectl configtest
sudo systemctl reload httpd
sudo httpd -S
```

- `configtest` が `Syntax OK` 以外を返したら、読み込み直さずに `sudo rm /etc/httpd/conf.d/mail.conf` で元に戻せます。
- `httpd -S` で、既存のサイトがこれまでどおり並び、そこに `mail.example.com` が加わっていることを確認します。
- サーバーの中から、ドメイン名で振り分けられることを確認できます。

  ```sh
  curl -s -H "Host: $DOMAIN" http://127.0.0.1/healthz    # {"status":"ok"} が返る
  ```

**A の場合**は、これで完了です。ブラウザーで `https://mail.example.com` を開き、手順 4 で作った利用者でログインできることを確認します。
Cloudflare が HTTPS を受けるので、このサーバーでは証明書を取りません。

**B の場合**は、続けて証明書を取ります。certbot が HTTPS 用の設定 (`/etc/httpd/conf.d/mail-le-ssl.conf`) を作り、HTTP から HTTPS への転送も設定します。

```sh
sudo certbot --apache -d mail.example.com
sudo systemctl enable --now certbot-renew.timer    # 証明書の自動更新
```

途中で連絡先のメールアドレスと利用規約への同意を聞かれます。
ブラウザーで `https://mail.example.com` を開き、ログインできれば完了です。

## 7. Microsoft と Google の設定を本番用にする

**Microsoft (Exchange Online / Outlook.com)**: [Microsoft Entra 管理センター](https://entra.microsoft.com/) のアプリ登録で、
「認証」のリダイレクト URI (種類は「Web」) に次を追加します。開発用の `http://localhost:3000/oauth/microsoft` は残したままで構いません。

```
https://mail.example.com/oauth/microsoft
```

変更通知 (Webhook) は、追加の設定なしで有効になります。本番では API の公開 URL が `https://mail.example.com` になるので、
同期ワーカーが自動で購読し、Microsoft Graph からの通知を `https://mail.example.com/v1/webhooks/microsoft` で受けます。
購読できたか、失敗したかは、ワーカーのログ (`docker compose logs worker`) に出ます。

**Google (Gmail)**: Google Cloud コンソールの OAuth クライアントで、「承認済みのリダイレクト URI」に次を追加します。

```
https://mail.example.com/oauth/google
```

開発環境で追加したメールアカウントは、本番には引き継がれません (DB が別のため)。本番の画面で追加し直してください。

## 8. 更新する

サーバーで次を実行すると、main の最新に更新して起動し直します。マイグレーションも自動で適用されます。

```sh
bash /opt/mail/deploy/deploy.sh
```

更新中は数秒から数十秒、画面や API に繋がらなくなります (その間、Apache は 503 を返します)。

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
   | Secret | `DEPLOY_USER` | サーバーに SSH で入るときの利用者名 |
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
- 添付ファイルの一時的な置き場。7 日で消える一時的なもので、メールそのものには影響しません。

バックアップはサーバーの中にあるので、サーバーごと失うと一緒に消えます。ときどき手元へ写しておくことをおすすめします。

```sh
# サーバーで: 最新のバックアップを、自分が読める場所へ写す (バックアップは root だけが読めるようにしてあります)
sudo install -o "$USER" -m 600 "$(ls -t /opt/mail/deploy/backups/*.dump | head -1)" ~/mail-latest.dump

# 手元の PC で: 受け取る
scp <利用者名>@mail.example.com:mail-latest.dump .
```

サーバーを作り直すときは、手順 3 から 6 を行ったあと、控えておいた `deploy/.env` を置き、`restore.sh` で DB を戻します。

## 10. 設定 (環境変数) の一覧

`deploy/.env` に書くものです。変更したら `docker compose up -d` で反映します (`DOMAIN` を変えたときは `docker compose up -d --build`)。

| 名前 | 必須 | 内容 |
| --- | --- | --- |
| `DOMAIN` | ○ | 公開するドメイン (`https://` は付けない)。Web にも埋め込まれる |
| `COMPOSE_FILE` | ○ | 公開のしかた。`compose.yml:compose.apache.yml` (逆プロキシ) か `compose.yml:compose.caddy.yml` (Caddy が直接公開) |
| `LOCAL_PORT` | | 逆プロキシの場合に web が 127.0.0.1 で待ち受けるポート。既定は 18080 |
| `POSTGRES_PASSWORD` | ○ | DB のパスワード (自動生成)。最初の起動後に変えても DB 側には反映されない |
| `BETTER_AUTH_SECRET` | ○ | ログインセッションの署名に使う秘密の値 (自動生成)。変えると全員がログアウトになる |
| `CREDENTIALS_ENCRYPTION_KEY` | ○ | メールアカウントの認証情報を暗号化する鍵 (自動生成)。変えたり失ったりすると復号できなくなる |
| `MICROSOFT_CLIENT_ID` | | Entra のアプリケーション ID。空なら Microsoft アカウントの追加は無効 |
| `MICROSOFT_CLIENT_SECRET` | | Entra のクライアント シークレット。期限が切れたら作り直して書き換える |
| `MICROSOFT_TENANT` | | 既定は `common`。組織のみなら `organizations`、個人のみなら `consumers` |
| `GOOGLE_CLIENT_ID` | | Google の OAuth クライアント ID。空なら Gmail (Google でログイン) の追加は無効 |
| `GOOGLE_CLIENT_SECRET` | | Google の OAuth クライアント シークレット |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | | 新着メールの通知 (Web Push) の鍵の組 (自動生成)。変えると端末で通知を許可し直す必要がある |
| `VAPID_SUBJECT` | | プッシュサービスが運営者へ連絡するための宛先。既定は `https://<DOMAIN>` |
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
| `GOOGLE_REDIRECT_URI` | `https://<DOMAIN>/oauth/google` |
| `ATTACHMENTS_DIR` | `/data/attachments` (API とワーカーが共有するボリューム) |
| `ALLOW_PRIVATE_MAIL_HOSTS` | `false` |
| `API_PORT` | `8787` (外には公開せず、コンテナの web からだけ届く) |

これ以外に API やワーカーが読む環境変数が今後増えた場合は、`deploy/.env` に書けばそのまま届きます。

## 11. 困ったとき

```sh
cd /opt/mail/deploy
docker compose ps                    # 各サービスの状態
docker compose logs --tail=100 api   # web / api / worker / migrate / postgres / backup
docker compose restart worker        # 1 つだけ再起動
sudo tail -n 50 /var/log/httpd/mail_error.log   # Apache 側のエラー
```

| 症状 | 確認すること |
| --- | --- |
| ブラウザーで繋がらない、Cloudflare のエラー画面 (52x) が出る | 手順 2 の経路 (Cloudflare の DNS、Linode の中継) に新しいドメインが載っているか。サーバーの中では `curl -H "Host: <DOMAIN>" http://127.0.0.1/healthz` が返るか |
| 既存のサイトの画面が出る | Linode が Host ヘッダーを `<DOMAIN>` のまま渡しているか。`sudo httpd -S` に `<DOMAIN>` が出ているか |
| 添付ファイルを上げると 413 になる | Linode と Oracle Cloud の両方の Apache の設定に `LimitRequestBody 52428800` があるか |
| 503 Service Unavailable | コンテナが動いているか (`docker compose ps`、`curl http://127.0.0.1:18080/healthz`)。動いているのに 503 なら、Apache のエラーログに `Permission denied` が出ていないか (出ていれば手順 5 の `setsebool`) |
| 既存のサイトがメールアプリに繋がってしまう | 手順 1 の空の VirtualHost (`000-default.conf`) を置いて `sudo systemctl reload httpd` |
| certbot が失敗する (B の場合) | DNS が反映済みか。80 番と 443 番が外から届くか |
| `api` が起動しない | `docker compose logs migrate api`。`deploy/.env` の値が空でないか |
| ログインできない | 利用者を作ったか (手順 4)。パスワードは 12 文字以上 |
| Microsoft / Google のログインで戻ってこられない | リダイレクト URI が `https://<DOMAIN>/oauth/microsoft` (`/oauth/google`) と完全に一致しているか |
| 新着の反映が遅い | Apache の設定の `ProxyPass` に `flushpackets=on` が付いているか。Linode 側の設定にも付いているか。Microsoft のアカウントなら、ワーカーのログに変更通知の購読の失敗が出ていないか |
| ディスクが足りない | `docker system df` で内訳を確認し、`docker builder prune` で古いビルドの残りを消す |

元に戻す (メールアプリを取り除く) ときは、次の順に行います。既存のサイトの設定には触れません。

```sh
cd /opt/mail/deploy && docker compose down          # コンテナを止める (データは残る。消すなら down -v)
sudo rm -f /etc/httpd/conf.d/mail.conf /etc/httpd/conf.d/mail-le-ssl.conf
sudo apachectl configtest && sudo systemctl reload httpd
```

## Apache を使わない場合 (Caddy が直接公開する)

80 番と 443 番をほかに使っていないサーバー (新しく作ったインスタンスなど) では、Caddy に公開と証明書の取得を任せられます。
手順 5 と 6 は不要になり、手順 4 の `setup.sh` を次のように実行します。

```sh
bash deploy/setup.sh mail.example.com caddy
```

- 80 番と 443 番 (TCP。HTTP/3 も使うなら 443 番の UDP も) を、セキュリティ・リストとサーバーのファイアウォールの両方で開けます。
- Oracle Cloud の Ubuntu のイメージは、最初から SSH 以外を拒否する設定 (iptables) になっています。次で開けます。

  ```sh
  sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
  sudo iptables -I INPUT -p udp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
  ```

- Ubuntu では、Docker は `curl -fsSL https://get.docker.com | sudo sh` で入れられます。
- 新しくインスタンスを作る場合は、イメージは Arm 用の Linux、シェイプは Ampere の `VM.Standard.A1.Flex` を選びます。
  無料枠の上限は、作成画面の「Always Free 対象」の表示で確認してください。
