# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Build stage — compiles TypeScript, copies grammar JSON resources to dist/
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Dependencies first so Docker can cache the install layer.
COPY package.json package-lock.json* .npmrc* ./
RUN npm ci

# Source + build tooling.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm run build

# Drop dev dependencies from node_modules so we can copy a slim folder.
RUN npm prune --omit=dev


# ---------------------------------------------------------------------------
# Runtime stage — only what `node dist/bin.js` needs to start.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    MCP_BROKER_HOST=0.0.0.0 \
    MCP_BROKER_PORT=3000

WORKDIR /app

# Bring over the package manifest, the production node_modules, and the
# compiled output (which already includes the JSON grammar resources).
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Run as a non-root user.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

# Lightweight TCP probe — succeeds when the broker is listening.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('net').createConnection({host:'127.0.0.1',port:Number(process.env.MCP_BROKER_PORT||3000)}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"

EXPOSE 3000

CMD ["node", "dist/bin.js"]
