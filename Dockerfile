FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    bash \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Claude Code
WORKDIR /tmp/claude-install
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && ln -sf /root/.local/bin/claude /usr/local/bin/claude \
    && claude --version

# Telegram bot
WORKDIR /app

COPY package*.json ./

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]
