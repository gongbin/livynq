# HomeKit and Matter need mDNS: run with `--network host`.
FROM node:24-slim
ENV NODE_ENV=production LIVYNQ_DATA_DIR=/data
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build:web \
 && pnpm install --prod --frozen-lockfile \
 && rm -rf /root/.cache /root/.local/share/pnpm
VOLUME /data
EXPOSE 8581
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/main.ts", "start"]
