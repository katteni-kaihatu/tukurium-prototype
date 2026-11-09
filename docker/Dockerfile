# syntax=docker/dockerfile:1
# Tukurium：クライアント（静的ファイル）とサーバーを1つのイメージにまとめる。
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
COPY packages/eks/package.json packages/eks/
COPY packages/script/package.json packages/script/
COPY packages/runtime/package.json packages/runtime/
COPY packages/repo-model/package.json packages/repo-model/
COPY packages/typecheck/package.json packages/typecheck/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @tukurium/client build && pnpm --filter @tukurium/server build
# サーバーの本番依存だけを取り出す（ワークスペースのパッケージはバンドル済み）
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @tukurium/server deploy --legacy --prod /out/server

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 CLIENT_DIR=/app/public
WORKDIR /app
COPY --from=build /out/server/node_modules ./node_modules
COPY --from=build /out/server/package.json ./package.json
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/client/dist ./public
# ボリュームの初期の持ち主を node にする（Git の保存先と、S3 互換ストレージがないときの素材の置き場）
RUN mkdir -p /data/git /data/assets && chown -R node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
