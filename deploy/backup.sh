#!/usr/bin/env bash
# DB のバックアップ。compose の backup サービスの中で動く。
#   引数なし: 毎日 BACKUP_HOUR 時に取り続ける
#   once:     今すぐ 1 回だけ取る (docker compose run --rm backup once)
# 書き出すのは pg_dump の独自形式 (圧縮済み)。戻すときは deploy/restore.sh を使う。
# BACKUP_PUBLIC_KEY (deploy/backup-key.sh が作る公開鍵) があれば、OpenPGP (gpg) で暗号化して
# orbit-<日時>.dump.gpg として書き出す。戻すには対になる秘密鍵が要り、それはサーバーには置かない。
# バックアップにはメールの内容がそのまま入るので、サーバーや写したファイルを読まれても中身が分からないようにするため。
set -euo pipefail
# 暗号化していない場合に備えて、ほかの利用者からは読めないようにしておく。
umask 077

BACKUP_DIR=/backups
BACKUP_HOUR="${BACKUP_HOUR:-4}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
BACKUP_PUBLIC_KEY="${BACKUP_PUBLIC_KEY:-}"

# 公開鍵を gpg が読める形 (ファイル) にする。鍵束には入れず、毎回このファイルを宛先に指定する。
recipient=""
if [ -n "$BACKUP_PUBLIC_KEY" ]; then
  GNUPGHOME="$(mktemp -d)"
  export GNUPGHOME
  recipient="$GNUPGHOME/backup-public-key.gpg"
  if ! printf '%s' "$BACKUP_PUBLIC_KEY" | base64 -d >"$recipient" 2>/dev/null ||
    ! gpg --batch --quiet --show-keys "$recipient" >/dev/null 2>&1; then
    echo "BACKUP_PUBLIC_KEY を公開鍵として読めません。bash deploy/backup-key.sh --renew で作り直してください。" >&2
    exit 1
  fi
fi

dump() {
  if [ -n "$recipient" ]; then
    # pg_dump の独自形式は圧縮済みなので、gpg 側では圧縮しない。
    pg_dump --format=custom |
      gpg --batch --quiet --no-tty --trust-model always --compress-algo none \
        --recipient-file "$recipient" --encrypt --output "$1"
  else
    pg_dump --format=custom --file="$1"
  fi
}

run_backup() {
  local file="$BACKUP_DIR/orbit-$(date +%Y%m%d-%H%M%S).dump"
  if [ -n "$recipient" ]; then
    file="$file.gpg"
  fi
  # 途中で失敗した書きかけを残さないよう、別名で書いてから名前を変える。
  rm -f "$file.tmp"
  if dump "$file.tmp"; then
    mv "$file.tmp" "$file"
    echo "$(date '+%F %T') バックアップを取りました: $file ($(du -h "$file" | cut -f1))"
    if [ -z "$recipient" ]; then
      echo "$(date '+%F %T') このバックアップは暗号化されていません。bash deploy/backup-key.sh で鍵を作ると、暗号化して書き出します。"
    fi
  else
    rm -f "$file.tmp"
    echo "$(date '+%F %T') バックアップに失敗しました。" >&2
    return 1
  fi
  # mail-* は、名前を orbit に変える前 (2026-11 まで) に取ったバックアップ。同じ日数で消す。
  find "$BACKUP_DIR" \( -name 'orbit-*.dump' -o -name 'orbit-*.dump.gpg' \
    -o -name 'mail-*.dump' -o -name 'mail-*.dump.gpg' \) \
    -mtime "+$BACKUP_KEEP_DAYS" -delete
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
