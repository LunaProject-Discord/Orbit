#!/usr/bin/env bash
# バックアップを暗号化する鍵の組を作る。
#   bash deploy/backup-key.sh            初めて作る
#   bash deploy/backup-key.sh --renew    作り直す (前の秘密鍵は、それまでのバックアップを戻すのに引き続き必要)
# 公開鍵は deploy/.env の BACKUP_PUBLIC_KEY に書き込み、以後のバックアップはこの鍵で暗号化される。
# 秘密鍵は画面に 1 度だけ表示し、サーバーには残さない (サーバーを読まれても、バックアップを開けないようにするため)。
# 表示された秘密鍵は、パスワード管理ソフトなどサーバーの外に必ず控えること。失うと、暗号化したバックアップは戻せない。
set -euo pipefail

cd "$(dirname "$0")"
if [ ! -f .env ]; then
  echo "deploy/.env がありません。先に bash deploy/setup.sh <ドメイン> を実行してください。" >&2
  exit 1
fi
if grep -q '^BACKUP_PUBLIC_KEY=[^[:space:]]' .env && [ "${1:-}" != "--renew" ]; then
  echo "バックアップの鍵は既にあります。作り直す場合は bash deploy/backup-key.sh --renew を実行してください。" >&2
  echo "(作り直しても、それまでのバックアップを戻すには前の秘密鍵が要ります。)" >&2
  exit 1
fi

domain="$(sed -n 's/^DOMAIN=//p' .env | head -n 1)"

# gpg は backup サービスのイメージ (postgres) に入っているものを使う。鍵束はコンテナの中の一時的な場所に作り、
# コンテナと一緒に消える。1 行目に公開鍵 (base64)、2 行目以降に秘密鍵 (テキスト形式) を出す。
output="$(
  docker compose run --rm --no-deps -T --entrypoint bash -e KEY_NAME="Orbit backup ($domain)" backup -c '
    set -euo pipefail
    GNUPGHOME="$(mktemp -d)"
    export GNUPGHOME
    gpg --batch --quiet --pinentry-mode loopback --passphrase "" \
      --quick-generate-key "$KEY_NAME" default default never 2>/dev/null
    gpg --batch --quiet --export | base64 -w 0
    echo
    gpg --batch --quiet --pinentry-mode loopback --passphrase "" --armor --export-secret-keys
  '
)"
public_key="$(printf '%s\n' "$output" | head -n 1)"
secret_key="$(printf '%s\n' "$output" | tail -n +2)"
case "$secret_key" in
*"BEGIN PGP PRIVATE KEY BLOCK"*"END PGP PRIVATE KEY BLOCK"*) ;;
*)
  echo "鍵を作れませんでした。" >&2
  exit 1
  ;;
esac

# 既にある行は書き換え、無ければ末尾に足す (古い .env.example から作った .env にも対応する)。
if grep -q '^BACKUP_PUBLIC_KEY=' .env; then
  awk -v value="$public_key" \
    '/^BACKUP_PUBLIC_KEY=/ { print "BACKUP_PUBLIC_KEY=" value; next } { print }' .env >.env.tmp
  cat .env.tmp >.env
  rm .env.tmp
else
  printf 'BACKUP_PUBLIC_KEY=%s\n' "$public_key" >>.env
fi

# 動いている backup サービスに新しい鍵を渡す (動いていなければ何もしない)。
if [ -n "$(docker compose ps -q backup 2>/dev/null)" ]; then
  docker compose up -d --no-deps backup >/dev/null 2>&1 || true
fi

# 秘密鍵は標準出力へ、説明は標準エラー出力へ出す (> ファイル名 で秘密鍵だけを保存できる)。
{
  echo "公開鍵を deploy/.env の BACKUP_PUBLIC_KEY に書き込みました。次のバックアップから暗号化されます。"
  echo
  echo "下の秘密鍵 (BEGIN の行から END の行まで) を、サーバーの外 (パスワード管理ソフトなど) に控えてください。"
  echo "サーバーには保存していません。失うと、暗号化したバックアップは戻せません。"
  echo
} >&2
printf '%s\n' "$secret_key"
