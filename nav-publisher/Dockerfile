FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml* tsconfig.json ./
COPY src/ src/
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm build

FROM base AS runner
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY package.json ./
EXPOSE 3003
CMD ["node", "dist/index.js"]
