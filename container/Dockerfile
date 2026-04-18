# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

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

# GitHub auth is handled by the OneCLI gateway (HTTPS_PROXY).
# The gateway intercepts requests to github.com and api.github.com and injects
# the Authorization header automatically — no token stored in the container.

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Create OneCLI credential stub files for Google services.
# These contain only sentinel values — real credentials are injected at
# request time by the OneCLI gateway when the MCP server triggers a token
# refresh. expiry_date: 0 forces an immediate refresh on first use.
# These files are safe to bake into the image as they contain no real secrets.
RUN mkdir -p /home/node/.gmail-mcp /home/node/.config/google-calendar-mcp \
    && printf '{"installed":{"client_id":"onecli-managed.apps.googleusercontent.com","client_secret":"onecli-managed","redirect_uris":["http://localhost:3000/oauth2callback"]}}' \
       > /home/node/.gmail-mcp/gcp-oauth.keys.json \
    && printf '{"access_token":"onecli-managed","refresh_token":"onecli-managed","token_type":"Bearer","expiry_date":0}' \
       > /home/node/.gmail-mcp/credentials.json \
    && printf '{"installed":{"client_id":"onecli-managed","client_secret":"onecli-managed","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","redirect_uris":["http://localhost:3000/oauth2callback"]}}' \
       > /home/node/.config/google-calendar-mcp/gcal-oauth.keys.json \
    && printf '{"access_token":"onecli-managed","refresh_token":"onecli-managed","token_type":"Bearer","expiry_date":0}' \
       > /home/node/.config/google-calendar-mcp/tokens.json \
    && chmod 600 /home/node/.gmail-mcp/gcp-oauth.keys.json \
                 /home/node/.gmail-mcp/credentials.json \
                 /home/node/.config/google-calendar-mcp/gcal-oauth.keys.json \
                 /home/node/.config/google-calendar-mcp/tokens.json

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
