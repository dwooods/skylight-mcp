# Breakage canary for an always-on host (for example a NAS). Runs a read-only check of the
# Skylight API once a day and pings healthchecks.io. It is NOT the MCP server.
# See canary/README.md.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    XDG_CONFIG_HOME=/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The sign-in file lives here and nowhere else. Mount a private folder on it.
VOLUME /data
USER node
CMD ["node", "dist/canary/run.js"]
