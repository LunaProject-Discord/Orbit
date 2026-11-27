# Oracle Cloud へ配置する

Oracle Cloud の既存のサーバー (AlmaLinux 9、arm64) に、Docker Compose で一式を動かす手順です。
既存のサイトと同じく、中継用のサーバー (Linode) の Apache が HTTPS を受け、Oracle Cloud のアプリのポートへ直接中継します。
Oracle Cloud 側の Apache には手を入れません。Web も API も同じドメインで公開します。

```
ブラウザー / Microsoft Graph
        │  https://orbit.example.com
        ▼
Cloudflare
        ▼
Linode の Apache      HTTPS と証明書。ドメインごとの設定で Oracle Cloud へ中継
        │  https://<Oracle Cloud のアドレス>:18080   (専用の証明書で相手を確かめる)
        ▼
┌─ Oracle Cloud のサーバー (Docker Compose) ───────────────┐
│  web (Caddy)   Web の静的ファイル。/v1/*、/healthz は api へ │
│  api (Hono)    REST API、SSE、認証                         │
│  worker        IMAP / SMTP / Microsoft Graph との同期と送信 │
│  migrate       起動のたびに未適用のマイグレーションを適用    │
│  postgres      PostgreSQL 19                             │
│  backup        毎日 DB を deploy/backups/ に書き出す       │
└──────────────────────────────────────────────────────────┘
```

ほかの公開のしかた (同じサーバーの Apache から繋ぐ、Caddy が直接公開する) は、末尾の「ほかの構成」にまとめています。

関係するファイルは次のとおりです。

| ファイル | 内容 |
| --- | --- |
| `Dockerfile` | 本番用のイメージ (`server`: API・ワーカー・マイグレーション、`web`: Caddy + Web) |
| `deploy/compose.yml` | 本番用の構成 (共通部分) |
| `deploy/compose.relay.yml` | 別のサーバー (Linode) から逆プロキシする場合に重ねる (web は 1 つのポートで、HTTPS で待ち受け) |
| `deploy/compose.proxy.yml` | 同じサーバーの Apache から逆プロキシする場合に重ねる (web は 127.0.0.1 の 1 つのポートで、HTTP で待ち受け) |
| `deploy/compose.caddy.yml` | Caddy が 80 / 443 番で直接公開する場合に重ねる |
| `deploy/apache/orbit-relay.conf` | 中継用のサーバー (Linode) の Apache の設定の見本 |
| `deploy/apache/orbit.conf` | 同じサーバーの Apache から繋ぐ場合の設定の見本 |
| `deploy/Caddyfile` | コンテナ内での Web / API への振り分け |
| `deploy/.env.example` | 設定の見本。`deploy/setup.sh` がここから `deploy/.env` を作る |
| `deploy/setup.sh` | `deploy/.env` を作り、秘密の値と、Linode との間の HTTPS に使う証明書 (`deploy/certs/`) を生成する |
| `deploy/deploy.sh` | 最新のコードに更新して起動し直す |
| `deploy/backup.sh` / `deploy/restore.sh` | DB のバックアップと復元 |
| `deploy/backup-key.sh` | バックアップを暗号化する鍵の組を作る |
| `.github/workflows/deploy.yml` | main の CI が通ったらサーバーを更新する |

> 確認の状況: Docker Compose 一式の起動、Apache (2.4) からの逆プロキシ経由でのログイン、変更の通知 (SSE)、
> 20 MB の添付ファイルの受け取り、バックアップと復元は、手元の環境 (x86_64、Ubuntu の Apache) で確認しています。
> Apache から HTTPS での中継 (証明書が違う相手には繋がらないこと)、バックアップの暗号化と復元も、同じ環境で確認しています。
> arm64 でのビルドと起動は GitHub Actions の arm64 の実行環境で確認しています。
> AlmaLinux 上での各コマンド (dnf、firewalld)、Cloudflare と Linode を通した経路、
> GitHub Actions からの更新は、実際のサーバーでは未確認です。うまくいかない箇所があれば、表示された内容を教えてください。

以下では、ドメインを `orbit.example.com` として説明します。自分のドメインに読み替えてください。
コマンドは、特に断りがなければ Oracle Cloud のサーバーに SSH で入って実行します。

## 1. 事前に確認する

```sh
sudo ss -ltnp | grep -E ':18080 '   # 18080 番を使っているものが無いか (何も出なければ空いている)
free -h                             # メモリの空き
df -h /                             # ディスクの空き
```

- 18080 番をほかのサービスが使っている場合は、手順 3 で `deploy/.env` の `LOCAL_PORT` を別の番号に変え、
  手順 4 と 5 でも同じ番号を使います。
- イメージのビルド中は、一時的にメモリを約 2 GB 使います (x86_64 の 4 コアで測った値で、ほとんどが Web のビルドです)。
  ディスクは、イメージとビルドの残りで数 GB を見込んでください。

## 2. Docker を入れる

```sh
sudo dnf -y install dnf-plugins-core git
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

グループの変更を反映するため、いったん `exit` で抜けて SSH で入り直します。
`docker compose version` と `docker run --rm hello-world` が動けば準備完了です。

## 3. コードを置いて起動する

```sh
sudo mkdir -p /opt/orbit && sudo chown "$USER": /opt/orbit
git clone https://github.com/LunaProject-Discord/Orbit.git /opt/orbit
cd /opt/orbit
bash deploy/setup.sh orbit.example.com relay
```

リポジトリが非公開の場合は、そのままでは clone できません。サーバーで `ssh-keygen -t ed25519 -f ~/.ssh/github_orbit -N ""` を実行し、
できた `~/.ssh/github_orbit.pub` を GitHub のリポジトリの「Settings」→「Deploy keys」に登録 (書き込み権限は不要) したうえで、次のように clone します。

```sh
git clone -c core.sshCommand="ssh -i ~/.ssh/github_orbit" git@github.com:LunaProject-Discord/Orbit.git /opt/orbit
```

`deploy/setup.sh` は `deploy/.env` を作り、DB のパスワード、ログイン用の秘密の値、認証情報を暗号化する鍵、通知用の鍵を自動で生成します。
あわせて、Linode との間を HTTPS にするための証明書 (`deploy/certs/relay.crt`) と秘密鍵 (`relay.key`) も作ります (手順 5 で使います)。

**`CREDENTIALS_ENCRYPTION_KEY` は必ずサーバーの外にも控えてください** (`grep CREDENTIALS deploy/.env` で表示できます)。
この鍵を失うと、DB をバックアップから戻しても、メールアカウントのパスワードやトークンを復号できません。

Microsoft アカウントや Gmail を使う場合は、ここで `deploy/.env` に `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`、
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` を書き込みます (`nano deploy/.env`。開発用の `.env` と同じ値で構いません)。
そのうえで起動します。初回はイメージのビルドに数分かかります。

