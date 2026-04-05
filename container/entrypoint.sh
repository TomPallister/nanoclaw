#!/bin/bash
# Tmux-based Claude CLI entrypoint for NanoClaw.
#
# Required env:
#   NANOCLAW_SESSION_ID       — UUID for the claude session
#
# Optional env:
#   NANOCLAW_RESUME=1         — pass --resume <session-id> to claude
#   NANOCLAW_MCP_CONFIG_JSON  — JSON written to /etc/claude-code/managed-mcp.json
#   NANOCLAW_ALLOWED_TOOLS    — comma-separated tool allowlist
#   NANOCLAW_ADDITIONAL_DIRS  — space-separated paths for --add-dir
#   NANOCLAW_APPEND_SYSTEM_PROMPT — appended to system prompt
#
# Starts: tmux server, claude CLI in window 0, transcript-watcher in foreground.
set -e

: "${NANOCLAW_SESSION_ID:?NANOCLAW_SESSION_ID is required}"

# 1. Write managed MCP config (auto-trusted, no approval prompt)
if [ -n "${NANOCLAW_MCP_CONFIG_JSON:-}" ]; then
  mkdir -p /etc/claude-code 2>/dev/null || sudo mkdir -p /etc/claude-code
  echo "$NANOCLAW_MCP_CONFIG_JSON" > /etc/claude-code/managed-mcp.json \
    || echo "$NANOCLAW_MCP_CONFIG_JSON" | sudo tee /etc/claude-code/managed-mcp.json >/dev/null
fi

# 2. Start tmux server. Wide virtual terminal to minimize line wrapping.
tmux new-session -d -s nanoclaw -x 220 -y 50

# 3. Build claude command (shell-escaped via printf %q since we send through tmux send-keys as text)
CLAUDE_CMD="claude --dangerously-skip-permissions --session-id ${NANOCLAW_SESSION_ID}"
if [ "${NANOCLAW_RESUME:-0}" = "1" ]; then
  CLAUDE_CMD="${CLAUDE_CMD} --resume ${NANOCLAW_SESSION_ID}"
fi
if [ -n "${NANOCLAW_ALLOWED_TOOLS:-}" ]; then
  CLAUDE_CMD="${CLAUDE_CMD} --allowed-tools \"${NANOCLAW_ALLOWED_TOOLS}\""
fi
if [ -n "${NANOCLAW_ADDITIONAL_DIRS:-}" ]; then
  for dir in ${NANOCLAW_ADDITIONAL_DIRS}; do
    CLAUDE_CMD="${CLAUDE_CMD} --add-dir ${dir}"
  done
fi
if [ -n "${NANOCLAW_APPEND_SYSTEM_PROMPT:-}" ]; then
  # Escape double-quotes in system prompt for safe embedding
  ESCAPED_PROMPT="${NANOCLAW_APPEND_SYSTEM_PROMPT//\"/\\\"}"
  CLAUDE_CMD="${CLAUDE_CMD} --append-system-prompt \"${ESCAPED_PROMPT}\""
fi

echo "[entrypoint] starting claude: ${CLAUDE_CMD}" >&2

# 4. Launch claude in the tmux window
tmux send-keys -t nanoclaw:0 "${CLAUDE_CMD}" Enter

# 5. Give claude time to boot its TUI (MCP servers, session restore, etc.)
sleep 5

# 6. Run transcript-watcher sidecar in foreground. If it exits, container exits.
exec node /app/transcript-watcher/index.js
