# Container image for the Next.js app.
#
# Built and BOOTED in CI on every commit (AC-16). A Dockerfile that is never
# built is a Dockerfile that does not work, and the whole "deployment-agnostic"
# claim rests on this image being real.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/contracts/package.json packages/contracts/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/mcp/package.json packages/mcp/
COPY packages/runtime/package.json packages/runtime/
COPY packages/observability/package.json packages/observability/
COPY packages/providers/anthropic/package.json packages/providers/anthropic/
COPY packages/providers/openai/package.json packages/providers/openai/
COPY packages/providers/google/package.json packages/providers/google/
COPY packages/providers/registry/package.json packages/providers/registry/
COPY packages/providers/testkit/package.json packages/providers/testkit/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter @salvations/web build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