```sh
cd /opt/orbit/deploy
docker compose up -d --build
docker compose ps
curl -s --cacert certs/relay.crt --resolve orbit.example.com:18080:127.0.0.1 https://orbit.example.com:18080/healthz
```

`api` が `healthy`、`migrate` が `Exited (0)`、ほかが `Up` で、最後のコマンドが `{"status":"ok"}` を返せば起動できています。
この時点では、まだ外からは見えません (手順 4 でポートを許可し、手順 5 で Linode から繋ぎます)。

18080 番は HTTPS で待ち受けます。Linode との間はインターネットを通るので、メールの内容やログインの情報が平文で流れないようにするためです。
上の `curl` は、作った証明書だけを信頼して繋いでいます (`http://` で繋ぐと 400 が返ります)。

続けて、ログイン用の利用者を作ります (パスワードは 12 文字以上で、入力を求められます)。

```sh
docker compose run --rm api node apps/api/dist/cli/create-user.js you@example.com "あなたの名前"
```

### 管理者を作る

利用者の招待などは、管理画面 (`https://<ドメイン>/admin`) で行います。管理者は、メールを使う利用者とは別の
アカウントです (メールは使えず、管理画面にだけログインします)。1 人で使う場合も、自分用の利用者とは別に作ります。

管理者は、次のどちらかで作ります。

- サーバー上のコマンド (パスワードは 12 文字以上で、入力を求められます)

  ```sh
  docker compose run --rm api node apps/api/dist/cli/admin.js create admin "管理者"
  ```

- 初回セットアップの画面: 管理者が 1 人もいない間は、API を起動したときのログに合言葉が出ます
  (`docker compose logs api | grep 合言葉`)。`https://<ドメイン>/admin/setup` を開き、合言葉と、
  ログインに使う名前・表示名・パスワードを入れます。管理者ができると、この画面は使えなくなります。

作ったら `/admin` でログインし、「ログインとセキュリティ」で 2 段階認証かパスキーを設定してください。

管理者のパスワードを忘れたとき、認証アプリを失ったとき、乗っ取りが疑われるときは、サーバー上で付け直します
(すべての端末がログアウトになり、登録したパスキーも消えます)。

```sh
docker compose run --rm api node apps/api/dist/cli/admin.js password admin --reset-two-factor
```

管理者を増やすときは同じ `create`、消すときは `delete <名前>`、一覧は `list` です。

v0.2 まで (users.is_admin) の管理者は、この版に更新すると一般の利用者になります。管理者は上の手順で新しく作ってください
(作るまでは、招待リンクの発行などはできません)。

### ほかの人にも使ってもらう

新規登録の画面はありません (API でも受け付けません)。使ってもらう人には、**招待リンク**を渡します。

1. 管理画面 (`/admin`) にログインし、「招待」→「招待リンクを作成」を押します
   (覚え書き、登録できるメールアドレス、有効期限を決められます)。
2. 表示されたリンクをコピーして、相手に渡します。リンクは発行した直後にしか表示されません
   (サーバーには合言葉のハッシュだけを保存します)。
3. 相手がリンクを開き、名前・ログイン用のメールアドレス・パスワードを決めて登録します。
   1 つのリンクで登録できるのは 1 人だけで、期限が切れたリンクや取り消したリンクは使えません。

サーバー上のコマンドでも、これまでどおり利用者を作れます。

```sh
docker compose run --rm api node apps/api/dist/cli/create-user.js friend@example.com "相手の名前"
```

- メールアカウント、メール、下書き、設定は利用者ごとに分かれていて、ほかの利用者からは見えません
  (`apps/api/src/isolation.test.ts` が、2 人の利用者ですべての API を確かめています)。
  ただし、サーバーの管理者は DB とバックアップを読める立場にあります。相手にはそのことを伝えてください。
- Gmail を「Google でログイン」で追加する場合、OAuth 同意画面が「テスト中」なら、相手の Google アカウントを
  「テストユーザー」に登録します (README の「Gmail (Google でログイン)」)。
- Microsoft のアカウントは、Entra のアプリ登録の「サポートされているアカウントの種類」が自分の組織だけに
  なっていると、ほかの組織や個人のアカウントを追加できません。
- やめるときは、DB から利用者を消すと、その人の DB 上のデータもまとめて消えます (取得済みの添付ファイルは置き場に残ります)
  (`docker compose exec postgres psql -U orbit -d orbit -c "delete from users where email = 'friend@example.com'"`)。

## 4. 18080 番を Linode からだけ届くようにする

Oracle Cloud のコンソールでインスタンスの詳細 → サブネット → セキュリティ・リスト → 「イングレス・ルールの追加」を開き、
既存のサイトのポート (8080 番など) のルールと同じ形で、次を追加します。

| 項目 | 値 |
| --- | --- |
| ソース CIDR | Linode のサーバーの IP アドレス (`<IP アドレス>/32`) |
| プロトコル | TCP |
| 宛先ポート | 18080 |

**ソースを `0.0.0.0/0` にしないでください。** Docker が公開したポートは、サーバーのファイアウォール (firewalld) の設定に関係なく届くので、
接続元を絞れるのはこのセキュリティ・リストだけです。全体に開けると、Cloudflare と Linode を通らずに直接アクセスできてしまいます。

Linode から届くかは、Linode のサーバーで次を実行して確かめます。

