FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI from host
COPY docker-cli /usr/local/bin/docker
RUN chmod +x /usr/local/bin/docker

RUN npm install -g @gitlawb/openclaude

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot.js memory.js linear.js deriver.js system-prompt.txt CLAUDE.md entrypoint.sh ./
COPY identity/ identity/
COPY memory-seed/ memory-seed/

# Create non-root user with docker access
RUN groupadd -r maximus && useradd -r -g maximus -d /app maximus \
    && groupadd -g 989 docker-host && usermod -aG docker-host maximus

RUN mkdir -p /app/tmp /app/data /app/.openclaude && chown -R maximus:maximus /app
RUN chmod +x /app/entrypoint.sh

USER maximus
ENV HOME=/app

CMD ["./entrypoint.sh"]
