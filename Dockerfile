# -- Stage 1: build ----------------------------------------------------------------------------
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# noVNC: the static files of the released version, checked against their hash. The Debian
# `novnc` package would also pull Node 18 and an OpenStack Python stack for those files alone.
ARG NOVNC_VERSION=1.7.0
ARG NOVNC_SHA256=b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6
ADD https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz /tmp/novnc.tar.gz
RUN echo "${NOVNC_SHA256}  /tmp/novnc.tar.gz" | sha256sum -c - \
    && mkdir /novnc \
    && tar -xzf /tmp/novnc.tar.gz -C /novnc --strip-components=1

# -- Stage 2: runtime --------------------------------------------------------------------------
FROM node:26-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/browsers \
    DISPLAY=:99 \
    DATA_DIR=/data \
    TZ=Europe/Paris

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /novnc /usr/share/novnc
COPY package.json ./

# Patchright's Chromium, plus Google Chrome stable where the architecture allows it (x86_64).
# Virtual screen (Xvfb), x11vnc and websockify for noVNC, tini to forward signals and reap
# Chromium's processes, tzdata for the night hours.
RUN npx patchright install-deps chromium \
    && npx patchright install chromium --no-shell \
    && if [ "$(dpkg --print-architecture)" = "amd64" ]; then npx patchright install chrome; fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11vnc websockify tini tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /opt/browsers \
    && useradd -m app \
    && install -d -m 0700 -o app -g app /data

# No `COPY --chmod`: it needs BuildKit, which some Docker installs lack.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint
# Xvfb runs without root and cannot create its socket directory itself.
RUN chmod 755 /usr/local/bin/entrypoint && install -d -m 1777 /tmp/.X11-unix

USER app
VOLUME /data
EXPOSE 8000 6080
ENTRYPOINT ["tini", "--", "entrypoint"]
