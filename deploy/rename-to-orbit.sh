#!/usr/bin/env bash
# 名前を mail から orbit に変える前 (2026-11 まで) に動かし始めたサーバーを、新しい名前へ移す。1 度だけ実行する。
#   bash deploy/rename-to-orbit.sh
# 変わるもの:
#   Compose のプロジェクト名   mail → orbit (コンテナとボリュームの名前の頭に付く)
#   ボリューム                 mail_postgres-data → orbit_postgres-data、mail_attachments → orbit_attachments (中身を写す)
#   DB のユーザー名と DB 名    mail → orbit (パスワードはそのまま)
# 写している間はサービスが止まる。古いボリュームは消さずに残すので、うまくいかなければ元に戻せる
# (戻し方は docs/deploy-oracle-cloud.md の「名前を mail から orbit に変える」)。
# 途中で失敗したときは、原因を直してからもう一度実行すればよい (済んだところは飛ばす)。
set -euo pipefail

cd "$(dirname "$0")"
if [ ! -f .env ]; then
  echo "deploy/.env がありません。新しく入れるサーバーでは、このスクリプトは要りません。" >&2
  exit 1
fi

OLD=mail
NEW=orbit
VOLUMES=(postgres-data attachments)

exists() { docker volume inspect "$1" >/dev/null 2>&1; }

if ! exists "${OLD}_postgres-data"; then
  echo "古い名前のデータ (${OLD}_postgres-data) がありません。移すものは無いので、何もしません。"
  exit 0
fi

# 新しい DB が既に新しい名前で動いているなら、移行は済んでいる。
# (写している途中で止まった場合は、目印が無いので下でやり直す。)
marker() { docker run --rm -v "$1:/v" postgres:19 test -e /v/.renamed-to-orbit; }
if exists "${NEW}_postgres-data" && marker "${NEW}_postgres-data"; then
  echo "移行は済んでいます。"
  exit 0
fi

echo "== 1/5 止める前にバックアップを取る"
stamp="$(date +%Y%m%d-%H%M%S)"
if [ "$(docker compose -p "$OLD" ps -q --status running backup 2>/dev/null)" != "" ]; then
  # 暗号化の設定に関わらず、そのままの形で取る (移行が済んだら消してよい)。
  # deploy/backups/ はコンテナが作った場所で、手元の利用者では書けないことがあるので、コンテナの中から書く。
  docker compose -p "$OLD" exec -T backup bash -c \
    "umask 077 && pg_dump --format=custom --file=/backups/before-rename-$stamp.dump"
  echo "取りました: deploy/backups/before-rename-$stamp.dump"
elif [ "$(docker compose -p "$OLD" ps -q --status running postgres 2>/dev/null)" != "" ]; then
  before="$HOME/before-rename-$stamp.dump"
  (umask 077 && docker compose -p "$OLD" exec -T postgres pg_dump --format=custom -U "$OLD" -d "$OLD" >"$before")
  echo "取りました: $before"
else
  echo "古い名前の DB は動いていないので、飛ばします。"
fi

echo "== 2/5 古い名前のコンテナを止める (データは残る)"
docker compose -p "$OLD" down --remove-orphans

echo "== 3/5 データを新しい名前のボリュームへ写す"
for v in "${VOLUMES[@]}"; do
  if ! exists "${OLD}_$v"; then
    continue
  fi
  # 前回の途中で止まった写しかけは消して、最初から写し直す。
  if exists "${NEW}_$v"; then
    docker volume rm "${NEW}_$v" >/dev/null
  fi
  # Compose が自分で作ったボリュームとして扱うよう、同じラベルを付けて作る。
  docker volume create \
    --label "com.docker.compose.project=$NEW" \
    --label "com.docker.compose.volume=$v" \
    "${NEW}_$v" >/dev/null
  docker run --rm -v "${OLD}_$v:/from:ro" -v "${NEW}_$v:/to" postgres:19 \
    bash -c 'cp -a /from/. /to/'
  echo "写しました: ${OLD}_$v → ${NEW}_$v"
done

echo "== 4/5 DB のユーザー名と DB 名を変える"
docker compose up -d postgres
psql_as() {
  local user="$1" db="$2"
  shift 2
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U "$user" -d "$db" "$@"
}
# 起動を待つ (コンテナの中からの接続は、パスワード無しで通る)。
for _ in $(seq 1 60); do
  if psql_as "$OLD" postgres -c "select 1" >/dev/null 2>&1 ||
    psql_as "$NEW" postgres -c "select 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if psql_as "$OLD" postgres -c "select 1" >/dev/null 2>&1; then
  # 接続中のユーザーと DB は名前を変えられないので、作業用のユーザーで postgres という DB に繋いで変える。
  psql_as "$OLD" postgres -c "drop role if exists rename_to_orbit" \
    -c "create role rename_to_orbit superuser login"
  psql_as rename_to_orbit postgres \
    -c "alter database \"$OLD\" rename to \"$NEW\"" \
    -c "alter role \"$OLD\" rename to \"$NEW\""
  psql_as "$NEW" postgres -c "drop role rename_to_orbit"
fi
# ユーザー名を変えるとパスワードが無効になる保存形式 (md5) もあるので、同じパスワードを設定し直す。
password="$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | head -n 1)"
psql_as "$NEW" "$NEW" -v "pw=$password" >/dev/null <<SQL
alter role "$NEW" password :'pw';
SQL
docker compose exec -T postgres touch /var/lib/postgresql/.renamed-to-orbit
echo "変えました。"

echo "== 5/5 新しい名前で起動する"
docker compose build
docker compose up -d --remove-orphans
for _ in $(seq 1 60); do
  if [ "$(docker compose ps api --format '{{.Health}}')" = "healthy" ]; then
    echo
    echo "移行しました。画面を開いて、メールが見えることを確かめてください。"
    echo "確かめたあと、古いデータは次のコマンドで消せます (消すと元には戻せません)。"
    echo "  docker volume rm ${OLD}_postgres-data ${OLD}_attachments"
    echo "  docker image rm mail-server mail-web"
    exit 0
  fi
  sleep 2
done

echo "API が起動しませんでした。直近のログ:" >&2
docker compose logs --tail=50 migrate api >&2
exit 1
