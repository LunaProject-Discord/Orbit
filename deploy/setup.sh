#!/usr/bin/env bash
# 本番用の設定ファイル deploy/.env を用意する。
#   bash deploy/setup.sh mail.example.com
# 無ければ .env.example から作り、空の秘密の値を乱数で埋める。
# 既に値が入っている項目は変更しない (鍵を作り直すと保存済みの認証情報を復号できなくなるため)。
set -euo pipefail

cd "$(dirname "$0")"
domain="${1:-}"

if [ ! -f .env ]; then
  if [ -z "$domain" ]; then
    echo "使い方: bash deploy/setup.sh <公開するドメイン>" >&2
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

# DB のパスワードは接続 URL に入るので、記号を含まない 16 進数にする。
fill POSTGRES_PASSWORD "$(openssl rand -hex 24)"
fill BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
fill CREDENTIALS_ENCRYPTION_KEY "$(openssl rand -base64 32)"

echo
echo "CREDENTIALS_ENCRYPTION_KEY は、サーバーの外 (パスワード管理ソフトなど) にも控えてください。"
echo "失うと、バックアップから DB を戻してもメールアカウントの認証情報を復号できません。"