```sh
curl -sk https://<Oracle Cloud のアドレス>:18080/healthz    # {"status":"ok"} が返る
```

ここでは届くかどうかだけを見るので、証明書の確認を省いています (`-k`)。証明書で相手を確かめる設定は、手順 5 で行います。

届かない場合は、firewalld で既存のポートを個別に許可している可能性があります。既存のポートと同じやり方で 18080 番も許可してください
(`sudo firewall-cmd --list-all` で今の設定を確認できます)。

## 5. Linode の Apache に設定を足す

まず、Oracle Cloud のサーバーで作った証明書を Linode のサーバーに置きます。写すのは証明書 (`relay.crt`) だけで、
秘密鍵 (`relay.key`) は Oracle Cloud のサーバーから出しません。証明書は見られても困らないものなので、画面に出して貼り付けるのが簡単です。

```sh
# Oracle Cloud のサーバーで実行し、表示された内容 (BEGIN の行から END の行まで) を写す
cat /opt/orbit/deploy/certs/relay.crt

# Linode のサーバーで実行し、写した内容を貼り付けて保存する
sudo vim /etc/httpd/conf/orbit-relay.crt
sudo openssl x509 -in /etc/httpd/conf/orbit-relay.crt -noout -subject -enddate    # 読めることを確認
```

次に、Linode のサーバーの `/etc/httpd/conf.d/` に、ドメインごとの設定を 1 つ足します。
既存のサイトの設定を写して作るのが確実です (証明書や Oracle Cloud の向き先が、すでに正しく書かれているため)。

```sh
# Linode のサーバーで実行
cd /etc/httpd/conf.d
DOMAIN=orbit.example.com    # 自分のドメインに置き換える
sudo cp natsuki-api.lunaproject.jp.conf "$DOMAIN.conf"
sudo sed -i "s/natsuki-api\\.lunaproject\\.jp/$DOMAIN/g" "$DOMAIN.conf"
sudo vim "$DOMAIN.conf"
```

開いた設定を、次の表のとおりに直します。完成形の見本が
[`deploy/apache/orbit-relay.conf`](../deploy/apache/orbit-relay.conf) にあります。

| 指定 | 直し方 | 理由 |
| --- | --- | --- |
| `ServerName` (80 番と 443 番の 2 か所) | 新しいドメインにする | 上の `sed` で置き換わっているはず |
| `ProxyPass` / `ProxyPassReverse` の向き先 | `https://<Oracle Cloud のアドレス>:18080/` にする (`http` ではなく `https`) | メールアプリが待ち受けるポート。HTTPS で待ち受けている |
| `SSLProxyEngine on` から `SSLProxyProtocol` までの 7 行 | 見本から写して、443 番の VirtualHost に足す | Oracle Cloud との間を HTTPS にし、置いた証明書の相手にだけ繋ぐ。経路の途中で盗み見たり、なりすましたりできなくなる |
| `ProxyPass` の `timeout` | `timeout=120` にする (既存のサイトは 10 や 30) | 変更の通知 (SSE) は繋ぎっぱなしで、25 秒ごとに空のイベントが流れる。短いと通知が途中で切れる |
| `ProxyPass` の行末 | `flushpackets=on` を付ける | 変更の通知をため込まずにすぐ流す。無いと、新着や既読の反映が遅れる |
| `LimitRequestBody 52428800` | 443 番の VirtualHost に足す | 添付ファイル (1 通あたり合計 25 MB まで) を受け取るため |
| `ProxyPreserveHost on` | あることを確かめる | 既存のサイトと同じ |
| そのサイト専用の行 (`/media` を `ws://` へ渡す行など) | 消す | メールアプリは WebSocket を使わない |
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

`SSLProxyEngine` が使えないと言われた場合は、HTTPS 用のモジュール (`mod_ssl`) が読み込まれていません。
既存のサイトが HTTPS を受けているサーバーなら入っているはずです。

## 6. Cloudflare にドメインを足して確認する

Cloudflare の DNS に新しいドメインのレコードを、既存のサイトと同じ向き先 (Linode) で追加し、プロキシを有効 (オレンジ色の雲) にします。

ブラウザーで `https://orbit.example.com` を開き、手順 3 で作った利用者でログインできれば完了です。

Cloudflare については次の点に注意してください。

- Microsoft Graph の変更通知は、Microsoft のサーバーから `https://orbit.example.com/v1/webhooks/microsoft` に届きます。
  Cloudflare の Bot 対策や WAF がこれを止めると、即時の通知が届かず、定期的な確認だけの同期になります (同期自体は続きます)。
  ワーカーのログに購読の失敗が出る場合は、このパスを対象外にするルールを Cloudflare に追加してください。
- アップロードの大きさの上限 (無料プランは 100 MB のはずです) は、添付の上限 25 MB より大きいので問題ありません。

## 7. Microsoft と Google の設定を本番用にする

