# syntax=docker/dockerfile:1.7
# Build from node/: docker build -f packages/broker/Dockerfile -t mcp-broker .

# The deployment owns this manifest. No slot packages are built into the broker.
FROM node:22-alpine AS plugins
WORKDIR /opt/mcp-broker-plugins
COPY packages/broker/plugins/ ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages/broker/package.json ./packages/broker/package.json
COPY packages/provider/package.json ./packages/provider/package.json
RUN npm ci
COPY packages/broker/src ./packages/broker/src
COPY packages/broker/scripts ./packages/broker/scripts
COPY packages/broker/tsconfig.json packages/broker/tsup.config.ts ./packages/broker/
COPY packages/provider/src ./packages/provider/src
COPY packages/provider/tsconfig.json packages/provider/tsup.config.ts ./packages/provider/
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    MCP_BROKER_HOST=0.0.0.0 \
    MCP_BROKER_PORT=3000 \
    MCP_BROKER_PLUGINS_DIR=/opt/mcp-broker-plugins
WORKDIR /app
COPY --from=plugins /opt/mcp-broker-plugins /opt/mcp-broker-plugins
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/packages/broker/package.json ./packages/broker/package.json
COPY --from=build /build/packages/broker/dist ./packages/broker/dist
COPY --from=build /build/packages/provider/package.json ./packages/provider/package.json
COPY --from=build /build/packages/provider/dist ./packages/provider/dist
RUN addgroup -S app && adduser -S app -G app
USER app
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('net').createConnection({host:'127.0.0.1',port:Number(process.env.MCP_BROKER_PORT||3000)}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
EXPOSE 3000
CMD ["node", "packages/broker/dist/bin.js"]
