# Lightweight image just for the Phase-0 Microsoft Graph tester
# (scripts/test-graph-connection.mjs). It only needs @azure/msal-node and
# dotenv; we install them directly to avoid pulling in the full workspace.
FROM node:22-alpine

WORKDIR /app

RUN npm install --omit=dev --no-audit --no-fund \
      @azure/msal-node@^2.16.2 \
      dotenv@^16.4.5

COPY scripts ./scripts

# Default: connection test. Override with `docker compose run` to dump.
CMD ["node", "scripts/test-graph-connection.mjs"]
