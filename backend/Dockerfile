FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# Runtime — tsx serves src/ + api/ directly (no pre-compile needed)
FROM base AS runner
COPY --from=deps /app/node_modules node_modules/
COPY package.json tsconfig.json drizzle.config.ts ./
COPY src/ src/
COPY api/ api/
COPY scripts/ scripts/
# Phase 9.A · Expansion (F2) — compiled contract artifacts for the
# self-serve issuer onboarding deploy library. The deploy library reads
# MuHavenToken / RedemptionQueue / MuHavenTreasury bytecode + ABI from
# this directory at runtime. Stage this dir from the project's
# `artifacts/contracts/` BEFORE building: the deploy-homelab.sh script
# rsyncs `artifacts/contracts/` → `backend/contracts-artifacts/contracts/`
# when present. When the dir is absent, the build still succeeds; the
# /v1/issuer/tokens/deploy endpoint surfaces a 503 at runtime. Set
# `MUHAVEN_ARTIFACTS_DIR=/app/contracts-artifacts` in backend/.env.stage
# to point the lib at this baked-in copy.
COPY contracts-artifacts /app/contracts-artifacts/
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "src/dev-server.ts"]
