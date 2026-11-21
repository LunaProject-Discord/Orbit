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

  git fetch --prune origin main
  git checkout --detach "${sha:-origin/main}"
  echo "更新するコミット: $(git log -1 --format='%h %s')"

  cd deploy
  docker compose build
  # 未適用のマイグレーションは、API とワーカーの起動前に migrate サービスが流す。
  docker compose up -d --remove-orphans

  # API が DB に繋がって応答するまで待つ。
  for _ in $(seq 1 30); do
    if [ "$(docker compose ps api --format '{{.Health}}')" = "healthy" ]; then
      docker image prune -f >/dev/null
      echo "更新しました。"
      exit 0
    fi
    sleep 2
  done

  echo "API が起動しませんでした。直近のログ:" >&2
  docker compose logs --tail=50 migrate api >&2
  exit 1
}

main "$@"
