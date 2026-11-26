#!/usr/bin/env bash
# サーバー上で、指定したコミット (省略時は main の最新) に更新して起動し直す。
#   bash deploy/deploy.sh [コミットの SHA]
# GitHub Actions (.github/workflows/deploy.yml) からも、SSH 越しにこれを呼ぶ。
set -euo pipefail

# 実行中にこのファイル自体が git で書き換わっても影響を受けないよう、全体を関数にして最後に呼ぶ。
main() {
  local sha="${1:-}"
  if [ -n "$sha" ] && ! [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]]; then
    echo "コミットの SHA が不正です: $sha" >&2
    exit 1
  fi

  cd "$(dirname "$0")/.."
  if [ ! -f deploy/.env ]; then
    echo "deploy/.env がありません。先に bash deploy/setup.sh <ドメイン> を実行してください。" >&2
    exit 1
  fi

  git fetch --prune --tags origin main
  git checkout --detach "${sha:-origin/main}"
  echo "更新するコミット: $(git log -1 --format='%h %s')"

  # サーバーの版。リリースのタグ (v1.2.0) の上なら、その版。それ以外 (main の途中) は
  # package.json の版に -dev+<コミット> を付ける (docs/updates.md)。
  local commit tag
  commit="$(git rev-parse --short=12 HEAD)"
  tag="$(git tag --points-at HEAD --list 'v[0-9]*' | head -n 1)"
  if [ -n "$tag" ]; then
    ORBIT_BUILD_VERSION="${tag#v}"
  else
    ORBIT_BUILD_VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json | head -n 1)-dev+${commit}"
  fi
  export ORBIT_BUILD_VERSION
  export ORBIT_BUILD_COMMIT="$commit"
  echo "サーバーの版: $ORBIT_BUILD_VERSION"

  cd deploy
  # 名前を mail から orbit に変える前のデータ (ボリューム mail_postgres-data) が残っていて、新しい名前の
  # データがまだ無いときは、このまま起動すると空の DB で動き出してしまう。先に移行を済ませてもらう。
  if docker volume inspect mail_postgres-data >/dev/null 2>&1 &&
    ! docker volume inspect orbit_postgres-data >/dev/null 2>&1; then
    echo "名前を orbit に変える前のデータがあります。先に bash deploy/rename-to-orbit.sh を実行してください" >&2
    echo "(手順は docs/deploy-oracle-cloud.md の「名前を mail から orbit に変える」)。" >&2
    exit 1
  fi
  # 画面の自動更新の署名の鍵。この仕組みより前に setup.sh を実行したサーバーでは、ここで作る。
  bash ./app-update-key.sh
  # アプリ本体の配布用のファイルの置き場。無いまま起動すると Docker が root の持ち物として作ってしまう。
  mkdir -p app-releases
  docker compose build
  # 未適用のマイグレーションは、API とワーカーの起動前に migrate サービスが流す。
  docker compose up -d --remove-orphans

  # API が DB に繋がって応答するまで待つ。
  for _ in $(seq 1 30); do
    if [ "$(docker compose ps api --format '{{.Health}}')" = "healthy" ]; then
      docker image prune -f >/dev/null
      echo "更新しました。"
      # アプリ本体の配布用のファイルを取り込む。失敗してもサーバーの更新は済んでいるので、知らせるだけにする。
      bash ./app-release.sh || echo "アプリ本体の配布用のファイルを取り込めませんでした (サーバーの更新は済んでいます)。" >&2
      exit 0
    fi
    sleep 2
  done

  echo "API が起動しませんでした。直近のログ:" >&2
  docker compose logs --tail=50 migrate api >&2
  exit 1
}

main "$@"
