# syntax=docker/dockerfile:1.7

FROM --platform=linux/amd64 node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build

ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable \
    && corepack prepare pnpm@11.21.0 --activate \
    && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build \
    && pnpm prune --prod

FROM --platform=linux/amd64 node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime

ENV NODE_ENV=production \
    DISPLAY=:99 \
    HEALTH_PORT=3000 \
    PUPPETEER_CACHE_DIR=/home/node/.cache/puppeteer

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      ffmpeg \
      fonts-dejavu-core \
      fonts-liberation \
      fonts-noto-color-emoji \
      pulseaudio \
      pulseaudio-utils \
      tini \
      unzip \
      x11-utils \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules

RUN apt-get update \
    && mkdir -p "$PUPPETEER_CACHE_DIR" /run/secrets \
    && node node_modules/puppeteer/lib/puppeteer/node/cli.js browsers install chrome --install-deps \
    && chown -R node:node /home/node/.cache /run/secrets \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=45s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
