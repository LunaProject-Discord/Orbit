#!/bin/sh
# DB のバックアップ。compose の backup サービスの中で動く。
#   引数なし: 毎日 BACKUP_HOUR 時に取り続ける
#   once:     今すぐ 1 回だけ取る (docker compose run --rm backup once)
# 書き出すのは pg_dump の独自形式 (圧縮済み)。戻すときは deploy/restore.sh を使う。
set -eu
# バックアップにはメールの内容が入るので、ほかの利用者から読めないようにする。
umask 077

BACKUP_DIR=/backups
BACKUP_HOUR="${BACKUP_HOUR:-4}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

run_backup() {
  file="$BACKUP_DIR/mail-$(date +%Y%m%d-%H%M%S).dump"
  # 途中で失敗した書きかけを残さないよう、別名で書いてから名前を変える。
  if pg_dump --format=custom --file="$file.tmp"; then
    mv "$file.tmp" "$file"
    echo "$(date '+%F %T') バックアップを取りました: $file ($(du -h "$file" | cut -f1))"
  else
    rm -f "$file.tmp"
    echo "$(date '+%F %T') バックアップに失敗しました。" >&2
    return 1
  fi
  find "$BACKUP_DIR" -name 'mail-*.dump' -mtime "+$BACKUP_KEEP_DAYS" -delete
}

mkdir -p "$BACKUP_DIR"

if [ "${1:-}" = "once" ]; then
  run_backup
  exit
fi

echo "毎日 ${BACKUP_HOUR} 時にバックアップを取ります (${BACKUP_KEEP_DAYS} 日より古いものは消します)。"
while true; do
  now=$(date +%s)
  next=$(date -d "today ${BACKUP_HOUR}:00" +%s)
  if [ "$next" -le "$now" ]; then
    next=$(date -d "tomorrow ${BACKUP_HOUR}:00" +%s)
  fi
  sleep $((next - now))
  # 1 回の失敗で止まらず、翌日また試す。
  run_backup || true
  sleep 60
done
