#!/usr/bin/env bash
# アプリ本体 (デスクトップ版のインストーラー、Android の APK) の配布用のファイルを、GitHub Releases から
# deploy/app-releases/<版>/ へ取り込み、この版を配るよう deploy/app-releases/CURRENT に書く (docs/updates.md)。
#   bash deploy/app-release.sh            いまのコミットに対応するリリースを取り込む (deploy.sh が呼ぶ)
#   bash deploy/app-release.sh 1.2.0      指定した版を取り込む
# 取り込む版は「いまのコミットから辿れる、いちばん新しい v* のタグ」。main の途中 (edge) でも、
# その時点の最新のリリースのアプリを配る。
# リポジトリが非公開のときは、deploy/.env の ORBIT_RELEASES_TOKEN に読み取り用のトークンが要る。
# ネットにつながらないサーバーでは、リリースのファイルを手で deploy/app-releases/<版>/ に置き、
# CURRENT にその版を書けばよい (このスクリプトは使わない)。
set -euo pipefail

main() {
  cd "$(dirname "$0")"
  env_value() {
    sed -n "s/^$1=[[:space:]]*//p" .env 2>/dev/null | tail -n 1 | sed 's/[[:space:]]*$//'
  }

  if [ "$(env_value ORBIT_APP_UPDATE)" = "off" ]; then
    echo "ORBIT_APP_UPDATE=off なので、アプリ本体の配布用のファイルは取り込みません。"
    return 0
  fi

  local version="${1:-}"
  if [ -z "$version" ]; then
    local tag
    tag="$(git -C .. describe --tags --abbrev=0 --match 'v[0-9]*' HEAD 2>/dev/null || true)"
    if [ -z "$tag" ]; then
      echo "リリース (v* のタグ) がまだ無いので、アプリ本体の配布用のファイルは取り込みません。"
      return 0
    fi
    version="${tag#v}"
  fi
  version="${version#v}"
  if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    echo "版の書式が不正です: $version" >&2
    return 1
  fi

  mkdir -p app-releases
  if [ -f "app-releases/$version/SHA256SUMS" ]; then
    echo "アプリ本体 $version は取り込み済みです。"
  else
    local repo
    repo="$(env_value ORBIT_RELEASES_REPO)"
    if [ -z "$repo" ]; then
      repo="$(git -C .. remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
    fi
    echo "アプリ本体 $version を $repo のリリースから取り込みます。"
    # 取得と照合は Node.js で行う (サーバーに jq などを入れなくて済むよう、API のイメージを使う)。
    docker compose run --rm --no-deps -T \
      --user "$(id -u):$(id -g)" \
      --volume "$PWD/app-releases:/releases:z" \
      --env ORBIT_RELEASES_REPO="$repo" \
      api node apps/api/dist/cli/fetch-app-release.js "$version" /releases
  fi

  printf '%s\n' "$version" >app-releases/CURRENT.tmp
  mv app-releases/CURRENT.tmp app-releases/CURRENT
  echo "配るアプリ本体の版: $version"

  # 古い版は、新しいほうから 3 つだけ残す。
  local old
  old="$(find app-releases -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' -printf '%f\n' |
    sort -V -r | tail -n +4)"
  for dir in $old; do
    [ "$dir" = "$version" ] && continue
    rm -rf "app-releases/$dir"
  done
}

main "$@"
