# Long-lived Node server for the HUBRIS API (Render, or any Docker host).
#
# Unlike Vercel Functions, this image ships the `git` binary that analysis,
# Reproduce, Forge and SHIP shell out to. Build context is the repo root:
#   docker build -f apps/api/Dockerfile .
# Configuration comes from the host's environment variables; no .env is copied.

FROM node:24.19.0-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install --global pnpm@10.34.5

WORKDIR /app
COPY . .

# Install and build only the API and the workspace packages it depends on.
RUN pnpm install --frozen-lockfile --filter "@hubris/api..." --filter "." \
 && pnpm turbo run build --filter=@hubris/api...

ENV NODE_ENV=production
# The platform sets PORT; local.ts falls back to 3001.
EXPOSE 3001
CMD ["node", "apps/api/dist/local.js"]
