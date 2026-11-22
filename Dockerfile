# Multi-stage build to keep the final image small.
#
# Deploy anywhere that runs Docker: Fly.io, Railway, Render, a VPS, etc.
# The server listens on $PORT (default 3000) at /mcp behind a bearer-token
# auth gate. See README → "Remote hosting" for the full deploy walkthrough.

# ─── build stage ───────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

# Copy manifests first so the npm install layer caches when only source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# Build with the local TypeScript compiler (devDep from `npm ci`), then drop
# devDeps. The `totem` CLI isn't available in the build stage, so we invoke
# tsc directly rather than going through it.
RUN npx tsc && npm prune --omit=dev

# ─── runtime stage ─────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

# The WHOOP login lives in /data/tokens.json. WHOOP rotates the refresh token on
# every refresh, so /data must be a volume (Fly [mounts], a Railway volume,
# `docker run -v totem-data:/data`) or the login is lost on restart.
#
# Volumes mount owned by root, so the container starts as root, hands the token
# directory to the unprivileged `node` user (uid 1000), and drops to it with
# su-exec before the server starts. The server itself never runs as root.
#
# That directory belongs to the server afterwards, so the root step must not
# follow anything found in it: chown -h changes a symlink itself, never its
# target, and chmod (which has no -h) is skipped for a symlinked directory.
# Without this, a link planted at tokens.json would get a root-owned file
# handed to `node` at the next start. "/" is never touched.
RUN apk add --no-cache su-exec \
 && mkdir -p /data && chown node:node /data && chmod 700 /data \
 && printf '%s\n' \
    '#!/bin/sh' \
    'set -e' \
    'file="${TOTEM_TOKEN_FILE:-/data/tokens.json}"' \
    'dir="$(dirname "$file")"' \
    'if [ "$(id -u)" = "0" ]; then' \
    '  mkdir -p "$dir"' \
    '  if [ "$dir" != "/" ]; then' \
    '    for p in "$dir" "$file" "$file.lock"; do if [ -e "$p" ] || [ -L "$p" ]; then chown -h node:node "$p" || true; fi; done' \
    '    if [ ! -L "$dir" ]; then chmod 700 "$dir" 2>/dev/null || true; fi' \
    '  fi' \
    '  exec su-exec node "$@"' \
    'fi' \
    'exec "$@"' \
    > /usr/local/bin/totem-entrypoint \
 && chmod 755 /usr/local/bin/totem-entrypoint

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/package.json ./

# Runtime settings. Set MCP_AUTH_TOKEN (and optionally AUTH_PASSWORD +
# PUBLIC_URL) via your host's secrets (`fly secrets set`, Railway variables,
# docker run -e …). No WHOOP tokens go in the environment: the server starts
# without a login, and `totem auth` pushes one to POST /admin/tokens, which
# writes the token file. (Or just run `totem cloud`: it does all of this.)
#
# This image forces HTTP transport.
ENV MCP_TRANSPORT=http
ENV TOTEM_TOKEN_FILE=/data/tokens.json
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/usr/local/bin/totem-entrypoint"]
CMD ["node", "dist/server.js"]
