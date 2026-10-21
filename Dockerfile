# syntax=docker/dockerfile:1
# --- build: フロント(Vite PWA) + サーバー(esbuild) ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

# --- runtime: Node + ffmpeg（長時間音声の圧縮・分割に必要） ---
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 WEB_DIST=/app/web/dist
COPY .npmrc package.json package-lock.json ./
COPY shared/ shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace @app/server --workspace @app/shared \
 && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
# 一時ファイル(アップロード音声)は /tmp/soundcore-pwa 配下のみ。起動時・定期的・ジョブ終了時に削除される。
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
