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
# devDeps. The `whoop-mcp` CLI isn't available in the build stage, so we invoke
# tsc directly rather than going through it.
RUN npx tsc && npm prune --omit=dev

# ─── runtime stage ─────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

# Run as a non-root user. node:alpine ships with a `node` user (uid 1000).
USER node

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/package.json ./

# These three env vars are required at runtime. Set them via your host's
# secrets mechanism (`fly secrets set`, Railway env, docker run -e, etc.):
#   WHOOP_EMAIL                   — your Whoop account email
#   WHOOP_IOS_BEARER_TOKEN        — from `whoop-mcp auth` on your Mac
#   WHOOP_COGNITO_REFRESH_TOKEN   — from `whoop-mcp auth` on your Mac
#   MCP_AUTH_TOKEN                — random secret your MCP client will send
#
# (Or just run `whoop-mcp cloud` — it builds, deploys, and sets all of this.)
#
# This image forces HTTP transport.
ENV MCP_TRANSPORT=http
ENV WHOOP_TOKEN_STORE=memory
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/server.js"]
