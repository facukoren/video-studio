FROM node:24.16.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg chromium python3 python3-pip python3-venv ca-certificates tini util-linux libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm install --global @higgsfield/cli@1.1.24 @openai/codex@0.162.1
RUN python3 -m venv /opt/python && /opt/python/bin/pip install --no-cache-dir modal==1.6.1
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY assets ./assets
# Media/ASR execute on the explicitly configured Modal apps. Mount the Modal
# credentials and authenticate Codex on this host; no account secrets are baked.
# Readiness verifies the exact deployed Astra media runtime fingerprint.
ENV HOST=0.0.0.0 PORT=4142 DATA_DIR=/data PYTHON_PATH=/opt/python/bin/python MODAL_CONFIG_PATH=/credentials/modal.toml ASTRA_PATH=codex ASTRA_HOME=/home/node/.codex FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN mkdir -p /data /credentials /home/node/.codex && chown -R node:node /data /credentials /home/node/.codex
USER node
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","src/server.mjs"]
