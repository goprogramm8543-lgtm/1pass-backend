FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.19.0-bookworm-slim
WORKDIR /app
ENV HOST=0.0.0.0
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
RUN mkdir /app/.sandbox-mail && chown node:node /app/.sandbox-mail
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
