# =============================================================================
# Production image: Express API + built Angular SPA in one container.
# Multi-stage:
#   build   — installs all deps, compiles workspaces, prunes dev deps.
#   runtime — slim node:22 with only built output and prod node_modules.
# Pin node:22.<minor> to keep better-sqlite3's prebuilt ABI compatible.
# =============================================================================

ARG NODE_IMAGE=node:22-bookworm-slim

# -----------------------------------------------------------------------------
# Stage 1 — build
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

WORKDIR /app

# better-sqlite3 has no prebuilt for node:22-bookworm-slim, so it needs a
# native build toolchain here (toolchain is dropped in the runtime stage).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy package manifests first to maximize layer caching.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

RUN npm ci --include=dev --no-audit --no-fund

# Now copy the rest and build everything.
COPY . .
RUN npm run build --workspaces --if-present

# Drop dev deps. Workspace symlinks are preserved.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# -----------------------------------------------------------------------------
# Stage 2 — runtime
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="expenses-app" \
      org.opencontainers.image.description="Personal cash-flow forecasting app (Angular SPA + Express API + OneDrive Excel via Microsoft Graph)." \
      org.opencontainers.image.source="https://github.com/anod/expenses-app" \
      org.opencontainers.image.url="https://github.com/anod/expenses-app" \
      org.opencontainers.image.documentation="https://github.com/anod/expenses-app/blob/main/docs/deploy.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="anod"

ENV NODE_ENV=production \
    PORT=4000 \
    SERVE_SPA=true \
    SPA_DIR=/app/apps/web/dist/web/browser \
    DB_PATH=/data/expenses.db \
    DUMPS_DIR=/data/dumps

WORKDIR /app

# node:22-bookworm-slim already ships a `node` user (uid 1000).
RUN mkdir -p /data /data/dumps /data/backups \
 && chown -R node:node /data

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json apps/api/
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/migrations apps/api/migrations
COPY --from=build --chown=node:node /app/apps/web/package.json apps/web/
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist
COPY --from=build --chown=node:node /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=node:node /app/packages/shared/dist packages/shared/dist

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
