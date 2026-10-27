FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

FROM dependencies AS runtime-dependencies
RUN npm prune --omit=dev --workspaces=false

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY --from=runtime-dependencies /app/node_modules ./node_modules
COPY package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
USER node
CMD ["node", "dist/server/index.js"]
