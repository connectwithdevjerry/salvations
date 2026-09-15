# Container image for the Phase 4 worker service.
#
# Built in CI now so that promoting the worker is a configuration change rather
# than a discovery exercise. Runs the smoke entrypoint until Phase 4.
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
# Same reasoning as the web image: install with the whole workspace present.
COPY . .
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@salvations/worker", "start"]
