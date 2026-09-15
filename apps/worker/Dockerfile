# Container image for the Phase 4 worker service.
#
# Built in CI now so that promoting the worker is a configuration change rather
# than a discovery exercise. Runs the smoke entrypoint until Phase 4.
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/ packages/
RUN pnpm install --frozen-lockfile --prod=false
COPY . .
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@salvations/worker", "start"]
