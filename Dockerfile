# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS ui
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Flask API and CRM scripts. `/` explains that the UI is not built.
FROM python:3.12-slim AS server
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
# Dependencies install against a stub package so source edits reuse this layer.
COPY pyproject.toml README.md ./
RUN mkdir -p src/mong && touch src/mong/__init__.py \
    && pip install -e ".[mongod]"
COPY src ./src
COPY scripts ./scripts
# uid 10001 owns the nomongo-t secret files that compose.yaml mounts read-only.
RUN groupadd --gid 10001 mong \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin mong
USER mong
ENV MONG_HOST=0.0.0.0 \
    MONG_PORT=5050
EXPOSE 5050
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ['MONG_PORT'], timeout=3)"]
CMD ["mong-admin"]

FROM server AS app
COPY --from=ui /build/src/mong/web/dist ./src/mong/web/dist
