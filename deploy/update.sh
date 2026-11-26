#!/usr/bin/env bash
# サーバーを、deploy/.env の更新の方針に合わせた版へ更新する (docs/updates.md)。
#   bash deploy/update.sh            方針に従って更新する (ORBIT_SERVER_AUTO_UPDATE=true のときだけ)
#   bash deploy/update.sh --now      ORBIT_SERVER_AUTO_UPDATE に関係なく、いま更新する
#   bash deploy/update.sh --check    更新先の版を表示するだけ (更新しない)
# 定期的に動かすには deploy/auto-update.sh install でタイマーを入れる。
#
# 方針 (deploy/.env):
#   ORBIT_UPDATE_CHANNEL      stable (正式版の v1.2.0 だけ) / beta (v1.3.0-beta.1 なども) / edge (main の最新)
#   ORBIT_UPDATE_VERSION      版を固定する (例 1.2.0)。書くとチャネルより優先する
#   ORBIT_SERVER_AUTO_UPDATE  true なら定期的に更新する
# 更新して API が起動しなければ、前のコミットに戻し、その版は自動では二度と試さない
# (deploy/.update-state/failed に記録する。消せばまた試す)。
set -euo pipefail

main() {
  local mode="auto"
  case "${1:-}" in
  "") ;;
  --now) mode="now" ;;
  --check) mode="check" ;;
  *)
    echo "使い方: bash deploy/update.sh [--now|--check]" >&2
    exit 1
    ;;
  esac

  cd "$(dirname "$0")/.."
  if [ ! -f deploy/.env ]; then
    echo "deploy/.env がありません。先に bash deploy/setup.sh <ドメイン> を実行してください。" >&2
    exit 1
  fi
  env_value() {
    sed -n "s/^$1=[[:space:]]*//p" deploy/.env | tail -n 1 | sed 's/[[:space:]]*$//; s/^"\(.*\)"$/\1/'
  }

  local channel pinned auto
  channel="$(env_value ORBIT_UPDATE_CHANNEL | tr '[:upper:]' '[:lower:]')"
  channel="${channel:-stable}"
  pinned="$(env_value ORBIT_UPDATE_VERSION)"
  pinned="${pinned#v}"
  auto="$(env_value ORBIT_SERVER_AUTO_UPDATE | tr '[:upper:]' '[:lower:]')"

  if [ "$mode" = "auto" ] && [ "$auto" != "true" ]; then
    echo "ORBIT_SERVER_AUTO_UPDATE が true ではないので、自動では更新しません。"
    exit 0
  fi
  case "$channel" in
  stable | beta | edge) ;;
  *)
    echo "ORBIT_UPDATE_CHANNEL=$channel は使えません (stable、beta、edge のどれか)。" >&2
    exit 1
    ;;
  esac

  git fetch --quiet --prune --tags --force origin main

  # 更新先のコミットと、その版の名前。
  local target="" label=""
  if [ -n "$pinned" ]; then
    if ! git rev-parse --quiet --verify "refs/tags/v$pinned^{commit}" >/dev/null; then
      echo "固定する版 v$pinned のタグがありません (ORBIT_UPDATE_VERSION を確かめてください)。" >&2
      exit 1
    fi
    target="$(git rev-parse "refs/tags/v$pinned^{commit}")"
    label="v$pinned (固定)"
  elif [ "$channel" = "edge" ]; then
    target="$(git rev-parse origin/main)"
    label="main の最新 ($(git rev-parse --short origin/main))"
  else
    local pattern='v[0-9]*.[0-9]*.[0-9]*'
    local tag=""
    # versionsort.suffix=- で、v1.2.0-beta.1 を v1.2.0 より前に並べる。
    while read -r candidate; do
      [ -z "$candidate" ] && continue
      if [ "$channel" = "stable" ] && [[ "$candidate" == *-* ]]; then
        continue
      fi
      # main に入っていない (ほかのブランチの) タグは使わない。
      if git merge-base --is-ancestor "$candidate" origin/main 2>/dev/null; then
        tag="$candidate"
        break
      fi
    done < <(git -c versionsort.suffix=- tag --list "$pattern" --sort=-v:refname)
    if [ -z "$tag" ]; then
      echo "チャネル $channel のリリースがまだありません。"
      exit 0
    fi
    target="$(git rev-parse "$tag^{commit}")"
    label="$tag"
  fi

  local current
  current="$(git rev-parse HEAD)"
  echo "いまの版: $(git describe --tags --always HEAD)、更新先: $label"
  if [ "$target" = "$current" ]; then
    echo "最新です。"
    exit 0
  fi

  # 固定していないときは、古い版へは戻さない (DB のマイグレーションは戻せないため)。
  if [ -z "$pinned" ] && git merge-base --is-ancestor "$target" "$current"; then
    echo "更新先がいまの版より古いので、更新しません。"
    exit 0
  fi
  if [ -n "$pinned" ] && git merge-base --is-ancestor "$target" "$current"; then
    if [ "$mode" != "now" ]; then
      echo "固定した版がいまの版より古いので、自動では戻しません。戻すときは --now を付けて実行してください。"
      echo "(DB の変更 (マイグレーション) は戻らないので、古い版で動かない場合があります。)"
      exit 0
    fi
    echo "注意: 固定した版がいまの版より古いので、古い版へ戻します。DB の変更 (マイグレーション) は戻りません。" >&2
  fi

  mkdir -p deploy/.update-state
  if [ "$mode" = "auto" ] && grep -qx "$target" deploy/.update-state/failed 2>/dev/null; then
    echo "この版は前に更新に失敗したので、自動では試しません (deploy/.update-state/failed から消すと再び試します)。"
    exit 0
  fi
  if [ "$mode" = "check" ]; then
    echo "更新できます (--now で更新します)。"
    exit 0
  fi

  # 更新の前に DB のバックアップを取る (失敗したら更新しない)。
  echo "更新の前に DB のバックアップを取ります。"
  (cd deploy && docker compose run --rm -T backup once)

  # deploy.sh は git checkout するので、このファイルを読み終えてから呼ぶ (main 関数で囲んである)。
  if bash deploy/deploy.sh "$target"; then
    date -u '+%Y-%m-%dT%H:%M:%SZ' >deploy/.update-state/last-success
    exit 0
  fi

  echo "更新に失敗したので、前の版 ($(git rev-parse --short "$current")) に戻します。" >&2
  echo "$target" >>deploy/.update-state/failed
  if bash deploy/deploy.sh "$current"; then
    echo "前の版に戻しました。" >&2
  else
    echo "前の版にも戻せませんでした。docker compose logs で原因を確かめてください。" >&2
  fi
  exit 1
}

main "$@"
