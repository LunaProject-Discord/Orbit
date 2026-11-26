# syntax=docker/dockerfile:1
# 本番用のイメージ。deploy/compose.yml から使う。
#   server: API サーバー、同期ワーカー、マイグレーション (起動するコマンドで使い分ける)
#   web:    静的に書き出した Web と、HTTPS を受け持つ Caddy
ARG NODE_VERSION=26
ARG CADDY_VERSION=2

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
# Node.js 25 以降には Corepack が無いので、pnpm は npm で入れる (版は package.json の packageManager に合わせる)。
RUN npm install -g pnpm@10.28.0
WORKDIR /app

# 依存の一覧だけを先に写し、ソースを変えただけでは入れ直しにならないようにする。
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
# スマホアプリはイメージに入れないが、pnpm-lock.yaml と食い違わないよう一覧だけは写す。
COPY apps/mobile/package.json apps/mobile/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/

FROM manifests AS source
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .

FROM source AS server-build
RUN pnpm exec turbo run build --filter=@orbit/api --filter=@orbit/worker

FROM source AS web-build
# ブラウザから見た API の URL。ビルド時に Web へ埋め込まれる。
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_TELEMETRY_DISABLED=1
RUN test -n "$NEXT_PUBLIC_API_URL" || (echo "NEXT_PUBLIC_API_URL を --build-arg で渡してください。" >&2; exit 1)
# アプリの画面の自動更新の一覧 (app-update/manifest.json) に署名する鍵。ビルドの間だけ読み、イメージには残さない。
# 無ければ一覧を作らない (アプリは同梱の画面を使い続ける)。
RUN --mount=type=secret,id=app_update_signing_key,required=false \
    APP_UPDATE_SIGNING_KEY="$(cat /run/secrets/app_update_signing_key 2>/dev/null || true)" \
    pnpm --filter @orbit/web build

FROM manifests AS server
# 動いているサーバーの版 (deploy/deploy.sh が git のタグから決めて渡す)。/v1/server-info で返す。
ARG ORBIT_VERSION=""
ARG ORBIT_COMMIT=""
ENV NODE_ENV=production \
    ORBIT_VERSION=${ORBIT_VERSION} \
    ORBIT_COMMIT=${ORBIT_COMMIT}
# better-auth が「あれば使う」依存 (Next.js、Vitest、drizzle-kit など) まで入ってしまうので、
# サーバーでは読み込まれないビルド・テスト用のものを消してイメージを小さくする (約 550 MB)。
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter "@orbit/api..." --filter "@orbit/worker..." \
    && cd node_modules/.pnpm \
    && rm -rf next@* @next+* sharp@* @img+* happy-dom@* \
       vite@* vitest@* @vitest+* rolldown@* @rolldown+* lightningcss* \
       esbuild@* @esbuild+* drizzle-kit@* typescript@*
COPY packages/db/drizzle packages/db/drizzle
COPY --from=server-build /app/packages/db/dist packages/db/dist
COPY --from=server-build /app/packages/core/dist packages/core/dist
COPY --from=server-build /app/apps/api/dist apps/api/dist
COPY --from=server-build /app/apps/worker/dist apps/worker/dist
# 送信する添付ファイルの置き場。API とワーカーで同じボリュームを共有する。
ENV ATTACHMENTS_DIR=/data/attachments
RUN mkdir -p /data/attachments && chown -R node:node /data
USER node
EXPOSE 8787
CMD ["node", "apps/api/dist/index.js"]

FROM caddy:${CADDY_VERSION}-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/out /srv
