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

# 1. Write managed MCP config (auto-trusted, no approval prompt).
# /etc/claude-code is world-writable via Dockerfile, no sudo needed.
# Use printf instead of echo so JSON backslash escapes aren't interpreted.
if [ -n "${NANOCLAW_MCP_CONFIG_JSON:-}" ]; then
  mkdir -p /etc/claude-code
  printf '%s\n' "$NANOCLAW_MCP_CONFIG_JSON" > /etc/claude-code/managed-mcp.json
fi

# 2. Pre-seed ~/.claude/settings.json to skip bypass-permissions warning dialog.
mkdir -p "${HOME:-/home/node}/.claude"
if [ ! -f "${HOME:-/home/node}/.claude/settings.json" ]; then
  printf '%s\n' '{"skipDangerousModePermissionPrompt":true}' > "${HOME:-/home/node}/.claude/settings.json"
fi

# Pre-seed ~/.claude.json to skip first-run onboarding prompts
# (theme selection, login method, workspace trust dialog).
# Only write if file doesn't already exist (mounted .claude/ may bring state).
if [ ! -f "${HOME:-/home/node}/.claude.json" ]; then
  cat > "${HOME:-/home/node}/.claude.json" <<JSONEOF
{
  "hasCompletedOnboarding": true,
  "lastOnboardingVersion": "2.1.86",
  "firstStartTime": "2026-01-01T00:00:00.000Z",
  "numStartups": 2,
  "projects": {
    "/workspace/group": {
      "hasTrustDialogAccepted": true,
      "projectOnboardingSeenCount": 1,
      "hasClaudeMdExternalIncludesApproved": true,
      "hasClaudeMdExternalIncludesWarningShown": true,
      "allowedTools": [],
      "mcpContextUris": [],
      "mcpServers": {},
      "enabledMcpjsonServers": [],
      "disabledMcpjsonServers": []
    }
  }
}
JSONEOF
fi

# 3. Start tmux server. Wide virtual terminal to minimize line wrapping.
tmux new-session -d -s nanoclaw -x 220 -y 50

# 4. Build claude command
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
  # Write the system prompt to a file and use command substitution — avoids
  # shell quoting pitfalls with multi-line prompts or embedded special chars
  # when the whole CLAUDE_CMD is later pasted via tmux send-keys.
  SYSPROMPT_FILE="/tmp/nanoclaw-system-prompt.txt"
  printf '%s' "$NANOCLAW_APPEND_SYSTEM_PROMPT" > "$SYSPROMPT_FILE"
  CLAUDE_CMD="${CLAUDE_CMD} --append-system-prompt \"\$(cat ${SYSPROMPT_FILE})\""
fi

echo "[entrypoint] starting claude: ${CLAUDE_CMD}" >&2

# 5. Launch claude in the tmux window
tmux send-keys -t nanoclaw:0 "${CLAUDE_CMD}" Enter

# 6. Give claude time to boot its TUI (MCP servers, session restore, etc.)
sleep 5

# 7. Run transcript-watcher sidecar in foreground. If it exits, container exits.
exec node /app/transcript-watcher/index.js
