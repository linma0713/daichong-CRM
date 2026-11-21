# 后端镜像。构建上下文是仓库根目录：docker compose build api
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts scripts/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@crm/api..."
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @crm/shared build && pnpm --filter @crm/api build
# 只带生产依赖，输出到 /out
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @crm/api deploy --legacy --prod /out \
 && cd /out && node node_modules/prisma/build/index.js generate

# 运行镜像：alpine 自带 Prisma 需要的 libssl3，不用另装系统包
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# 附件目录：挂卷前先建好并交给 node 用户，新卷会继承这个属主
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:'+(process.env.API_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "docker-entrypoint.sh"]
