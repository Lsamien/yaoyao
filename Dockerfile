# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY release.json ./
COPY scripts ./scripts
COPY bin ./bin
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci

COPY tsconfig.json tsconfig.client.json tsconfig.client.build.json tsconfig.server.json vite.config.ts ./
COPY index.html ./
COPY public ./public
COPY deploy ./deploy
COPY third-party ./third-party
COPY src ./src
COPY runtime ./runtime

# Embedded Hermes kernel: Debian bookworm ships Python 3.11, the version the lock file targets.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv python3-dev build-essential \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /app/.venv \
  && /app/.venv/bin/pip install --no-cache-dir --no-deps --require-hashes -r runtime/requirements.lock \
  && /app/.venv/bin/pip check \
  && find runtime -name __pycache__ -prune -exec rm -rf {} +

RUN npm run build \
  && npm run runner:build \
  && tar -C .runner-build -czf runner-bundle.tar.gz . \
  && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HERMES_YAOYAO_HOST=0.0.0.0 \
    HERMES_YAOYAO_PORT=15300 \
    HERMES_YAOYAO_HOME=/home/node/.yaoyao \
    HERMES_YAOYAO_CHAT_CACHE_MODE=prefer-local \
    HERMES_YAOYAO_LOCAL_VM_HOST=runner \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-yaml \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -o node -g node -m 0700 /home/node/.yaoyao

COPY --chown=node:node package.json package-lock.json release.json ./
COPY --chown=node:node LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node licenses ./licenses
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/dist-server ./dist-server
COPY --chown=node:node --from=builder /app/bin ./bin
COPY --chown=node:node --from=builder /app/runtime ./runtime
COPY --chown=node:node --from=builder /app/.venv ./.venv
COPY --chown=node:node --from=builder /app/build-info.json /app/runner-bundle.tar.gz ./

USER node

EXPOSE 15300

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:15300/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist-server/server/index.js"]