**Microsoft (Exchange Online / Outlook.com)**: [Microsoft Entra 管理センター](https://entra.microsoft.com/) のアプリ登録で、
「認証」のリダイレクト URI (種類は「Web」) に次を追加します。開発用の `http://localhost:3000/oauth/microsoft` は残したままで構いません。

```
https://orbit.example.com/oauth/microsoft
```

変更通知 (Webhook) は、追加の設定なしで有効になります。本番では API の公開 URL が `https://orbit.example.com` になるので、
同期ワーカーが自動で購読し、Microsoft Graph からの通知を `https://orbit.example.com/v1/webhooks/microsoft` で受けます。
購読できたか、失敗したかは、ワーカーのログ (`docker compose logs worker`) に出ます。

**Google (Gmail)**: Google Cloud コンソールの OAuth クライアントで、「承認済みのリダイレクト URI」に次を追加します。

```
https://orbit.example.com/oauth/google
```

開発環境で追加したメールアカウントは、本番には引き継がれません (DB が別のため)。本番の画面で追加し直してください。

### 利用者へ送るメール (パスワードの再設定など)

パスワードの再設定とメールアドレスの変更では、Orbit 自身が利用者へメールを送ります。送り方は次の 2 つから選び、
`deploy/.env` に書いてください (両方を書くと起動時に止まります)。未設定でも Orbit は動きますが、この 2 つは使えません
(画面にも出ません)。パスワードの変更、2 段階認証、パスキーは、設定しなくても使えます。

| 送り方 | 向いている場合 |
| --- | --- |
| Microsoft 365 (Microsoft Graph) | Microsoft 365 (Exchange Online) のメールボックスから送る |
| SMTP | 独自ドメインのメールサーバー、Gmail のアプリ パスワード、送信専用のサービスなど |

反映はどちらも `docker compose up -d` です。API のログ (`docker compose logs api`) に、どちらで送るかが 1 行出ます
(「利用者へのメールは Microsoft Graph で送ります」など)。実際に送れるかは、ログイン画面の「パスワードを忘れた場合」で
確かめてください。送れなかったときは、API のログに「メールを送れませんでした」と理由が出ます
(画面には、登録の有無を漏らさないよう、どちらの場合も同じ文を出します)。

#### Microsoft 365 から送る (Microsoft Graph)

Microsoft 365 の SMTP は、ユーザー名とパスワードでのログイン (基本認証) が廃止される予定で、テナントによっては
すでに無効です ([Exchange Team の告知](https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835)。
2026 年 1 月の更新では、2026 年 12 月から標準で無効)。そのため Microsoft 365 では、SMTP ではなく Microsoft Graph の
`sendMail` で送ります。利用者のログインを介さない、アプリ専用の認証 (client credentials) を使います。

1. [Microsoft Entra 管理センター](https://entra.microsoft.com/) の「アプリの登録」で、メールアカウントの追加に使っている
   アプリ (手順 7 のもの) を開きます。送信専用に別のアプリを作っても構いません
   (その場合は「クライアント シークレット」も作ります)。
2. 「API のアクセス許可」→「アクセス許可の追加」→「Microsoft Graph」→「**アプリケーションの許可**」で `Mail.Send` を追加します
   (「委任されたアクセス許可」の `Mail.Send` とは別のものです)。
3. 同じ画面の「(テナント名) に管理者の同意を与えます」を押します。全体管理者などの権限が要ります。
4. 「概要」の「ディレクトリ (テナント) ID」を控えます。
5. `deploy/.env` に書きます。

   ```sh
   # 送信に使うメールボックス (このアドレスが差出人になる)。共有メールボックスでもよい
   SYSTEM_MAIL_GRAPH_SENDER=no-reply@example.com
   # 手順 4 の ID (example.onmicrosoft.com のようなドメインでもよい)
   SYSTEM_MAIL_GRAPH_TENANT=00000000-0000-0000-0000-000000000000
   # 送信専用に別のアプリを作ったときだけ書く。空なら MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET を使う
   SYSTEM_MAIL_GRAPH_CLIENT_ID=
   SYSTEM_MAIL_GRAPH_CLIENT_SECRET=
   ```

注意する点:

- 職場または学校のアカウント (Microsoft 365 のテナント) だけで使えます。個人の Outlook.com のアカウントでは使えません。
- `SYSTEM_MAIL_GRAPH_TENANT` は必ず自分のテナントにします (`common` は使えません)。メールアカウントの追加に使う
  `MICROSOFT_TENANT` は `common` のままで構いません。
- 送ったメールは、差出人のメールボックスの「送信済みアイテム」には残しません (再設定のリンクを残さないため)。
- **送れる範囲**: 手順 2 と 3 の許可は、そのアプリが**テナントのどのメールボックスからでも**送れる許可です。
  クライアント シークレットが漏れると、ほかの人になりすまして送られるおそれがあります。自分だけのテナントでなければ、
  送れるメールボックスを絞ってください。Exchange Online の
  [アプリケーション用の RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac) で、対象のメールボックスだけに
  `Application Mail.Send` の役割を割り当て、Entra 側のテナント全体の `Mail.Send` (手順 2 と 3) は外します。
  両方を残すと許可が足し合わされ、絞り込みが効きません (以前の「アプリケーション アクセス ポリシー」は、この仕組みに置き換えられています)。
  この絞り込みは、こちらでは実際のテナントで試していません。
- うまく送れないとき、ログの理由が `invalid_client` ならシークレットの間違いか期限切れ、`ErrorAccessDenied` や 403 なら
  手順 2 と 3 (許可と管理者の同意)、`ErrorInvalidUser` や 404 なら `SYSTEM_MAIL_GRAPH_SENDER` のアドレスを確かめてください。

#### SMTP で送る

```sh
SYSTEM_MAIL_HOST=smtp.example.com
SYSTEM_MAIL_PORT=587
SYSTEM_MAIL_USER=no-reply@example.com
SYSTEM_MAIL_PASSWORD=...
SYSTEM_MAIL_FROM="Orbit <no-reply@example.com>"
```

- 差出人 (`SYSTEM_MAIL_FROM`) は、そのサービスで送ってよいアドレスにします。
- ポートは 587 (STARTTLS) か 465 (最初から TLS) を使います。Oracle Cloud は、25 番への送信を標準で止めています。
- 暗号化なしの接続では送りません (587 番では STARTTLS が必須です)。

**パスキー**は、公開しているドメイン (`DOMAIN`) に結び付きます。追加の設定は要りませんが、ドメインを変えると
登録済みのパスキーは使えなくなります。ブラウザーの Web 版でだけ使えます (Android アプリとデスクトップ版では使えません。
理由は README の「ログインとセキュリティ」)。

**ログインできなくなったとき**は、サーバー上でパスワードを付け直せます (新しいパスワードを尋ねられます)。
認証アプリもバックアップコードも失ったときは、`--reset-two-factor` を付けて 2 段階認証も解除します。

```sh
cd /opt/orbit/deploy
docker compose run --rm api node apps/api/dist/cli/set-password.js you@example.com
docker compose run --rm api node apps/api/dist/cli/set-password.js you@example.com --reset-two-factor
```

## 8. 更新する

サーバーで次を実行すると、main の最新に更新して起動し直します。マイグレーションも自動で適用されます。

```sh
bash /opt/orbit/deploy/deploy.sh
```

更新中は数秒から数十秒、画面や API に繋がらなくなります (その間、Linode の Apache は 503 を返します)。

デスクトップ版とスマホアプリの画面も、ここで配置した画面に自動で更新されます。初めてのときは、表示される「画面の自動更新の公開鍵」を GitHub に登録してアプリをビルドし直す必要があります ([アプリの画面の自動更新](app-update.md))。

リリース (`v1.2.0` などのタグ) を追う運用、版の固定、サーバー自身による毎日の自動更新、アプリ本体の配布は [サーバーとアプリの更新](updates.md) を見てください (`bash /opt/orbit/deploy/update.sh --now` で、`deploy/.env` の方針の版へ更新します)。

### GitHub Actions で自動更新する

設定すると、main に入った変更の CI が通るたびに、GitHub Actions が SSH でサーバーに入って上のスクリプトを実行します。
設定するまでは、このワークフローは何もしません。

1. 手元の PC で、更新専用の鍵を作ります (パスフレーズは空にします)。

   ```sh
   ssh-keygen -t ed25519 -f orbit-deploy -N "" -C "github-actions-deploy"
   ```

2. サーバーの `~/.ssh/authorized_keys` に、次の 1 行を追加します。末尾の `ssh-ed25519 ...` の部分は、`orbit-deploy.pub` の中身に置き換えます。
   この書き方にすると、この鍵でできるのは更新スクリプトの実行だけになります (鍵が漏れても、サーバーを自由には操作できません)。

   ```
   command="bash /opt/orbit/deploy/deploy.sh \"$SSH_ORIGINAL_COMMAND\"",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... github-actions-deploy
   ```

3. 手元の PC で、サーバーの身元を確かめるための情報を取得します。

   ```sh
   ssh-keyscan -t ed25519 <サーバーの IP アドレス>
   ```

4. GitHub のリポジトリの「Settings」→「Secrets and variables」→「Actions」で、次を登録します。

   | 種類 | 名前 | 値 |
   | --- | --- | --- |
   | Secret | `DEPLOY_HOST` | Oracle Cloud のサーバーの IP アドレス (ドメインは Cloudflare を指すので、SSH には使えない) |
   | Secret | `DEPLOY_USER` | サーバーに SSH で入るときの利用者名 |
   | Secret | `DEPLOY_SSH_KEY` | `orbit-deploy` (秘密鍵) の中身すべて |
   | Secret | `DEPLOY_KNOWN_HOSTS` | 手順 3 の出力 (`#` で始まる行は不要) |
   | Variable | `DEPLOY_ENABLED` | `true` |

5. Oracle Cloud のセキュリティ・リストで 22 番を自分の IP アドレスだけに絞っている場合は、GitHub Actions から届くように開けておく必要があります。

「Actions」→「Deploy」→「Run workflow」で、手動でも実行できます。止めたいときは `DEPLOY_ENABLED` を `false` にします。

## 9. バックアップと復元

`backup` サービスが、毎日 4 時 (日本時間) に DB を `/opt/orbit/deploy/backups/` へ書き出し、14 日より古いものを消します。
時刻と日数は `deploy/.env` の `BACKUP_HOUR` と `BACKUP_KEEP_DAYS` で変えられます。

### バックアップを暗号化する

バックアップにはメールの内容がそのまま入ります。最初に 1 度、暗号化のための鍵の組を作ってください。

```sh
cd /opt/orbit/deploy
bash backup-key.sh
```

- 公開鍵が `deploy/.env` の `BACKUP_PUBLIC_KEY` に書き込まれ、以後のバックアップは暗号化されて `orbit-<日時>.dump.gpg` になります
  (OpenPGP 形式。作っていない間は、暗号化なしの `orbit-<日時>.dump` です)。
- 秘密鍵 (`-----BEGIN PGP PRIVATE KEY BLOCK-----` から `-----END PGP PRIVATE KEY BLOCK-----` まで) が、画面に 1 度だけ表示されます。
  **必ずサーバーの外 (パスワード管理ソフトなど) に控えてください。** サーバーには保存しません。サーバーやバックアップのファイルを
  読まれても、中身を開けないようにするためです。この秘密鍵を失うと、暗号化したバックアップは戻せません。
- 鍵を作る前に取った暗号化なしのバックアップは、そのまま残ります。暗号化したバックアップが取れたことを確かめたら、
  `sudo rm backups/orbit-*.dump` で消せます (消さなくても 14 日で消えます)。
- 鍵を作り直すときは `bash backup-key.sh --renew` です。それまでのバックアップを戻すには、前の秘密鍵が引き続き必要です。

### 取る、戻す

```sh
cd /opt/orbit/deploy
docker compose run --rm backup once     # 今すぐ 1 回取る
sudo ls -lh backups                     # 取れているか確認
sudo bash restore.sh backups/orbit-20261122-040000.dump.gpg   # 戻す (今の DB の中身は置き換わります)
```

暗号化したバックアップを戻すときは、秘密鍵を貼り付けるよう求められます。秘密鍵をファイルにしてある場合は、
`sudo bash restore.sh <バックアップ> <秘密鍵のファイル>` のように 2 つ目に指定できます (使い終わったファイルは消してください)。
秘密鍵が合わない場合や、ファイルが壊れている場合は、DB には手を付けずに止まります。

バックアップに入るのは DB (メールの内容、アカウントの設定、利用者) です。次のものは入りません。

- `deploy/.env` (特に `CREDENTIALS_ENCRYPTION_KEY`)。別に控えてください。
- `deploy/certs/` (Linode との間の証明書と秘密鍵)。失っても `setup.sh` で作り直せます (末尾の「証明書を作り直す」)。
- 添付ファイルの一時的な置き場。7 日で消える一時的なもので、メールそのものには影響しません。

バックアップはサーバーの中にあるので、サーバーごと失うと一緒に消えます。ときどき手元へ写しておくことをおすすめします。

```sh
# サーバーで: 最新のバックアップを、自分が読める場所へ写す (バックアップは root だけが読めるようにしてあります)
sudo install -o "$USER" -m 600 "$(sudo sh -c 'ls -t /opt/orbit/deploy/backups/orbit-*.dump.gpg | head -1')" ~/orbit-latest.dump.gpg

# 手元の PC で: 受け取る
scp <利用者名>@<サーバーの IP アドレス>:orbit-latest.dump.gpg .
```

暗号化したバックアップは、秘密鍵が無ければ開けないので、手元やほかの保管先に置いても中身は読まれません。
手元の PC で中身を取り出したい場合は、GnuPG (`gpg`) に秘密鍵を取り込めば `gpg --decrypt orbit-latest.dump.gpg > orbit-latest.dump` で開けます。

サーバーを作り直すときは、手順 2 から 4 を行ったあと、控えておいた `deploy/.env` を置き、`restore.sh` で DB を戻します
(証明書は新しく作られるので、手順 5 の証明書の置き換えも行います)。

## 10. 設定 (環境変数) の一覧

`deploy/.env` に書くものです。変更したら `docker compose up -d` で反映します (`DOMAIN` を変えたときは `docker compose up -d --build`)。

| 名前 | 必須 | 内容 |
| --- | --- | --- |
| `DOMAIN` | ○ | 公開するドメイン (`https://` は付けない)。Web にも埋め込まれる |
| `COMPOSE_FILE` | ○ | 公開のしかた。`compose.yml:compose.relay.yml` (別のサーバーから HTTPS で逆プロキシ)、`compose.yml:compose.proxy.yml` (同じサーバーの Apache から逆プロキシ)、`compose.yml:compose.caddy.yml` (Caddy が直接公開) のどれか。`setup.sh` の 2 つ目の引数で決まる |
| `LOCAL_BIND` | | 逆プロキシの場合に web が待ち受けるアドレス。`0.0.0.0` (別のサーバーから繋ぐ) か `127.0.0.1` (同じサーバーの Apache から繋ぐ。既定) |
| `LOCAL_PORT` | | 逆プロキシの場合に web が待ち受けるポート。既定は 18080 |
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
| `FCM_SERVICE_ACCOUNT` | | Android アプリへの新着メールの通知 (FCM) に使う、Firebase のサービスアカウントの鍵 (JSON を base64 にした値)。空なら送らない。手順は [android-app.md](android-app.md) |
| `SYSTEM_MAIL_GRAPH_SENDER` | | 利用者へ送るメールを Microsoft 365 (Microsoft Graph) から送るときの、差出人のメールボックス。書くと Graph で送る |
| `SYSTEM_MAIL_GRAPH_TENANT` | | Entra のテナント (ディレクトリ) の ID かドメイン。`SYSTEM_MAIL_GRAPH_SENDER` を書いたら必須 (`common` は不可) |
| `SYSTEM_MAIL_GRAPH_CLIENT_ID` / `SYSTEM_MAIL_GRAPH_CLIENT_SECRET` | | 送信専用のアプリ登録を使うときだけ。既定は `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` |
| `SYSTEM_MAIL_HOST` | | 利用者へ送るメール (パスワードの再設定、メールアドレスの変更の確認) の送信用 SMTP サーバー (Microsoft Graph を使わないとき)。どちらも空なら、この 2 つは使えない |
| `SYSTEM_MAIL_PORT` | | 既定は 587 (STARTTLS)。465 なら最初から TLS |
| `SYSTEM_MAIL_USER` / `SYSTEM_MAIL_PASSWORD` | | SMTP サーバーにログインする名前とパスワード |
| `SYSTEM_MAIL_FROM` | | 差出人 (`Orbit <no-reply@example.com>` の形でもよい)。`SYSTEM_MAIL_HOST` を書いたら必須 |
| `SYSTEM_MAIL_SECURE` | | `true` なら、ポートに関係なく最初から TLS で繋ぐ。ふつうは不要 |
| `PASSKEY_RP_ID` | | パスキーを結び付けるドメイン。既定は `DOMAIN`。変えると登録済みのパスキーは使えなくなる |
| `EXTRA_ALLOWED_ORIGINS` | | Web 以外から API を使うときに許可するオリジン (カンマ区切り)。スマホアプリとデスクトップ版のオリジンは最初から許可しているので、足す必要はない |
| `BACKUP_HOUR` | | バックアップを取る時刻 (0〜23)。既定は 4 |
| `BACKUP_KEEP_DAYS` | | バックアップを残す日数。既定は 14 |
| `BACKUP_PUBLIC_KEY` | | バックアップを暗号化する公開鍵 (`backup-key.sh` が書き込む)。空なら暗号化せずに書き出す |
| `TZ` | | ログやバックアップの時刻の基準。既定は `Asia/Tokyo` |
| `ORBIT_UPDATE_CHANNEL` | | 追う版。`stable` (正式版、既定)、`beta` (試験版も)、`edge` (main の最新)。[updates.md](updates.md) |
| `ORBIT_UPDATE_VERSION` | | 版を固定する (例 `1.2.0`)。書くとチャネルより優先する |
| `ORBIT_SERVER_AUTO_UPDATE` | | `true` なら、`deploy/auto-update.sh install` で入れたタイマーで毎日更新する。既定は `false` |
| `ORBIT_UPDATE_TIME` | | 自動更新の時刻 (`HH:MM`)。既定は `04:30`。変えたら `auto-update.sh install` をやり直す |
| `ORBIT_APP_UPDATE` | | デスクトップ版の本体の更新。`auto` (既定)、`notify` (知らせるだけ)、`off` (配らない)。スマホアプリはストアで更新する |
| `ORBIT_RELEASES_REPO` / `ORBIT_RELEASES_TOKEN` | | デスクトップ版のファイルを取り込むリポジトリ (既定は git の origin) と、非公開のときの読み取り用トークン |

次の値は `DOMAIN` などから `deploy/compose.yml` が決めるので、`deploy/.env` に書く必要はありません (書いても上書きされます)。

| 名前 | 本番での値 |
| --- | --- |
| `DATABASE_URL` | `postgres://orbit:<POSTGRES_PASSWORD>@postgres:5432/orbit` |
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
cd /opt/orbit/deploy
docker compose ps                    # 各サービスの状態
docker compose logs --tail=100 api   # web / api / worker / migrate / postgres / backup
docker compose restart worker        # 1 つだけ再起動
```

Linode 側のエラーは、Linode のサーバーの `/var/log/httpd/` (設定で指定したログ) に出ます。

| 症状 | 確認すること |
| --- | --- |
| 503 Service Unavailable | Oracle Cloud でコンテナが動いているか (`docker compose ps`、手順 3 の `curl`)。動いているなら、Linode から 18080 番に届くか (手順 4 の `curl`) |
| 500 Internal Server Error (Linode のログに `Error during SSL Handshake with remote server`) | Linode に置いた `/etc/httpd/conf/orbit-relay.crt` が、Oracle Cloud の `deploy/certs/relay.crt` と同じ内容か。証明書を作り直したあとは置き換えが要る |
| 400 `Client sent an HTTP request to an HTTPS server` | Linode の設定の `ProxyPass` の向き先が `http://` のままになっている。`https://` に直す |
| Cloudflare のエラー画面 (52x) が出る | Cloudflare の DNS の向き先が Linode になっているか。Linode の Apache が動いているか |
| 既存のサイトの画面が出る | Linode の設定の `ServerName` と向き先のポート (18080) が合っているか |
| 添付ファイルを上げると 413 になる | Linode の設定に `LimitRequestBody 52428800` があるか |
| `api` が起動しない | `docker compose logs migrate api`。`deploy/.env` の値が空でないか |
| ログインできない | 利用者を作ったか (手順 3)。パスワードは 12 文字以上 |
| Microsoft / Google のログインで戻ってこられない | リダイレクト URI が `https://<DOMAIN>/oauth/microsoft` (`/oauth/google`) と完全に一致しているか |
| 新着の反映が遅い、しばらくすると止まる | Linode の設定の `ProxyPass` に `flushpackets=on` と `timeout=120` が付いているか。Microsoft のアカウントなら、ワーカーのログに変更通知の購読の失敗が出ていないか |
| ディスクが足りない | `docker system df` で内訳を確認し、`docker builder prune` で古いビルドの残りを消す |

元に戻す (メールアプリを取り除く) ときは、次の順に行います。

```sh
# Oracle Cloud のサーバーで
cd /opt/orbit/deploy && docker compose down          # コンテナを止める (データは残る。消すなら down -v)

# Linode のサーバーで
sudo rm /etc/httpd/conf.d/orbit.example.com.conf
sudo apachectl configtest && sudo systemctl reload httpd
```

あわせて、セキュリティ・リストの 18080 番のルールと、Cloudflare の DNS のレコードを消します。

### 名前を mail から orbit に変える

2026-11-23 までに動かし始めたサーバーは、置き場所が `/opt/mail`、Compose のプロジェクト名・DB のユーザー名・DB 名が
`mail` になっています。その後のコードではこれらが `orbit` なので、更新の前に 1 度だけ移行が要ります
(移行しないまま `deploy.sh` を実行しても、何も変えずに止まります)。新しく入れるサーバーでは不要です。

**移行が済むまで、`deploy.sh` は実行しないでください。** サーバーに残っている古い `deploy.sh` は、新しいコードを取ってきても
古い中身のまま動くので、新しい名前の空の DB で起動してしまいます (古いデータは消えませんが、画面は空に見えます)。
GitHub Actions で自動更新している場合は、移行が済むまでリポジトリの変数 `DEPLOY_ENABLED` を `false` にしておきます。
もし先に動かしてしまっても、下の手順をそのまま行えば古いデータに戻ります。

移行の間 (DB の大きさによりますが、数分) はサービスが止まります。データを新しい名前のボリュームへ写すので、
DB と添付の合計と同じだけの空きが要ります (`docker system df -v` の「Local Volumes」で大きさを確かめられます)。

```sh
# 1. 置き場所の名前を変える (動かしたままで構いません)
sudo mv /opt/mail /opt/orbit
cd /opt/orbit

# 2. GitHub のリポジトリ名を変えたあとなら、取得元を新しい名前にする (今の値は git remote -v で見られます)
git remote set-url origin "$(git remote get-url origin | sed 's#/Mail\(\.git\)\{0,1\}$#/Orbit.git#')"

# 3. 最新のコードにする
git fetch --prune origin main
git checkout --detach origin/main

# 4. 移行する (バックアップ → 停止 → データを写す → DB の名前を変える → 起動、の順に進みます)
bash deploy/rename-to-orbit.sh
```

「移行しました。」と出たら、ブラウザーで開いてメールが見えることを確かめます。あわせて、次も直します。

- GitHub Actions で自動更新している場合は、`~/.ssh/authorized_keys` の `command="bash /opt/mail/deploy/deploy.sh …"` を
  `/opt/orbit/deploy/deploy.sh` に書き換えます (直すまで、自動更新は失敗します)。
- バックアップをサーバーの外へ写す仕組み (cron など) を自分で組んでいる場合は、`/opt/orbit/deploy/backups/` と
  `orbit-<日時>.dump.gpg` に合わせます。古い名前の `mail-*` のバックアップは、これまでどおり 14 日で消えます。
- 移行の直前に取った `deploy/backups/before-rename-<日時>.dump` (バックアップのコンテナが止まっていた場合はホームディレクトリ) は暗号化されていません。確かめ終わったら消します
  (`sudo rm /opt/orbit/deploy/backups/before-rename-*.dump`)。
- 古いデータは残してあります。問題が無いことを確かめたあと、スクリプトが最後に表示したコマンド
  (`docker volume rm mail_postgres-data mail_attachments` など) で消せます。

Linode の Apache の設定、Cloudflare、Microsoft と Google のリダイレクト URI は、ドメインとポートが変わらないので
そのままで動きます。`deploy/.env` も書き換えは要りません。

うまくいかなかったときは、古いデータが残っている間なら元に戻せます (移行のあとに届いたメールは、戻したあとに
もう一度同期されます)。

```sh
cd /opt/orbit/deploy
docker compose down
git checkout --detach 957dd9e    # 名前を変える前の最後のコミット
docker compose up -d --build
```

### Linode との間を HTTP で動かしていた場合に、HTTPS へ切り替える

以前の手順 (`http://<Oracle Cloud のアドレス>:18080/` へ中継) で動かしている場合は、次の順に切り替えます。
途中の数分間は画面や API に繋がらなくなります。

```sh
# 1. Oracle Cloud のサーバーで: 証明書を作り、HTTPS で待ち受けるように切り替える
bash /opt/orbit/deploy/deploy.sh    # 最新に更新する (GitHub Actions で自動更新している場合は不要)
cd /opt/orbit && bash deploy/setup.sh orbit.example.com relay
cd deploy && docker compose up -d
curl -s --cacert certs/relay.crt --resolve orbit.example.com:18080:127.0.0.1 https://orbit.example.com:18080/healthz
cat certs/relay.crt

# 2. Linode のサーバーで: 手順 5 のとおり証明書を /etc/httpd/conf/orbit-relay.crt に置き、
#    設定の ProxyPass / ProxyPassReverse を https:// にして、SSLProxy で始まる 7 行を足す
sudo apachectl configtest && sudo systemctl reload httpd
```

セキュリティ・リストのルール (18080 番) は、そのままで構いません。

### 証明書を作り直す

Linode との間の証明書の期限は 10 年です。期限が近づいたときや、秘密鍵 (`deploy/certs/relay.key`) が漏れたおそれがあるときは、作り直します。

```sh
# Oracle Cloud のサーバーで
cd /opt/orbit/deploy
rm -r certs && bash setup.sh
docker compose restart web
cat certs/relay.crt    # Linode の /etc/httpd/conf/orbit-relay.crt をこの内容で置き換え、sudo systemctl reload httpd
```

Linode の側を置き換えるまでの間は、繋がらなくなります (500 が返ります)。

## ほかの構成

### 同じサーバーの Apache から繋ぐ

Oracle Cloud のサーバーの Apache (80 番) でドメインを受け、そこからメールアプリへ渡す形です。
`setup.sh` を `apache` で実行すると、web は 127.0.0.1:18080 だけで待ち受け、外からは直接届きません
(サーバーの中だけの通信なので、ここは HTTP のままです)。

```sh
bash deploy/setup.sh orbit.example.com apache
```

**先に `sudo httpd -S` を確認してください。** `*:80` の VirtualHost が 1 つも無い場合 (`Main DocumentRoot` などしか出ない場合)、
Apache は VirtualHost が 1 つでもあると 80 番に来たすべての要求を VirtualHost に渡すようになるため、
そのままメールアプリの設定を足すと、既存のサイトまでメールアプリに繋がってしまいます。
その場合は、既存のサイトを受ける空の VirtualHost を先頭に置きます。ただし、全体の設定にある `RewriteRule` は
VirtualHost には引き継がれず、全体の設定にある `ProxyPass` はメールアプリ側にも効くので、全体の設定の内容を確かめてから行ってください。

```sh
printf '<VirtualHost *:80>\n</VirtualHost>\n' | sudo tee /etc/httpd/conf.d/000-default.conf
```

手前に HTTPS を受けるサーバーがある場合が A、この Apache が直接 HTTPS を受ける場合が B です。

#### 準備

Apache からコンテナへ繋ぐことを SELinux に許可します (`getenforce` が `Enforcing` の場合)。

```sh
sudo setsebool -P httpd_can_network_connect 1
```

B (このサーバーで直接 HTTPS を受ける) の場合だけ、HTTPS 用のモジュールと certbot も入れます。

```sh
sudo dnf -y install epel-release
sudo dnf -y install mod_ssl certbot python3-certbot-apache
```

#### サイトを追加する

設定の見本をドメインに合わせて置き、文法を確かめてから読み込み直します。

```sh
DOMAIN=orbit.example.com    # 自分のドメインに置き換える
sed "s/orbit\.example\.com/$DOMAIN/g" /opt/orbit/deploy/apache/orbit.conf | sudo tee /etc/httpd/conf.d/orbit.conf
sudo apachectl configtest
sudo systemctl reload httpd
sudo httpd -S
```

- `configtest` が `Syntax OK` 以外を返したら、読み込み直さずに `sudo rm /etc/httpd/conf.d/orbit.conf` で元に戻せます。
- `httpd -S` で、既存のサイトがこれまでどおり並び、そこに `orbit.example.com` が加わっていることを確認します。
- サーバーの中から、ドメイン名で振り分けられることを確認できます。

  ```sh
  curl -s -H "Host: $DOMAIN" http://127.0.0.1/healthz    # {"status":"ok"} が返る
  ```

**A の場合**は、これで完了です。ブラウザーで `https://orbit.example.com` を開き、作った利用者でログインできることを確認します。
Cloudflare が HTTPS を受けるので、このサーバーでは証明書を取りません。

**B の場合**は、続けて証明書を取ります。certbot が HTTPS 用の設定 (`/etc/httpd/conf.d/orbit-le-ssl.conf`) を作り、HTTP から HTTPS への転送も設定します。

```sh
sudo certbot --apache -d orbit.example.com
sudo systemctl enable --now certbot-renew.timer    # 証明書の自動更新
```

途中で連絡先のメールアドレスと利用規約への同意を聞かれます。
ブラウザーで `https://orbit.example.com` を開き、ログインできれば完了です。


#### B の場合の DNS とポート

**DNS**: ドメインの DNS に、サーバーのパブリック IP アドレスを指す A レコードを追加します。

**Oracle Cloud 側 (セキュリティ・リスト)**: コンソールでインスタンスの詳細 → サブネット → セキュリティ・リスト →
「イングレス・ルールの追加」を開き、ソース `0.0.0.0/0`、TCP、宛先ポート 443 を追加します。

**サーバー側 (firewalld)**: `sudo firewall-cmd --state` が `running` の場合だけ実行します。

```sh
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```


### Caddy が直接公開する

80 番と 443 番をほかに使っていないサーバー (新しく作ったインスタンスなど) では、Caddy に公開と証明書の取得を任せられます。
手順 4 から 6 は不要になり、手順 3 の `setup.sh` を次のように実行します。

```sh
bash deploy/setup.sh orbit.example.com caddy
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
