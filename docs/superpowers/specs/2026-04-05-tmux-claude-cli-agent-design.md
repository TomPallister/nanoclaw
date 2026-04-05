# Tmux-Based Claude CLI Agent — Design

**Status:** Draft
**Date:** 2026-04-05

## Summary

Replace the current Claude Agent SDK invocation (`@anthropic-ai/claude-agent-sdk` `query()` spawned per message inside ephemeral Docker containers) with a **long-lived `claude` CLI process running inside a persistent tmux session, one container per registered group**.

Output is read primarily from Claude Code's own JSONL transcript file, with tmux pane capture used as a health-check fallback.

## Goals

- Run the real `claude` CLI (interactive mode) as the main agent rather than the Agent SDK.
- Preserve conversation history and let Claude Code handle its own compaction.
- Keep MCP servers connected across messages (no per-message re-initialization).
- Preserve current isolation model: one container per group, credential proxy, per-group mounts.

## Non-Goals

- Replacing the `/remote-control` feature (untouched).
- Removing the credential proxy (kept as-is).
- Changing any channel skill (WhatsApp, Telegram, etc.) behavior.
- Changing how scheduled tasks are scheduled (only where they run).

## Architecture

```
┌─────────────────────────── Host (NanoClaw Node process) ───────────────────────────┐
│                                                                                     │
│  channels → onMessage → MessageQueue (per-group) → ContainerManager                 │
│                                                    │                                │
│                                                    │ ensureRunning / sendMessage   │
│                                                    ▼                                │
│  ┌───────────────────── docker (one container per group) ─────────────────────┐    │
│  │ nanoclaw-<group>                                                            │    │
│  │                                                                             │    │
│  │  entrypoint.sh → starts tmux server → launches claude in window:main        │    │
│  │                                                                             │    │
│  │    tmux session "nanoclaw"                                                  │    │
│  │      window main: `claude --dangerously-skip-permissions \                  │    │
│  │                           --session-id <uuid> \                             │    │
│  │                           --add-dir ... \                                   │    │
│  │                           --allowed-tools <list> \                          │    │
│  │                           [--append-system-prompt ...]`                     │    │
│  │                                                                             │    │
│  │  transcript-watcher sidecar (Node):                                         │    │
│  │    - tails ~/.claude/projects/<cwd-hash>/<session-id>.jsonl                 │    │
│  │    - on new assistant events: writes /workspace/ipc/output/<ts>.json        │    │
│  │    - on stop_reason=end_turn: writes /workspace/ipc/turn-complete/<ts>      │    │
│  │    - periodically snapshots tmux pane → /workspace/ipc/health/pane.txt      │    │
│  └─────────────────────────────────────────────────────────────────────────────┘    │
│                                                    ▲                                │
│                                                    │ IPC file watcher              │
│                                                    │ (existing pattern)            │
│  ContainerManager reads output + turn-complete signals ─────────────────────────   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Components

### `ContainerManager` (new — replaces per-message `runContainerAgent`)

Location: `src/container-manager.ts` (new file)

Responsibilities:
- Track one container per registered group (`Map<groupFolder, ContainerState>`).
- `ensureRunning(group)` — idempotent; starts container if absent, adopts if running.
- `sendMessage(group, text)` — enqueues; sends via `docker exec ... tmux send-keys` when queue head; waits for turn-complete.
- `stop(group)` / `stopAll()` — graceful shutdown on NanoClaw exit (containers may be left running; see Restart behaviour).
- `onOutput(cb)` — emits assistant events as they appear in the transcript.
- Health monitoring: restart container if `docker inspect` shows it exited.

State per group:
```ts
interface ContainerState {
  containerName: string;            // nanoclaw-<sanitized-group>
  sessionId: string;                // persistent, stored in db
  queue: string[];                  // pending user messages
  turnInProgress: boolean;
  lastActivity: number;
}
```

### `MessageQueue` (per-group FIFO, lives inside ContainerManager)

- When user sends msg while `turnInProgress === true`, append to queue.
- When `turnInProgress` flips false (turn-complete signal received), dequeue next and send.
- Queue survives in-memory only; if NanoClaw restarts, undelivered queued messages are dropped (acceptable trade-off).

### `transcript-watcher` (new sidecar, runs inside container)

Location: `container/transcript-watcher/` (new)

Responsibilities:
- Tail `~/.claude/projects/<hashed-cwd>/<session-id>.jsonl`.
- For each new `type: "assistant"` line, extract `message.content[].text` blocks and write them as structured JSON to `/workspace/ipc/output/<ts>-<uuid>.json`.
- Detect turn completion: assistant event with `stop_reason: "end_turn"`. Write `/workspace/ipc/turn-complete/<ts>`.
- Every 5s, run `tmux capture-pane -p -t nanoclaw:main -S -100` and write to `/workspace/ipc/health/pane.txt`. Host uses this to detect stuck states (e.g., unexpected permission prompt, crash banner).

Written in Node (not shell) to share code with the rest of the runner.

### `container/entrypoint.sh` (modified)

- Writes **`/etc/claude-code/managed-mcp.json`** from env-provided MCP config (managed scope — auto-trusted, no approval prompt, cannot be modified by user).
- Starts tmux server detached: `tmux new-session -d -s nanoclaw`.
- Determines whether this is first boot (no saved session id) or resume.
- Sends the `claude ...` command to the tmux window via `send-keys`.
- Starts the `transcript-watcher` sidecar in the foreground (so container exits if watcher dies).

### Files removed / repurposed

- `container/agent-runner/src/index.ts` — the SDK-based runner. Mostly deleted; parts of IPC handling may move to `transcript-watcher`.
- `src/container-runner.ts` — `runContainerAgent` function removed. File becomes thin wrapper around container lifecycle primitives (or folded into `ContainerManager`).

## Data Flow

### Inbound (user → claude)

1. Channel receives message → `storeMessage(msg)` (unchanged).
2. `processGroupMessages` picks it up, formats the prompt as today.
3. Instead of `runContainerAgent`, calls `containerManager.sendMessage(group, prompt)`.
4. If `turnInProgress`: enqueued.
5. If idle: inject prompt into tmux pane via **bracketed paste**:
   ```bash
   printf '%s' "$prompt" | docker exec -i <container> tmux load-buffer -
   docker exec <container> tmux paste-buffer -p -t nanoclaw:main     # -p = bracketed paste
   docker exec <container> tmux send-keys -t nanoclaw:main Enter
   ```
   `-p` wraps the paste in bracketed-paste escape sequences so Claude Code's TUI treats embedded newlines as literal content (not submit). The separate `Enter` is what actually submits the turn. This is more robust than `send-keys -l` for multi-line messages.
6. `turnInProgress = true`.

### Outbound (claude → user)

1. Claude generates assistant events, written to the JSONL transcript.
2. `transcript-watcher` sees new lines, parses, writes to `/workspace/ipc/output/*.json`.
3. Host's IPC watcher (existing pattern, `src/ipc.ts`) picks up output files.
4. Router formats and sends to the channel.
5. On `stop_reason: "end_turn"`: `transcript-watcher` writes `turn-complete/<ts>`; host marks `turnInProgress = false` and dequeues next message.

### Scheduled tasks

Per user decision: **shared session**. Task scheduler calls `containerManager.sendMessage(group, "[SCHEDULED TASK — …] <task prompt>")` same as a user message. Task output appears in the ongoing conversation history.

### Image attachments

Host still downloads images to the group folder (unchanged). The message text passed to `sendMessage` includes the relative path(s) as plain text (e.g. `"[image: attachments/2026-04-05-xyz.jpg] user's text..."`). Claude reads them via the Read tool. No separate attachment-injection mechanism needed.

## Startup / Lifecycle

### NanoClaw boot

For each registered group (eager):
1. Check if container `nanoclaw-<group>` exists and is running.
   - If running: adopt. Verify tmux session exists (`docker exec ... tmux has-session -t nanoclaw`). If missing, stop container and restart.
   - If stopped/missing: start fresh (see below).
2. Begin watching that group's `/workspace/ipc/output/` dir.

### Fresh container start

1. Generate or load `sessionId` from db (`groups` table gets a new `claude_session_id` column).
2. `docker run -d --name nanoclaw-<group> ... <image>` with mounts as today.
3. Entrypoint starts tmux, writes `.mcp.json`, launches:
   ```
   claude --dangerously-skip-permissions \
          --session-id <sessionId> \
          --add-dir /workspace/extra/... \
          --allowed-tools <same list as current SDK config> \
          [--append-system-prompt "$GLOBAL_CLAUDE_MD"]   # non-main only
   ```
   On resume (transcript file for `<sessionId>` already exists), add `--resume <sessionId>`.
4. `transcript-watcher` starts tailing `<sessionId>.jsonl`.

### NanoClaw shutdown

- `SIGTERM/SIGINT`: leave containers running (they restart next boot fine). Do NOT stop them — user may be mid-conversation.
- Optional flag `--stop-containers-on-exit` for dev.

### Container crash recovery

- Health loop every 30s: `docker inspect --format '{{.State.Running}}' <name>`.
- If false: restart container (entrypoint resumes via `--resume <sessionId>`).
- If restart fails 3× in 5 min: log error, notify main group channel, give up on that group until NanoClaw restart.

### Pane health check (stuck-state detection)

Every 30s host reads `/workspace/ipc/health/pane.txt`. If it contains:
- `"Do you want to proceed?"` or similar permission text → something bypassed `--dangerously-skip-permissions`. Log + alert.
- `"command not found"` or shell prompt → claude crashed out of its TUI. Restart container.
- Unchanged for > IDLE_STUCK_THRESHOLD (default 10 min) while `turnInProgress === true` → likely stuck. Send Esc via `send-keys`, log, mark turn complete.

## Error Handling

| Failure | Detection | Recovery |
|---|---|---|
| Container exits | `docker inspect` poll | Restart with `--resume` |
| Tmux session missing | `docker exec tmux has-session` | Stop & restart container |
| Claude process exits inside tmux | Pane shows shell prompt | Restart container |
| Transcript file missing | Watcher startup check | Log, wait 10s, retry; if persistent, restart container |
| Message sent but no turn-complete for > N min | Timer in ContainerManager | Send Esc, log, mark turn complete |
| MCP server connection lost | Visible in transcript as tool error | Claude Code handles its own reconnect; log but no action |

## Session / Resume Semantics

- `sessionId` generated once per group (UUID v4), stored in SQLite (`groups.claude_session_id`).
- Same ID used forever for that group until explicitly reset.
- Reset path: new command `/reset-session` in main group → stops container, deletes session id from db, deletes transcript file, restarts with fresh session.
- Claude Code's own compaction runs inside the tmux session; transcript file updates accordingly. No host intervention needed.

## Migration

Single cutover, not a parallel path:
1. Schema migration adds `claude_session_id` column (nullable).
2. First container start for each existing group generates a new session id (no history migration from old SDK sessions — users start fresh).
3. Old `container/agent-runner/` retained in tree initially, removed in follow-up PR after stable.

## Open Questions / Risks

1. **`--session-id` flag existence.** I'm asserting this flag exists on `claude` CLI based on prior knowledge. **Must verify** by running `claude --help` on the target CLI version (2.1.86 per Dockerfile) during implementation. If absent, fall back to detecting session ID from newest `.jsonl` file after claude startup.
2. **Bracketed paste compatibility.** Spec uses `tmux load-buffer` + `paste-buffer -p` + `send-keys Enter` to handle multi-line prompts. This relies on Claude Code's TUI recognizing bracketed-paste escape sequences (which modern TUIs universally do, Claude Code included). **Must verify with a prototype** that: (a) pasted newlines become literal content not submits, (b) the trailing Enter reliably submits, (c) very long prompts don't get truncated or rate-limited by terminal input buffers.
3. **IPC mid-turn messages.** Currently the container's agent-runner polls `/workspace/ipc/input/` to receive follow-up messages mid-query. With tmux model, "follow-up" messages are just queued until turn-complete (per user decision). This is a behavior change from current IPC semantics — user accepted.
4. **Resource use.** N registered groups = N always-on containers. Each claude process uses ~200-400MB. At 10 groups that's 2-4GB resident. Acceptable for personal assistant use case.
5. ~~`.mcp.json` auto-loading.~~ **Resolved.** Project-scope `.mcp.json` auto-loads but triggers a trust-approval prompt that would hang the non-interactive tmux session. Design uses **managed scope** (`/etc/claude-code/managed-mcp.json`) instead — auto-trusted, no prompt, exclusive control over MCP set. Written by `entrypoint.sh` at container start.

## Changes to Existing Files (Summary)

| File | Change |
|---|---|
| `src/container-runner.ts` | Replaced by `src/container-manager.ts` (per-group lifecycle, not per-message spawn) |
| `src/index.ts` | Message handler calls `containerManager.sendMessage()` instead of `runContainerAgent()` |
| `src/task-scheduler.ts` | Same change — calls `containerManager.sendMessage()` |
| `src/ipc.ts` | Inbound `messages/` / `photos/` dirs retired (replaced by `sendMessage()` + `send-keys`). Still watches outbound `/workspace/ipc/output/` + new `turn-complete/`. Task-file ingestion unchanged. |
| `src/db.ts` | Adds `claude_session_id` column on `groups` table |
| `container/Dockerfile` | Adds `tmux` package; keeps `@anthropic-ai/claude-code` (already present) |
| `container/entrypoint.sh` | New: starts tmux + claude + transcript-watcher |
| `container/agent-runner/` | Deleted (or gutted to just transcript-watcher) |
| `container/transcript-watcher/` | New — tails jsonl, writes IPC output |

## Testing Strategy

- **Manual E2E first.** Before writing unit tests, get one container running end-to-end with a real message round-trip.
- Unit tests for `ContainerManager` message queueing logic (mock docker exec).
- Unit tests for `transcript-watcher` jsonl-parsing & turn-complete detection (fixture files).
- Integration test: spin up a container, send message, verify assistant output appears in IPC dir.
