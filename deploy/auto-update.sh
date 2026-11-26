#!/usr/bin/env bash
# サーバーの自動更新のタイマー (systemd) を入れる・外す (docs/updates.md)。root で実行する。
#   sudo bash deploy/auto-update.sh install   入れる (毎日 ORBIT_UPDATE_TIME に deploy/update.sh を動かす)
#   sudo bash deploy/auto-update.sh remove    外す
#   bash deploy/auto-update.sh status         状態と直近のログを表示する
# 更新するかどうか、どの版にするかは deploy/.env の ORBIT_* で決める。タイマーを入れたまま
# ORBIT_SERVER_AUTO_UPDATE=false にすれば、何もしなくなる。
set -euo pipefail

UNIT=orbit-update

main() {
  local action="${1:-}"
  local root
  root="$(cd "$(dirname "$0")/.." && pwd)"

  case "$action" in
  install)
    if [ "$(id -u)" -ne 0 ]; then
      echo "root で実行してください (sudo bash deploy/auto-update.sh install)。" >&2
      exit 1
    fi
    # リポジトリの持ち主として動かす (docker を使える利用者であること)。
    local owner when
    owner="$(stat -c '%U' "$root")"
    when="$(sed -n 's/^ORBIT_UPDATE_TIME=[[:space:]]*//p' "$root/deploy/.env" 2>/dev/null | tail -n 1 | tr -d '[:space:]')"
    when="${when:-04:30}"
    if ! [[ "$when" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
      echo "ORBIT_UPDATE_TIME は HH:MM (例 04:30) で書いてください: $when" >&2
      exit 1
    fi
    cat >/etc/systemd/system/$UNIT.service <<UNIT_EOF
[Unit]
Description=Orbit のサーバーの自動更新 (deploy/update.sh)
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
User=$owner
WorkingDirectory=$root
ExecStart=/usr/bin/env bash $root/deploy/update.sh
UNIT_EOF
    cat >/etc/systemd/system/$UNIT.timer <<UNIT_EOF
[Unit]
Description=Orbit のサーバーの自動更新 (毎日 $when)

[Timer]
OnCalendar=*-*-* $when:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
UNIT_EOF
    systemctl daemon-reload
    systemctl enable --now $UNIT.timer
    echo "自動更新のタイマーを入れました (毎日 $when ごろ、利用者 $owner で実行)。"
    echo "ORBIT_SERVER_AUTO_UPDATE=true でなければ、タイマーが動いても更新はしません。"
    systemctl list-timers $UNIT.timer --no-pager || true
    ;;
  remove)
    if [ "$(id -u)" -ne 0 ]; then
      echo "root で実行してください (sudo bash deploy/auto-update.sh remove)。" >&2
      exit 1
    fi
    systemctl disable --now $UNIT.timer 2>/dev/null || true
    rm -f /etc/systemd/system/$UNIT.service /etc/systemd/system/$UNIT.timer
    systemctl daemon-reload
    echo "自動更新のタイマーを外しました。"
    ;;
  status)
    systemctl list-timers $UNIT.timer --no-pager || true
    journalctl -u $UNIT.service -n 30 --no-pager 2>/dev/null || true
    ;;
  *)
    echo "使い方: bash deploy/auto-update.sh install|remove|status" >&2
    exit 1
    ;;
  esac
}

main "$@"
