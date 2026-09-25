# Container image for the Next.js app.
#
# Built and BOOTED in CI on every commit (AC-16). A Dockerfile that is never
# built is a Dockerfile that does not work, and the whole "deployment-agnostic"
# claim rests on this image being real.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
# Install AFTER the full workspace is present. pnpm's isolated layout puts a
# node_modules in every package, so copying only the root one leaves
# apps/web/node_modules missing and `next` unresolvable. Correctness over
# layer caching: a cached build that cannot find its own binaries is worthless.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @salvations/web build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
# Standalone output is laid out from outputFileTracingRoot (the monorepo root),
# so it already contains apps/web/server.js and a traced node_modules.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
