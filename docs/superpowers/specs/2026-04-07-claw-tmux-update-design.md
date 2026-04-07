# Update claw CLI for tmux-based containers — Design

**Status:** Approved
**Date:** 2026-04-07

## Summary

Update `scripts/claw` to work with the new tmux-based container entrypoint. Replace stdin JSON piping + OUTPUT_START/END marker parsing with tmux `load-buffer` prompt injection + JSONL transcript tailing.

## Goals

- claw remains self-contained (no NanoClaw service required)
- Session resume (`-s`) continues working
- All existing flags preserved (`-g`, `-j`, `-i`, `--pipe`, `--list-groups`, `--timeout`, `--verbose`)
- Same UX: `claw "prompt"` prints response to stdout, session ID to stderr

## Non-Goals

- Talking to NanoClaw's persistent containers (claw runs its own ephemeral ones)
- Changing argument parsing, group resolution, or secrets handling

## Architecture

```
claw "prompt"
    │
    ├─ docker run -d --name claw-<ts> nanoclaw-agent:latest
    │   (env: NANOCLAW_SESSION_ID, NANOCLAW_RESUME, secrets, NANOCLAW_MCP_CONFIG_JSON)
    │   (mounts: .claude/ for sessions, group dir, ipc dir)
    │
    ├─ Poll for transcript file (up to 60s)
    │   ~/.claude/projects/-workspace-group/<session-id>.jsonl
    │
    ├─ Seek to end of transcript (skip history on resume)
    │
    ├─ docker exec: tmux load-buffer - (prompt via stdin)
    ├─ docker exec: tmux paste-buffer -p -t nanoclaw:0
    ├─ docker exec: tmux send-keys -t nanoclaw:0 Enter
    │
    ├─ Tail transcript for new assistant events
    │   - Collect text from events where type=assistant
    │   - Stop when stop_reason is set and != tool_use
    │
    ├─ Print collected text to stdout
    ├─ Print [session: <id>] to stderr
    │
    └─ docker stop -t 2 / docker rm -f
```

## Changes to `run_container()`

Replace the current implementation (stdin JSON pipe + stdout marker parsing) with:

1. **Start container detached** (`docker run -d`) with env vars:
   - `NANOCLAW_SESSION_ID=<uuid or resumed id>`
   - `NANOCLAW_RESUME=1` (if resuming)
   - `NANOCLAW_MCP_CONFIG_JSON={"mcpServers":{}}` (empty — claw doesn't need MCPs)
   - Secret keys from `.env` as `-e` flags
   - Same mounts as today (`.claude/`, group dir, ipc dir)

2. **Wait for transcript file** — poll `docker exec ... test -f <path>` up to 60s.

3. **Seek to end** — `docker exec ... wc -c <path>` to get initial byte position.

4. **Inject prompt** — `load-buffer` + `paste-buffer -p` + `send-keys Enter`.

5. **Tail transcript** — poll `docker exec ... tail -c +<pos> <path>`, parse JSONL lines, collect assistant text blocks. Stop on `stop_reason` not in (`tool_use`, `null`).

6. **Cleanup** — `docker stop -t 2` + `docker rm -f`.

## Session handling

- Fresh run: generate UUID, pass as `NANOCLAW_SESSION_ID`. After success, print session ID to stderr.
- Resume (`-s <id>`): pass the ID + `NANOCLAW_RESUME=1`. Transcript file already exists in mounted `.claude/`. Watcher seeks to end, only new events are processed.
- Interactive mode (`-i`): after first response, prompt for next input. Reuse same container (don't stop/restart). Just send another `load-buffer` + `paste-buffer` + `Enter` and tail again.

## Removed

- `OUTPUT_START`/`OUTPUT_END` marker parsing
- `payload` dict / stdin JSON pipe
- Container kill-on-sentinel logic

## Error handling

- Container fails to start: print docker error, exit 1
- Transcript never appears (60s): print timeout, stop container, exit 1
- Turn timeout (--timeout): stop container, exit 1
- Claude errors (stop_reason=refusal, max_tokens): print whatever text was produced, exit 0

## Testing

- Manual: `claw "What is 2+2?"` → prints response
- Manual: `claw -s <id> "Continue"` → resumes session
- Manual: `claw -i "Start a conversation"` → interactive loop
