FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @gitlawb/openclaude

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot.js memory.js system-prompt.txt ./
COPY identity/ identity/
COPY memory-seed/ memory-seed/

RUN mkdir -p /app/tmp

CMD ["node", "bot.js"]
