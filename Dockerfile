FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI + compose + buildx from host
COPY docker-cli /usr/local/bin/docker
COPY docker-compose-plugin /usr/libexec/docker/cli-plugins/docker-compose
COPY docker-buildx-plugin /usr/libexec/docker/cli-plugins/docker-buildx
RUN chmod +x /usr/local/bin/docker /usr/libexec/docker/cli-plugins/*

RUN npm install -g @gitlawb/openclaude @openai/codex --quiet

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot.js memory.js linear.js deriver.js system-prompt.txt CLAUDE.md entrypoint.sh ./
COPY identity/ identity/
COPY memory-seed/ memory-seed/

# Create non-root user with docker access
RUN groupadd -r maximus && useradd -r -g maximus -d /app maximus \
    && groupadd -g 989 docker-host && usermod -aG docker-host maximus

RUN mkdir -p /app/tmp /app/data /app/.openclaude /app/.codex && chown -R maximus:maximus /app
RUN chmod +x /app/entrypoint.sh

USER maximus
ENV HOME=/app

CMD ["./entrypoint.sh"]
