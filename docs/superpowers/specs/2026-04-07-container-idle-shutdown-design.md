# Container Idle Shutdown — Design

**Status:** Approved
**Date:** 2026-04-07

## Summary

Add a configurable idle shutdown timer to ContainerManager. When no messages are sent to a group's container for `CONTAINER_IDLE_SHUTDOWN_MS` (default 15 minutes), stop and remove the container. On the next message, `ensureRunning` cold-starts it with `--resume`.

## Goals

- Free RAM on resource-constrained hosts (e.g. Raspberry Pi) when the agent is idle.
- Preserve conversation history across idle shutdowns via `--resume`.
- Configurable: `CONTAINER_IDLE_SHUTDOWN_MS=0` disables idle shutdown (always-on).

## Non-Goals

- Background acknowledge/typing indicator during cold start.
- Changing the message flow, flush queue, or output watcher logic.

## Changes

### `src/config.ts`

Add `CONTAINER_IDLE_SHUTDOWN_MS` config constant (env var, default `900000` = 15 min).

### `src/container-manager.ts`

Extend the existing `healthCheck` method (runs every 30s via `setInterval`):

```
healthCheck(state):
  if stopping: return
  if !isContainerRunning: restart (existing logic)
  else if CONTAINER_IDLE_SHUTDOWN_MS > 0
       && !state.turnInProgress
       && state.mergeBuffer.length === 0
       && state.flushQueue.length === 0
       && Date.now() - state.lastActivity > CONTAINER_IDLE_SHUTDOWN_MS:
    log "idle shutdown"
    docker stop -t 5
    cleanupState(state)
    states.delete(state.group.folder)
```

Guard conditions ensure we never idle-kill a container that:
- Has an active turn (`turnInProgress`)
- Has buffered messages waiting to flush (`mergeBuffer`)
- Has in-flight flushes awaiting turn-complete (`flushQueue`)

On next `sendMessage` call: `runAgent` calls `ensureRunning` → no state found → starts fresh container with `--resume` → session restored from transcript.

### Files unchanged

- `sendMessage`, `flushNow`, `processOutputDir`, `processTurnCompleteDir` — untouched.
- `stopAll` — still force-stops everything on NanoClaw shutdown.
- Entrypoint, transcript-watcher, Dockerfile — untouched.

## Testing

- Unit test: mock `Date.now()` to advance past idle threshold, verify `docker stop` is called and state is cleaned up.
- Unit test: verify idle shutdown does NOT fire when `turnInProgress` is true.
- Integration: send a message, wait, verify container stops after idle period (manual or with short timeout).
