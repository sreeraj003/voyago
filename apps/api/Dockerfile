# Voyago API image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t voyago-api .
# Targets:
#   api (default)  the server, production dependencies only, runs as a non-root user
#   migrate        runs `prisma migrate deploy` once per release, before the new API starts
# No secrets are baked in: every setting comes from the environment at run time.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
# Only the API's dependency graph; the mobile and admin apps are not installed.
RUN pnpm install --frozen-lockfile --filter @voyago/api... --ignore-scripts \
  && pnpm rebuild --filter @voyago/api... 
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @voyago/shared build \
  && pnpm --filter @voyago/api build \
  && pnpm --filter @voyago/api deploy --prod --legacy /out \
  && cp -r apps/api/dist /out/dist

FROM base AS migrate
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
