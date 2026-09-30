# syntax=docker/dockerfile:1
#
# 单镜像、多入口，由容器的 command 决定跑哪个：
#
#   docker build -t <repo>/dingorg:<tag> .
#
#   常驻：  node dist/server.js
#   迁移：  node dist/bin/migrate.js
#   cron：  node dist/bin/cron/oidcpurge.js
#           node dist/bin/cron/orgsync.js

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ---------- 生产依赖 ----------
# pnpm-workspace.yaml 必须拷：pnpm 11 的配置在里面，缺了 build 阶段的 install 失败
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---------- 构建 ----------
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---------- 运行时 ----------
FROM base AS runner
# 别删：PUBLIC_ORIGIN 只在非 production 时有默认值，镜像里缺了要启动失败
ENV NODE_ENV=production
# 不设 TZ，一律 UTC。真要设必须同时 apk add tzdata，否则 musl 静默回落 UTC
RUN addgroup -S app && adduser -S app -G app

COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
# 迁移入口按 `./drizzle` 相对工作目录找 SQL
COPY --chown=app:app drizzle ./drizzle
COPY --chown=app:app package.json ./

USER app
# 与 src/env.ts 的 LISTEN_PORT 一致
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
	CMD wget -qO- http://127.0.0.1:3080/healthz || exit 1

# ⚠️ 占位 CMD，报错并 exit 64：忘记指定入口要明确失败。也不能不写——会继承 node 的
# CMD，非 TTY 下静默 exit 0，Job 被当成「成功完成」
CMD ["node", "-e", "console.error('[dingorg] 必须显式指定入口：node dist/server.js | dist/bin/migrate.js | dist/bin/cron/oidcpurge.js | dist/bin/cron/orgsync.js'); process.exit(64)"]
