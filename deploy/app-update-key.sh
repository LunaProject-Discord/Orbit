#!/usr/bin/env bash
# アプリ (デスクトップ版、スマホアプリ) の画面の自動更新に使う署名の鍵 (Ed25519) を用意する。
#   bash deploy/app-update-key.sh           無ければ作り、公開鍵を表示する
#   bash deploy/app-update-key.sh --renew   作り直す (アプリを公開鍵ごとビルドし直すまで、画面は更新されなくなる)
# 秘密鍵は deploy/secrets/app-update-signing-key に置き、Web のビルド (Dockerfile) が一覧の署名に使う。
# 表示された公開鍵を、GitHub のリポジトリの変数 APP_UPDATE_PUBLIC_KEY に登録してからアプリをビルドする。
# しくみは docs/app-update.md。
set -euo pipefail

cd "$(dirname "$0")"
key_file=secrets/app-update-signing-key

if [ -s "$key_file" ] && [ "${1:-}" != "--renew" ]; then
  created=false
else
  mkdir -p secrets
  chmod 700 secrets
  umask 077
  openssl genpkey -algorithm ed25519 -outform DER | base64 | tr -d '\n' >"$key_file.tmp"
  mv "$key_file.tmp" "$key_file"
  created=true
fi

# 公開鍵は DER の末尾 32 バイト。
public_key="$(base64 -d "$key_file" | openssl pkey -inform DER -pubout -outform DER | tail -c 32 | base64 | tr -d '\n')"
if [ "$created" = true ]; then
  echo "画面の自動更新の署名の鍵を作りました ($key_file)。"
fi
echo "画面の自動更新の公開鍵 (GitHub の変数 APP_UPDATE_PUBLIC_KEY に登録する): $public_key"
