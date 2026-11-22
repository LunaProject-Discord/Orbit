#!/usr/bin/env bash
# バックアップから DB を戻す。今の DB の中身は置き換わる。
#   bash deploy/restore.sh deploy/backups/mail-20261122-040000.dump
#   bash deploy/restore.sh deploy/backups/mail-20261122-040000.dump.gpg [秘密鍵のファイル]
# 暗号化したバックアップ (.gpg) を戻すには、deploy/backup-key.sh が表示した秘密鍵が要る。
# ファイルを指定しなければ、貼り付けるよう求める。秘密鍵は戻す間だけ一時的な場所に置き、終わったら消す。
set -euo pipefail

if [ -z "${1:-}" ] || [ ! -f "$1" ]; then
  echo "使い方: bash deploy/restore.sh <バックアップのファイル> [秘密鍵のファイル]" >&2
  exit 1
fi
file="$(realpath "$1")"
key_source="${2:-}"
if [ -n "$key_source" ]; then
  if [ ! -f "$key_source" ]; then
    echo "秘密鍵のファイルがありません: $key_source" >&2
    exit 1
  fi
  key_source="$(realpath "$key_source")"
fi
cd "$(dirname "$0")"

work=""
cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}
trap cleanup EXIT

# バックアップの中身 (pg_dump の独自形式) を標準出力へ出す。
if [[ "$file" == *.gpg ]]; then
  work="$(mktemp -d)"
  chmod 700 "$work"
  if [ -n "$key_source" ]; then
    install -m 600 "$key_source" "$work/secret-key.asc"
  else
    echo "秘密鍵を貼り付けてください (-----BEGIN PGP PRIVATE KEY BLOCK----- の行から END の行まで):" >&2
    : >"$work/secret-key.asc"
    chmod 600 "$work/secret-key.asc"
    while IFS= read -r line; do
      printf '%s\n' "$line" >>"$work/secret-key.asc"
      case "$line" in *"END PGP PRIVATE KEY BLOCK"*) break ;; esac
    done
  fi
  # gpg は backup サービスのイメージに入っているものを使う。鍵束はコンテナの中の一時的な場所で、コンテナと一緒に消える。
  # 末尾の z は SELinux が有効なホスト (AlmaLinux など) でコンテナから読めるようにする指定。
  # 標準入力は渡さない (このあとの確認の入力を、コンテナに読み取らせないため)。
  contents() {
    docker compose run --rm --no-deps -T --entrypoint bash </dev/null \
      -v "$work/secret-key.asc:/secret-key.asc:ro,z" -v "$file:/backup.gpg:ro,z" backup -c '
        set -euo pipefail
        GNUPGHOME="$(mktemp -d)"
        export GNUPGHOME
        gpg --batch --quiet --pinentry-mode loopback --passphrase "" --import /secret-key.asc 2>/dev/null
        gpg --batch --quiet --pinentry-mode loopback --passphrase "" --decrypt /backup.gpg 2>/dev/null
      '
  }
else
  contents() { cat "$file"; }
fi

# DB を止める前に、開けるバックアップかを確かめる (秘密鍵の間違いや、壊れたファイルをここで弾く)。
magic="$(contents 2>/dev/null | head -c 5 || true)"
if [ "$magic" != "PGDMP" ]; then
  if [[ "$file" == *.gpg ]]; then
    echo "バックアップを開けません。秘密鍵が、このバックアップを取ったときの鍵と合っているか確かめてください。" >&2
  else
    echo "バックアップのファイルとして読めません: $file" >&2
  fi
  exit 1
fi

read -r -p "今の DB の中身を $file の内容で置き換えます。よろしいですか? (yes と入力): " answer
[ "$answer" = "yes" ] || {
  echo "中止しました。"
  exit 1
}

# 戻している間に書き込まれないよう、DB を使うものを止める。
docker compose stop api worker
docker compose up -d --wait postgres
# 途中で失敗したら全体を取り消す (--single-transaction) ので、中途半端な状態にはならない。
if ! contents | docker compose exec -T postgres pg_restore --clean --if-exists --no-owner \
  --single-transaction -U mail -d mail; then
  docker compose up -d
  echo "戻せませんでした。DB の中身は元のままです。" >&2
  exit 1
fi
docker compose up -d
echo "戻しました。"
