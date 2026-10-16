# VisionBackend API server (Node 20 + Python on CPU)
#
# Code lives in /app; the server runs in /data, so every folder the app builds from its
# working directory (datasets/, models/<company>/, results/, uploads/) lands on the
# /data volume and survives image updates. Base YOLO weights are copied into
# /data/models/base on first start.

FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH

# Python for the API's own scripts; libgl1 / libglib2.0-0 are needed by OpenCV
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv libgl1 libglib2.0-0 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv

WORKDIR /app

# Python packages first: they change rarely, so this layer stays cached
COPY requirements.api.txt ./
RUN pip install -r requirements.api.txt

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN chmod +x /app/docker-entrypoint.sh

WORKDIR /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "/app/server.js"]
