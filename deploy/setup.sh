#!/usr/bin/env bash
# 本番用の設定ファイル deploy/.env を用意する。
#   bash deploy/setup.sh mail.example.com relay    別のサーバー (中継用のサーバー) から直接繋ぐ場合
#                                                  (サーバーの間を HTTPS にする証明書も deploy/certs/ に作る)
#   bash deploy/setup.sh mail.example.com apache   同じサーバーの Web サーバー (Apache など) から繋ぐ場合 (省略時)
#   bash deploy/setup.sh mail.example.com caddy    Caddy が 80 / 443 番で直接公開する場合
# 無ければ .env.example から作り、空の秘密の値を乱数で埋める。
# 既に値が入っている項目は変更しない (鍵を作り直すと保存済みの認証情報を復号できなくなるため)。
set -euo pipefail

cd "$(dirname "$0")"
domain="${1:-}"
mode="${2:-}"
case "$mode" in
"" | relay | apache | caddy) ;;
*)
  echo "2 つ目の引数は relay、apache、caddy のどれかにしてください。" >&2
  exit 1
  ;;
esac

if [ ! -f .env ]; then
  if [ -z "$domain" ]; then
    echo "使い方: bash deploy/setup.sh <公開するドメイン> [relay|apache|caddy]" >&2
    exit 1
  fi
  cp .env.example .env
  chmod 600 .env
  echo "deploy/.env を作成しました。"
else
  echo "deploy/.env は既にあるため、空の項目だけを埋めます。"
fi

# 空の項目だけを埋める。値に / や + が入っても壊れないよう、sed ではなく awk で書き換える。
fill() {
  local key="$1" value="$2"
  if grep -q "^${key}=[[:space:]]*$" .env; then
    awk -v key="$key" -v value="$value" \
      '$0 ~ "^" key "=[[:space:]]*$" { print key "=" value; next } { print }' \
      .env >.env.tmp
    cat .env.tmp >.env
    rm .env.tmp
    echo "生成した値: $key"
  fi
}

if [ -n "$domain" ]; then
  domain="${domain#https://}"
  domain="${domain%%/*}"
  awk -v value="$domain" '/^DOMAIN=/ { print "DOMAIN=" value; next } { print }' \
    .env >.env.tmp
  cat .env.tmp >.env
  rm .env.tmp
  echo "ドメイン: $domain"
fi

# 既にある行は書き換え、無ければ末尾に足す (古い .env.example から作った .env にも対応する)。
set_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    awk -v key="$key" -v value="$value" \
      '$0 ~ "^" key "=" { print key "=" value; next } { print }' .env >.env.tmp
    cat .env.tmp >.env
    rm .env.tmp
  else
    printf '%s=%s\n' "$key" "$value" >>.env
  fi
}

case "$mode" in
relay)
  set_value COMPOSE_FILE compose.yml:compose.relay.yml
  set_value LOCAL_BIND 0.0.0.0
  ;;
apache)
  set_value COMPOSE_FILE compose.yml:compose.proxy.yml
  set_value LOCAL_BIND 127.0.0.1
  ;;
caddy)
  set_value COMPOSE_FILE compose.yml:compose.caddy.yml
  ;;
esac
if [ -n "$mode" ]; then
  echo "公開のしかた: $mode"
fi

# DB のパスワードは接続 URL に入るので、記号を含まない 16 進数にする。
fill POSTGRES_PASSWORD "$(openssl rand -hex 24)"
fill BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
fill CREDENTIALS_ENCRYPTION_KEY "$(openssl rand -base64 32)"

# 新着メールの通知 (Web Push) に使う VAPID の鍵の組 (P-256)。公開鍵と秘密鍵は対なので、
# どちらかが空なら両方を作り直す。形式は pnpm env:init と同じ (鍵そのものを base64url にしたもの)。
if grep -Eq "^VAPID_(PUBLIC|PRIVATE)_KEY=[[:space:]]*$" .env; then
  base64url() { base64 | tr -d '=\n' | tr '+/' '-_'; }
  key="$(openssl ecparam -name prime256v1 -genkey -noout)"
  # DER の末尾 65 バイトが公開鍵、先頭から 8 バイト目以降の 32 バイトが秘密鍵。
  vapid_public="$(printf '%s\n' "$key" | openssl ec -pubout -outform DER 2>/dev/null | tail -c 65 | base64url)"
  vapid_private="$(printf '%s\n' "$key" | openssl ec -outform DER 2>/dev/null | tail -c +8 | head -c 32 | base64url)"
  awk -v pub="$vapid_public" -v priv="$vapid_private" '
    /^VAPID_PUBLIC_KEY=/ { print "VAPID_PUBLIC_KEY=" pub; next }
    /^VAPID_PRIVATE_KEY=/ { print "VAPID_PRIVATE_KEY=" priv; next }
    { print }' .env >.env.tmp
  cat .env.tmp >.env
  rm .env.tmp
  echo "生成した値: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY"
fi

# 中継用のサーバーとの間を HTTPS にするための証明書 (自己署名、10 年)。中継用のサーバーには relay.crt を置き、
# その証明書の相手にだけ繋ぐようにする。作り直すと中継用のサーバーの側も置き換えが要るので、既にあれば触らない
# (作り直すときは deploy/certs/ を消してから、もう一度実行する)。
if grep -q '^COMPOSE_FILE=.*compose\.relay\.yml' .env && [ ! -s certs/relay.crt ]; then
  relay_domain="$(sed -n 's/^DOMAIN=//p' .env | head -n 1)"
  mkdir -p certs
  (
    umask 077
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
      -days 3650 -subj "/CN=$relay_domain" \
      -addext "subjectAltName=DNS:$relay_domain" \
      -addext "basicConstraints=critical,CA:FALSE" \
      -keyout certs/relay.key -out certs/relay.crt 2>/dev/null
  )
  chmod 644 certs/relay.crt
  echo "生成した証明書: deploy/certs/relay.crt (中継用のサーバーに置く。期限は 10 年後)"
fi

echo
if grep -q "^BACKUP_PUBLIC_KEY=[[:space:]]*$" .env || ! grep -q "^BACKUP_PUBLIC_KEY=" .env; then
  echo "バックアップは、まだ暗号化されません。bash deploy/backup-key.sh で鍵を作ると、暗号化して書き出すようになります。"
fi
echo "CREDENTIALS_ENCRYPTION_KEY は、サーバーの外 (パスワード管理ソフトなど) にも控えてください。"
echo "失うと、バックアップから DB を戻してもメールアカウントの認証情報を復号できません。"
