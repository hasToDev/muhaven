FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml* tsconfig.json ./
COPY src/ src/
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm build

FROM base AS runner
COPY --from=build --chown=node:node /app/node_modules node_modules/
COPY --from=build --chown=node:node /app/dist dist/
COPY --chown=node:node package.json ./
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
