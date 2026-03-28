# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:24-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Pin all global packages to exact versions for supply chain safety.
# MCP packages are pre-installed here instead of fetched via npx at runtime.
RUN npm install -g \
    @anthropic-ai/claude-code@2.1.86 \
    @gongrzhe/server-gmail-autoauth-mcp@1.1.11 \
    @cocal/google-calendar-mcp@2.6.1 \
    chrome-devtools-mcp@0.20.3

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Git credential helper — fetches GitHub token from credential proxy on demand.
# Token passes transiently through memory, never stored in environment or on disk.
RUN printf '#!/bin/bash\nif [ "$1" != "get" ]; then exit 0; fi\nhost=""\nwhile IFS= read -r line; do\n  case "$line" in host=*) host="${line#host=}" ;; esac\n  [ -z "$line" ] && break\ndone\nif [ "$host" = "github.com" ]; then\n  TOKEN=$(curl -sf "$CREDENTIAL_PROXY_URL/github-credential")\n  if [ -n "$TOKEN" ]; then\n    echo "username=x-access-token"\n    echo "password=$TOKEN"\n  fi\nfi\n' > /usr/local/bin/github-credential-helper \
    && chmod +x /usr/local/bin/github-credential-helper \
    && git config --system credential.helper /usr/local/bin/github-credential-helper

# gh CLI wrapper — fetches GitHub token from credential proxy per invocation.
# The real gh binary is renamed; this wrapper injects auth transiently.
RUN mv /usr/bin/gh /usr/bin/gh.real \
    && printf '#!/bin/bash\nexport GH_TOKEN=$(curl -sf "$CREDENTIAL_PROXY_URL/github-credential")\nexec /usr/bin/gh.real "$@"\n' > /usr/bin/gh \
    && chmod +x /usr/bin/gh

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
