#!/usr/bin/env bash
# 本番用の設定ファイル deploy/.env を用意する。
#   bash deploy/setup.sh mail.example.com          既存の Web サーバー (Apache など) から逆プロキシする場合
#   bash deploy/setup.sh mail.example.com caddy    Caddy が 80 / 443 番で直接公開する場合
# 無ければ .env.example から作り、空の秘密の値を乱数で埋める。
# 既に値が入っている項目は変更しない (鍵を作り直すと保存済みの認証情報を復号できなくなるため)。
set -euo pipefail

cd "$(dirname "$0")"
domain="${1:-}"
mode="${2:-}"
case "$mode" in
"" | apache | caddy) ;;
*)
  echo "2 つ目の引数は apache か caddy にしてください。" >&2
  exit 1
  ;;
esac

if [ ! -f .env ]; then
  if [ -z "$domain" ]; then
    echo "使い方: bash deploy/setup.sh <公開するドメイン> [apache|caddy]" >&2
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

if [ -n "$mode" ]; then
  awk -v value="compose.yml:compose.$mode.yml" \
    '/^COMPOSE_FILE=/ { print "COMPOSE_FILE=" value; next } { print }' \
    .env >.env.tmp
  cat .env.tmp >.env
  rm .env.tmp
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

echo
echo "CREDENTIALS_ENCRYPTION_KEY は、サーバーの外 (パスワード管理ソフトなど) にも控えてください。"
echo "失うと、バックアップから DB を戻してもメールアカウントの認証情報を復号できません。"
