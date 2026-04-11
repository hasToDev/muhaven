FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Runtime — tsx serves src/ + api/ directly (no pre-compile needed)
FROM base AS runner
COPY --from=deps /app/node_modules node_modules/
COPY package.json tsconfig.json drizzle.config.ts ./
COPY src/ src/
COPY api/ api/
COPY scripts/ scripts/
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "src/dev-server.ts"]
