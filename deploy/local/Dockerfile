FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /app
RUN npm install --global pnpm@11.28.11 --ignore-scripts --no-audit --no-fund
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.server.json ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/model-adapters/package.json ./packages/model-adapters/package.json
RUN pnpm install --frozen-lockfile
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN pnpm typecheck && pnpm build

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
WORKDIR /app
ENV NODE_ENV=production AITESTHUB_HOST=0.0.0.0 AITESTHUB_PORT=5300
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/persistence/migrations ./packages/persistence/migrations
USER node
EXPOSE 5300
CMD ["node", "dist/apps/api/src/main.js"]
