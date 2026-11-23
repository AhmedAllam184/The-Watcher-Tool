# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN GEV_HOSTED=1 npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
# Vite and its config plugins are required by preview, including dev dependencies.
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production \
    GEV_HOSTED=1 \
    NODE_OPTIONS=--max-old-space-size=384 \
    PORT=10000
USER node
EXPOSE 10000
CMD ["sh", "-c", "exec node node_modules/vite/bin/vite.js preview --host 0.0.0.0 --port ${PORT:-10000} --strictPort"]
