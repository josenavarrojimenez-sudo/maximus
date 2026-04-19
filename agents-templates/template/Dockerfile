FROM maximus-telegram-maximus-telegram:latest

USER root

ARG AGENT_UID=998
ARG AGENT_GID=998
ARG AGENT_USER=agent

RUN apt-get update -qq && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

RUN groupadd -g ${AGENT_GID} ${AGENT_USER} 2>/dev/null || true && \
    useradd -u ${AGENT_UID} -g ${AGENT_GID} -m -d /app -s /bin/sh ${AGENT_USER} 2>/dev/null || true

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY bot.js CLAUDE.md entrypoint.sh ./
RUN chmod +x entrypoint.sh && \
    mkdir -p /app/tmp /app/data /app/.openclaude && \
    chown -R ${AGENT_UID}:${AGENT_GID} /app

USER ${AGENT_USER}
ENTRYPOINT ["./entrypoint.sh"]
