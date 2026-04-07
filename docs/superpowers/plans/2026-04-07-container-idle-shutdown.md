# Container Idle Shutdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop idle containers after 15 minutes to free RAM, resuming the session on next message.

**Architecture:** Add `CONTAINER_IDLE_SHUTDOWN_MS` config. Extend the existing 30s `healthCheck` to also check idle time. When idle threshold exceeded and no work in-flight, `docker stop` + cleanup. `ensureRunning` already handles cold-start with `--resume`.

**Tech Stack:** TypeScript/Node

**Reference spec:** `docs/superpowers/specs/2026-04-07-container-idle-shutdown-design.md`

---

## File Structure

- Modify: `src/config.ts` — add config constant
- Modify: `src/container-manager.ts` — extend `healthCheck` with idle shutdown logic
- Modify: `src/container-manager.test.ts` — add idle shutdown tests

---

### Task 1: Add config constant

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add CONTAINER_IDLE_SHUTDOWN_MS**

After the existing `IDLE_TIMEOUT` line (~line 59), add:

```typescript
export const CONTAINER_IDLE_SHUTDOWN_MS = parseInt(
  process.env.CONTAINER_IDLE_SHUTDOWN_MS || '900000', // 15 min default; 0 = disabled (always-on)
  10,
);
```

- [ ] **Step 2: Compile check**

```bash
npx tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add CONTAINER_IDLE_SHUTDOWN_MS config (default 15 min)"
```

---

### Task 2: Extend healthCheck with idle shutdown

**Files:**
- Modify: `src/container-manager.ts`

- [ ] **Step 1: Import the new config**

Add `CONTAINER_IDLE_SHUTDOWN_MS` to the import from `./config.js`:

```typescript
import { CONTAINER_IMAGE, CONTAINER_IDLE_SHUTDOWN_MS, TIMEZONE } from './config.js';
```

- [ ] **Step 2: Remove the module-level HEALTH_CHECK_INTERVAL_MS if unused elsewhere, or keep it**

Keep `HEALTH_CHECK_INTERVAL_MS = 30_000` as-is — it's the poll interval, not the idle threshold.

- [ ] **Step 3: Extend healthCheck method**

Replace the `healthCheck` method (around line 776-792) with:

```typescript
  private async healthCheck(state: ContainerState): Promise<void> {
    if (this.stopping) return;
    if (!this.isContainerRunning(state.containerName)) {
      logger.warn(
        { group: state.group.name },
        'Container not running, restarting',
      );
      const { group, chatJid } = state;
      this.cleanupState(state);
      this.states.delete(state.group.folder);
      try {
        await this.ensureRunning(group, chatJid);
      } catch (err) {
        logger.error({ group: group.name, err }, 'Restart failed');
      }
      return;
    }

    // Idle shutdown: stop the container if no activity for CONTAINER_IDLE_SHUTDOWN_MS.
    // Only when: idle shutdown enabled, no turn in progress, no buffered/queued work.
    if (
      CONTAINER_IDLE_SHUTDOWN_MS > 0 &&
      !state.turnInProgress &&
      state.mergeBuffer.length === 0 &&
      state.flushQueue.length === 0 &&
      Date.now() - state.lastActivity > CONTAINER_IDLE_SHUTDOWN_MS
    ) {
      logger.info(
        { group: state.group.name, idleMs: Date.now() - state.lastActivity },
        'Idle shutdown: stopping container',
      );
      try {
        execFileSync(
          CONTAINER_RUNTIME_BIN,
          ['stop', '-t', '5', state.containerName],
          { stdio: 'pipe', timeout: 15000 },
        );
      } catch {
        /* already stopped */
      }
      this.cleanupState(state);
      this.states.delete(state.group.folder);
    }
  }
```

- [ ] **Step 4: Compile check**

```bash
npx tsc
```

- [ ] **Step 5: Run existing tests**

```bash
npx vitest run
```

Expected: all 327 tests pass (no behavioral change to existing tests).

- [ ] **Step 6: Commit**

```bash
git add src/container-manager.ts
git commit -m "feat: idle shutdown stops container after 15 min inactivity"
```

---

### Task 3: Add unit tests for idle shutdown

**Files:**
- Modify: `src/container-manager.test.ts`

- [ ] **Step 1: Add idle shutdown tests**

Add a new describe block to the test file:

```typescript
describe('idle shutdown', () => {
  it('stops container when idle exceeds threshold', async () => {
    // Set up a running container state
    mockExecFileSync.mockReturnValue(''); // rm -f, docker run, etc
    mockGetGroupClaudeSessionId.mockReturnValue(null);
    mockResolveGroupIpcPath.mockReturnValue('/tmp/test-ipc');
    mockBuildVolumeMounts.mockReturnValue([]);

    const mgr = new ContainerManager();
    await mgr.ensureRunning(testGroup, testJid);

    // Advance time past the idle threshold (default 900000ms = 15 min)
    vi.advanceTimersByTime(HEALTH_CHECK_INTERVAL_MS); // trigger first health check
    // Container is running and recently active — should NOT shut down
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['stop']),
      expect.anything(),
    );

    // Now simulate idle: advance past threshold
    vi.advanceTimersByTime(900_001);
    // Health check fires and sees idle > threshold
    // Verify docker stop was called
    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '5', expect.stringContaining('nanoclaw-')],
      expect.objectContaining({ timeout: 15000 }),
    );
  });

  it('does NOT stop container when turnInProgress', async () => {
    mockExecFileSync.mockReturnValue('');
    mockGetGroupClaudeSessionId.mockReturnValue(null);
    mockResolveGroupIpcPath.mockReturnValue('/tmp/test-ipc');
    mockBuildVolumeMounts.mockReturnValue([]);

    const mgr = new ContainerManager();
    await mgr.ensureRunning(testGroup, testJid);

    // Start a message (sets turnInProgress via flush)
    const proc = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc);
    const promise = mgr.sendMessage(testGroup.folder, 'hello');
    vi.advanceTimersByTime(2001); // debounce fires → flushNow
    proc._emit('close', 0); // load-buffer succeeds → turnInProgress = true

    // Advance well past idle threshold
    vi.advanceTimersByTime(1_000_000);

    // docker stop should NOT have been called (turn is in progress)
    const stopCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('stop'),
    );
    expect(stopCalls).toHaveLength(0);

    // Clean up: resolve the turn
    promise.catch(() => {}); // prevent unhandled rejection
    await mgr.stopAll();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/container-manager.test.ts
```

Expected: all tests pass including new ones.

- [ ] **Step 3: Run full suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/container-manager.test.ts
git commit -m "test: add idle shutdown unit tests"
```

---

## Self-Review

- [x] Spec coverage: config constant (Task 1), healthCheck extension (Task 2), guard conditions (Task 2 — checks turnInProgress, mergeBuffer, flushQueue), tests (Task 3)
- [x] No placeholders
- [x] Type consistency: `CONTAINER_IDLE_SHUTDOWN_MS` name matches between config.ts import and usage in container-manager.ts
