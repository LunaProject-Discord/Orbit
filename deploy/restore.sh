#!/usr/bin/env bash
# バックアップから DB を戻す。今の DB の中身は置き換わる。
#   bash deploy/restore.sh deploy/backups/mail-20261122-040000.dump
set -euo pipefail

if [ -z "${1:-}" ] || [ ! -f "$1" ]; then
  echo "使い方: bash deploy/restore.sh <バックアップのファイル>" >&2
  exit 1
fi
file="$(realpath "$1")"
cd "$(dirname "$0")"

read -r -p "今の DB の中身を $file の内容で置き換えます。よろしいですか? (yes と入力): " answer
[ "$answer" = "yes" ] || {
  echo "中止しました。"
  exit 1
}

# 戻している間に書き込まれないよう、DB を使うものを止める。
docker compose stop api worker
docker compose up -d --wait postgres
# 途中で失敗したら全体を取り消す (--single-transaction) ので、中途半端な状態にはならない。
docker compose exec -T postgres pg_restore --clean --if-exists --no-owner \
  --single-transaction -U mail -d mail <"$file"
docker compose up -d
echo "戻しました。"
