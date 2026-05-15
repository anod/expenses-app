FROM node:22-alpine

WORKDIR /app

# Install deps first for better layer caching
COPY package.json ./
RUN npm install --omit=dev

COPY scripts ./scripts

# Default: run the connection test. Override with `docker compose run` to dump.
CMD ["node", "scripts/test-graph-connection.mjs"]
