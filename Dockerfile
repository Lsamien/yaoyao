# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY release.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci

COPY tsconfig.json tsconfig.client.json tsconfig.client.build.json tsconfig.server.json vite.config.ts ./
COPY index.html ./
COPY public ./public
COPY scripts ./scripts
COPY deploy ./deploy
COPY third-party ./third-party
COPY src ./src

RUN npm run build \
  && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HERMES_YAOYAO_HOST=0.0.0.0 \
    HERMES_YAOYAO_PORT=15300 \
    HERMES_YAOYAO_HOME=/var/lib/hermes-yaoyao \
    HERMES_YAOYAO_CHAT_CACHE_MODE=prefer-local \
    HERMES_YAOYAO_SUPERVISE_DASHBOARD=0

WORKDIR /app

RUN install -d -o node -g node -m 0700 /var/lib/hermes-yaoyao

COPY --chown=node:node package.json package-lock.json release.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/dist-server ./dist-server

USER node

EXPOSE 15300

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:15300/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist-server/server/index.js"]
