# Tmux-Based Claude CLI Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Agent SDK `query()` invocation inside ephemeral containers with a long-lived `claude` CLI process running inside a persistent tmux session (one container per registered group), reading output from Claude Code's JSONL transcript file.

**Architecture:** Host-side `ContainerManager` maintains one Docker container per group. Each container runs `claude --dangerously-skip-permissions --session-id <uuid>` inside tmux. A `transcript-watcher` sidecar inside the container tails the JSONL transcript file and writes parsed assistant events to `/workspace/ipc/output/`. Host sends user messages via `tmux load-buffer` + `paste-buffer -p` + Enter, batched with a 2s debounce merge window.

**Tech Stack:** TypeScript/Node, Docker, tmux, Claude Code CLI 2.1.86, SQLite (existing).

**Reference spec:** `docs/superpowers/specs/2026-04-05-tmux-claude-cli-agent-design.md`

---

## Phase 0 — Prototype Spike (de-risk before building)

The spec flagged three items needing prototype verification. We do these FIRST in a throwaway script. If any fails, we halt and rethink before burning implementation effort.

### Task 0: Verification spike

**Files:**
- Create: `scripts/tmux-spike.sh` (throwaway)

- [ ] **Step 1: Write a manual verification script**

Create `scripts/tmux-spike.sh`:
```bash
#!/bin/bash
# Throwaway script that verifies all risky assumptions in the design.
# Runs claude CLI inside a docker container, in tmux, and checks each risk.
set -e

IMAGE="${NANOCLAW_CONTAINER_IMAGE:-nanoclaw-agent:latest}"
NAME="nanoclaw-spike-$$"
SESSION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

echo "=== Spike: Image=$IMAGE SessionId=$SESSION_ID ==="

# 1. Start container detached, override entrypoint to keep it alive
docker run -d --rm --name "$NAME" \
  --entrypoint /bin/bash \
  "$IMAGE" -c "sleep 600"

cleanup() { docker stop -t 1 "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "=== Check 1: claude --help contains --session-id ==="
docker exec "$NAME" claude --help | grep -E "^\s*--session-id" || { echo "FAIL: --session-id missing"; exit 1; }
echo "PASS"

echo "=== Check 2: tmux available in container ==="
docker exec "$NAME" which tmux || { echo "FAIL: tmux not installed"; exit 1; }
echo "PASS"

echo "=== Check 3: managed-mcp.json path writable ==="
docker exec -u root "$NAME" mkdir -p /etc/claude-code
docker exec -u root "$NAME" bash -c 'echo "{\"mcpServers\":{}}" > /etc/claude-code/managed-mcp.json'
docker exec "$NAME" cat /etc/claude-code/managed-mcp.json || { echo "FAIL: managed-mcp.json not readable"; exit 1; }
echo "PASS"

echo "=== Check 4: start claude in tmux, paste multi-line prompt ==="
docker exec "$NAME" tmux new-session -d -s nanoclaw -x 200 -y 50
docker exec "$NAME" tmux send-keys -t nanoclaw:0 "claude --dangerously-skip-permissions --session-id $SESSION_ID" Enter
sleep 8  # claude TUI startup

# Multi-line paste test
docker exec "$NAME" bash -c "printf 'line one\nline two\nline three\n\nWhat is 2+2?' | tmux load-buffer -"
docker exec "$NAME" tmux paste-buffer -p -t nanoclaw:0
docker exec "$NAME" tmux send-keys -t nanoclaw:0 Enter
echo "Sent multi-line prompt; waiting 15s for response..."
sleep 15

# Check transcript file
CWD_HASH=$(docker exec "$NAME" bash -c 'echo -n "$PWD" | sed "s|/|-|g"')
TRANSCRIPT="/home/node/.claude/projects/${CWD_HASH}/${SESSION_ID}.jsonl"
echo "Looking for transcript: $TRANSCRIPT"
docker exec "$NAME" ls -la "$(dirname $TRANSCRIPT)" || true
docker exec "$NAME" test -f "$TRANSCRIPT" || { echo "FAIL: transcript file not created"; exit 1; }
echo "PASS"

echo "=== Check 5: transcript contains multi-line user message ==="
docker exec "$NAME" grep -c '"type":"user"' "$TRANSCRIPT" || { echo "FAIL: no user events"; exit 1; }
docker exec "$NAME" grep '"line one' "$TRANSCRIPT" && echo "PASS: multiline preserved" || echo "WARN: literal newline check failed — inspect manually"

echo "=== Check 6: transcript contains assistant response ==="
docker exec "$NAME" grep -c '"type":"assistant"' "$TRANSCRIPT" || { echo "FAIL: no assistant events"; exit 1; }
echo "PASS"

echo "=== Check 7: pipe mid-turn message (asking a long-running question then sending follow-up) ==="
docker exec "$NAME" bash -c "printf 'Count slowly from 1 to 20 with one number per line' | tmux load-buffer -"
docker exec "$NAME" tmux paste-buffer -p -t nanoclaw:0
docker exec "$NAME" tmux send-keys -t nanoclaw:0 Enter
sleep 2
# While claude is responding, inject a second message
docker exec "$NAME" bash -c "printf 'also what is 5+5' | tmux load-buffer -"
docker exec "$NAME" tmux paste-buffer -p -t nanoclaw:0
docker exec "$NAME" tmux send-keys -t nanoclaw:0 Enter
sleep 20
USER_COUNT=$(docker exec "$NAME" grep -c '"type":"user"' "$TRANSCRIPT")
echo "User events after mid-turn send: $USER_COUNT (expect 2)"
[ "$USER_COUNT" -ge "2" ] || { echo "WARN: mid-turn input may have been dropped — fallback to gated mode"; }

echo ""
echo "=== ALL CHECKS COMPLETE ==="
echo "Inspect transcript manually:"
echo "  docker exec $NAME cat $TRANSCRIPT"
```

- [ ] **Step 2: Make executable and run against existing image**

```bash
chmod +x scripts/tmux-spike.sh
# First, confirm we have a built image
docker images nanoclaw-agent:latest --format '{{.ID}}' | head -1
# If no image, the spike runs tmux checks only — claude binary check will still work
./scripts/tmux-spike.sh 2>&1 | tee /tmp/spike-output.log
```

**Expected:** Checks 1-6 PASS, Check 7 may WARN. If Check 1, 4, or 5 FAIL, halt and rethink the design. If Check 7 WARNs (mid-turn input dropped), note it — implementation will use gated mode as the default.

- [ ] **Step 3: Record spike outcome**

Write findings to bottom of spec file:
```markdown

## Prototype Spike Results (2026-04-05)

- `--session-id` flag: <PASS|FAIL>
- tmux installed: <PASS|FAIL — need to add to Dockerfile>
- managed-mcp.json loadable: <PASS|FAIL>
- Multi-line paste preserves newlines: <PASS|FAIL>
- Transcript file created & populated: <PASS|FAIL>
- Mid-turn input accepted by TUI: <PASS|WARN|FAIL>

Decision: <proceed with pipe-mid-turn | fall back to gated mode>
```

- [ ] **Step 4: Commit the spike script + results**

```bash
git add scripts/tmux-spike.sh docs/superpowers/specs/2026-04-05-tmux-claude-cli-agent-design.md
git commit -m "feat: add prototype spike script for tmux+claude approach"
```

---

## Phase 1 — Container Image Changes

### Task 1: Add tmux to Dockerfile

**Files:**
- Modify: `container/Dockerfile`

- [ ] **Step 1: Add tmux to apt-get install list**

Modify the apt-get install block to include `tmux` and `jq` (for transcript parsing in shell if needed):
```dockerfile
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    ...
    tmux \
    jq \
    curl \
    git \
    ...
```

- [ ] **Step 2: Verify the image builds**

```bash
./container/build.sh
```
Expected: build succeeds; `docker run --rm nanoclaw-agent:latest which tmux` outputs `/usr/bin/tmux`.

- [ ] **Step 3: Commit**

```bash
git add container/Dockerfile
git commit -m "feat(container): install tmux and jq for cli-mode agent"
```

### Task 2: Replace entrypoint.sh

**Files:**
- Modify: `container/Dockerfile` (replace the single-line entrypoint with a copied file)
- Create: `container/entrypoint.sh` (new file in tree)

- [ ] **Step 1: Create `container/entrypoint.sh`**

```bash
#!/bin/bash
# Tmux-based Claude CLI entrypoint.
# Input: environment variables NANOCLAW_SESSION_ID, NANOCLAW_RESUME, NANOCLAW_MCP_CONFIG_JSON,
#        NANOCLAW_ALLOWED_TOOLS, NANOCLAW_ADDITIONAL_DIRS (space-separated), NANOCLAW_APPEND_SYSTEM_PROMPT
# Starts: tmux server, claude CLI inside tmux window `main`, transcript-watcher sidecar in foreground.
set -e

: "${NANOCLAW_SESSION_ID:?NANOCLAW_SESSION_ID is required}"

# 1. Write managed MCP config (auto-trusted, no approval prompt)
if [ -n "${NANOCLAW_MCP_CONFIG_JSON:-}" ]; then
  sudo mkdir -p /etc/claude-code 2>/dev/null || mkdir -p /etc/claude-code
  echo "$NANOCLAW_MCP_CONFIG_JSON" > /etc/claude-code/managed-mcp.json
fi

# 2. Start tmux server with a large virtual terminal (prevents line wrapping in transcript)
tmux new-session -d -s nanoclaw -x 200 -y 50

# 3. Build claude command
CLAUDE_CMD="claude --dangerously-skip-permissions --session-id $NANOCLAW_SESSION_ID"
if [ "${NANOCLAW_RESUME:-0}" = "1" ]; then
  CLAUDE_CMD="$CLAUDE_CMD --resume $NANOCLAW_SESSION_ID"
fi
if [ -n "${NANOCLAW_ALLOWED_TOOLS:-}" ]; then
  CLAUDE_CMD="$CLAUDE_CMD --allowed-tools \"$NANOCLAW_ALLOWED_TOOLS\""
fi
for dir in ${NANOCLAW_ADDITIONAL_DIRS:-}; do
  CLAUDE_CMD="$CLAUDE_CMD --add-dir $dir"
done
if [ -n "${NANOCLAW_APPEND_SYSTEM_PROMPT:-}" ]; then
  CLAUDE_CMD="$CLAUDE_CMD --append-system-prompt \"$NANOCLAW_APPEND_SYSTEM_PROMPT\""
fi

# 4. Launch claude in the tmux window
tmux send-keys -t nanoclaw:0 "$CLAUDE_CMD" Enter

# 5. Give claude a moment to start up
sleep 3

# 6. Run transcript-watcher sidecar in foreground (container exits if it dies)
exec node /app/transcript-watcher/index.js
```

- [ ] **Step 2: Update Dockerfile to use copied entrypoint**

Replace the `RUN printf '#!/bin/bash...' > /app/entrypoint.sh` line with:
```dockerfile
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
```

Also add sudo install (needed for managed-mcp.json) or grant node write access to /etc/claude-code:
```dockerfile
RUN mkdir -p /etc/claude-code && chown node:node /etc/claude-code
```

- [ ] **Step 3: Rebuild image and verify**

```bash
./container/build.sh
# Quick smoke test — entrypoint should fail without NANOCLAW_SESSION_ID
docker run --rm nanoclaw-agent:latest 2>&1 | grep -q "NANOCLAW_SESSION_ID is required"
```
Expected: entrypoint rejects missing env var.

- [ ] **Step 4: Commit**

```bash
git add container/Dockerfile container/entrypoint.sh
git commit -m "feat(container): tmux-based entrypoint launching claude CLI"
```

### Task 3: Create transcript-watcher sidecar

**Files:**
- Create: `container/transcript-watcher/package.json`
- Create: `container/transcript-watcher/index.js`
- Modify: `container/Dockerfile` (COPY + install deps)

- [ ] **Step 1: Create `container/transcript-watcher/package.json`**

```json
{
  "name": "nanoclaw-transcript-watcher",
  "version": "1.0.0",
  "type": "module",
  "description": "Tails Claude Code transcript JSONL and emits IPC output events",
  "main": "index.js",
  "engines": { "node": ">=20" }
}
```

No external deps — uses Node builtins only.

- [ ] **Step 2: Create `container/transcript-watcher/index.js`**

```js
#!/usr/bin/env node
/**
 * Transcript watcher for NanoClaw tmux-based agent.
 *
 * Tails ~/.claude/projects/<cwd-hash>/<session-id>.jsonl and writes
 * parsed assistant events to /workspace/ipc/output/*.json. Emits
 * turn-complete markers to /workspace/ipc/turn-complete/*. Periodically
 * snapshots the tmux pane to /workspace/ipc/health/pane.txt for host
 * health checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const SESSION_ID = process.env.NANOCLAW_SESSION_ID;
if (!SESSION_ID) {
  console.error('NANOCLAW_SESSION_ID not set');
  process.exit(1);
}

const CWD = process.cwd(); // /workspace/group (from Dockerfile WORKDIR)
const CWD_HASH = CWD.replace(/\//g, '-'); // /workspace/group -> -workspace-group
const TRANSCRIPT = path.join(
  process.env.HOME || '/home/node',
  '.claude',
  'projects',
  CWD_HASH,
  `${SESSION_ID}.jsonl`,
);

const IPC_ROOT = '/workspace/ipc';
const OUTPUT_DIR = path.join(IPC_ROOT, 'output');
const TURN_COMPLETE_DIR = path.join(IPC_ROOT, 'turn-complete');
const HEALTH_DIR = path.join(IPC_ROOT, 'health');

for (const d of [OUTPUT_DIR, TURN_COMPLETE_DIR, HEALTH_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

console.error(`[watcher] session=${SESSION_ID} transcript=${TRANSCRIPT}`);

// Wait for the transcript file to exist (claude may still be starting up)
const waitForFile = async () => {
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(TRANSCRIPT)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

const writeJson = (dir, content) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  const file = path.join(dir, `${ts}-${rand}.json`);
  fs.writeFileSync(file, JSON.stringify(content) + '\n');
};

const tailFile = async (filepath) => {
  let pos = 0;
  let buffer = '';
  while (true) {
    try {
      const stat = fs.statSync(filepath);
      if (stat.size > pos) {
        const fd = fs.openSync(filepath, 'r');
        const len = stat.size - pos;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        fs.closeSync(fd);
        pos = stat.size;
        buffer += buf.toString('utf-8');
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim()) handleLine(line);
        }
      } else if (stat.size < pos) {
        // File rotated/truncated — restart
        pos = 0;
        buffer = '';
      }
    } catch (err) {
      console.error(`[watcher] tail error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
};

const handleLine = (line) => {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // Ignore malformed
  }
  if (ev.type !== 'assistant') return;

  const msg = ev.message || {};
  const content = Array.isArray(msg.content) ? msg.content : [];
  const textBlocks = content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const toolUses = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ name: b.name, input: b.input }));

  writeJson(OUTPUT_DIR, {
    type: 'assistant',
    text: textBlocks,
    toolUses,
    stopReason: msg.stop_reason || null,
    timestamp: ev.timestamp,
    uuid: ev.uuid,
  });

  if (msg.stop_reason === 'end_turn') {
    writeJson(TURN_COMPLETE_DIR, {
      timestamp: ev.timestamp,
      uuid: ev.uuid,
    });
  }
};

// Health check: snapshot tmux pane every 5s
const healthLoop = async () => {
  while (true) {
    try {
      const out = spawnSync('tmux', ['capture-pane', '-p', '-t', 'nanoclaw:0', '-S', '-100'], { encoding: 'utf-8' });
      if (out.status === 0) {
        fs.writeFileSync(path.join(HEALTH_DIR, 'pane.txt'), out.stdout);
      }
    } catch (err) {
      console.error(`[watcher] health check failed: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
};

(async () => {
  const exists = await waitForFile();
  if (!exists) {
    console.error(`[watcher] transcript file did not appear within 60s: ${TRANSCRIPT}`);
    process.exit(1);
  }
  console.error('[watcher] transcript file found, starting tail');
  healthLoop();
  await tailFile(TRANSCRIPT);
})();
```

- [ ] **Step 3: Update Dockerfile to COPY the sidecar**

Add after the existing `COPY agent-runner/` block:
```dockerfile
# Transcript watcher sidecar (polls jsonl transcript, emits IPC events)
COPY transcript-watcher/ /app/transcript-watcher/
```

- [ ] **Step 4: Rebuild and smoke test**

```bash
./container/build.sh
# The watcher needs a transcript file; without one it'll wait 60s then exit.
# Smoke test: just verify the file got copied.
docker run --rm --entrypoint ls nanoclaw-agent:latest /app/transcript-watcher/index.js
```
Expected: path is printed.

- [ ] **Step 5: Commit**

```bash
git add container/transcript-watcher/ container/Dockerfile
git commit -m "feat(container): transcript-watcher sidecar tails claude jsonl"
```

---

## Phase 2 — Database Schema

### Task 4: Add `claude_session_id` column to `groups` table

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Read current schema and migration pattern**

```bash
grep -n "CREATE TABLE\|ALTER TABLE\|migration" src/db.ts | head -30
```

- [ ] **Step 2: Add column + migration**

Add a new migration that runs on `initDb()`:
```ts
// In the migrations section of db.ts:
db.exec(`
  ALTER TABLE groups ADD COLUMN claude_session_id TEXT;
`);
```

Wrap in try/catch since ALTER TABLE ADD COLUMN fails if column exists (SQLite has no IF NOT EXISTS for columns):
```ts
try {
  db.exec(`ALTER TABLE groups ADD COLUMN claude_session_id TEXT`);
} catch (err) {
  // Column already exists — ignore
}
```

- [ ] **Step 3: Add get/set helpers**

```ts
export function getGroupSessionId(chatJid: string): string | null {
  const row = db.prepare('SELECT claude_session_id FROM groups WHERE chat_jid = ?').get(chatJid);
  return row?.claude_session_id ?? null;
}

export function setGroupSessionId(chatJid: string, sessionId: string): void {
  db.prepare('UPDATE groups SET claude_session_id = ? WHERE chat_jid = ?').run(sessionId, chatJid);
}
```

- [ ] **Step 4: Verify schema change**

```bash
npm run build
node -e "import('./dist/db.js').then(({initDb, getGroupSessionId}) => { initDb(); console.log(getGroupSessionId('test')); })"
```
Expected: prints `null` (no rows) without error.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts
git commit -m "feat(db): add claude_session_id column and helpers"
```

---

## Phase 3 — Host-Side ContainerManager

### Task 5: Create ContainerManager skeleton

**Files:**
- Create: `src/container-manager.ts`

- [ ] **Step 1: Write skeleton with types, state, and method stubs**

```ts
/**
 * ContainerManager — maintains one long-lived Docker container per registered group.
 * Each container runs `claude` CLI inside tmux. Messages are injected via
 * `tmux load-buffer` + `paste-buffer -p` + Enter. Output is read from the
 * transcript JSONL watched by the in-container sidecar.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, IDLE_TIMEOUT, TIMEZONE } from './config.js';
import { CONTAINER_RUNTIME_BIN, CONTAINER_HOST_GATEWAY } from './container-runtime.js';
import { getGroupSessionId, setGroupSessionId } from './db.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

const MERGE_WINDOW_MS = 2000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;

export interface AssistantOutput {
  text: string;
  toolUses: Array<{ name: string; input: any }>;
  stopReason: string | null;
  timestamp: string;
}

export type OutputListener = (groupFolder: string, output: AssistantOutput) => void | Promise<void>;

interface ContainerState {
  group: RegisteredGroup;
  containerName: string;
  sessionId: string;
  mergeBuffer: string[];
  mergeTimer: NodeJS.Timeout | null;
  turnInProgress: boolean;
  lastActivity: number;
  ipcOutputWatcher: fs.FSWatcher | null;
  ipcTurnCompleteWatcher: fs.FSWatcher | null;
  healthTimer: NodeJS.Timeout | null;
  processedOutputFiles: Set<string>;
  processedTurnCompleteFiles: Set<string>;
}

export class ContainerManager {
  private states = new Map<string, ContainerState>(); // key = group.folder
  private listeners: OutputListener[] = [];
  private stopping = false;

  onOutput(listener: OutputListener): void {
    this.listeners.push(listener);
  }

  /** Idempotent: creates or adopts the container for this group. */
  async ensureRunning(group: RegisteredGroup): Promise<void> {
    // TODO
  }

  /** Adds message to the merge window; flushed after MERGE_WINDOW_MS of inactivity. */
  sendMessage(groupFolder: string, text: string): void {
    // TODO
  }

  async stopAll(): Promise<void> {
    // TODO
  }
}
```

- [ ] **Step 2: Compile check**

```bash
npm run build
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/container-manager.ts
git commit -m "feat: ContainerManager skeleton with types and state"
```

### Task 6: Implement `ensureRunning` (container start/adopt)

**Files:**
- Modify: `src/container-manager.ts`

- [ ] **Step 1: Build the volume mounts reuse**

Extract the volume-building logic from `src/container-runner.ts`. Since it's substantial, import it rather than duplicating. Refactor if needed: move `buildVolumeMounts` to exported function.

First, export `buildVolumeMounts` from `container-runner.ts`:
```ts
// In container-runner.ts, change:
// function buildVolumeMounts(...) → export function buildVolumeMounts(...)
```

- [ ] **Step 2: Implement ensureRunning**

```ts
async ensureRunning(group: RegisteredGroup): Promise<void> {
  const existing = this.states.get(group.folder);
  if (existing) {
    // Check if container is still alive
    const isRunning = this.isContainerRunning(existing.containerName);
    if (isRunning) return;
    logger.warn({ group: group.name }, 'Container died, restarting');
    this.cleanupState(existing);
    this.states.delete(group.folder);
  }

  // Check for stale container with our name and remove it
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}`;
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', containerName], { stdio: 'pipe' });
  } catch { /* no existing container */ }

  // Load or generate session id
  let sessionId = getGroupSessionId(group.chatJid);
  const resume = sessionId !== null;
  if (!sessionId) {
    sessionId = randomUUID();
    setGroupSessionId(group.chatJid, sessionId);
  }

  // Build mounts (reuse from container-runner.ts)
  const { buildVolumeMounts } = await import('./container-runner.js');
  const mounts = buildVolumeMounts(group, group.isMain ?? false);

  // Build docker run args
  const args = this.buildRunArgs(containerName, mounts, sessionId, resume, group);

  logger.info({ group: group.name, containerName, sessionId, resume }, 'Starting persistent container');
  execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe' });

  // Set up state
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  const state: ContainerState = {
    group,
    containerName,
    sessionId,
    mergeBuffer: [],
    mergeTimer: null,
    turnInProgress: false,
    lastActivity: Date.now(),
    ipcOutputWatcher: null,
    ipcTurnCompleteWatcher: null,
    healthTimer: null,
    processedOutputFiles: new Set(),
    processedTurnCompleteFiles: new Set(),
  };
  this.states.set(group.folder, state);

  // Start output watcher
  this.startOutputWatcher(state, groupIpcDir);

  // Start health check loop
  state.healthTimer = setInterval(() => this.healthCheck(state), HEALTH_CHECK_INTERVAL_MS);
}

private isContainerRunning(name: string): boolean {
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['inspect', '--format', '{{.State.Running}}', name],
      { stdio: 'pipe', encoding: 'utf-8' },
    );
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

private buildRunArgs(
  containerName: string,
  mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }>,
  sessionId: string,
  resume: boolean,
  group: RegisteredGroup,
): string[] {
  const args: string[] = ['run', '-d', '--name', containerName];
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `NANOCLAW_SESSION_ID=${sessionId}`);
  args.push('-e', `NANOCLAW_RESUME=${resume ? '1' : '0'}`);
  args.push('-e', `NANOCLAW_ALLOWED_TOOLS=${this.defaultAllowedTools()}`);
  // TODO: NANOCLAW_MCP_CONFIG_JSON, NANOCLAW_APPEND_SYSTEM_PROMPT, NANOCLAW_ADDITIONAL_DIRS
  // TODO: host gateway args, credential proxy env vars (copy from container-runner buildContainerArgs)

  for (const mount of mounts) {
    const flag = mount.readonly ? `${mount.hostPath}:${mount.containerPath}:ro` : `${mount.hostPath}:${mount.containerPath}`;
    args.push('-v', flag);
  }
  args.push(process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest');
  return args;
}

private defaultAllowedTools(): string {
  // Same list as current SDK config in container/agent-runner/src/index.ts
  return [
    'Bash','Read','Write','Edit','Glob','Grep','WebSearch','WebFetch',
    'Task','TodoWrite','ToolSearch','Skill','NotebookEdit',
    'mcp__*',
  ].join(',');
}
```

- [ ] **Step 3: Compile check**

```bash
npm run build
```
Expected: no errors. (Some TODOs remain for env vars; those get filled in the next task.)

- [ ] **Step 4: Commit**

```bash
git add src/container-manager.ts src/container-runner.ts
git commit -m "feat: ContainerManager.ensureRunning starts/adopts containers"
```

### Task 7: Complete `buildRunArgs` env var wiring

**Files:**
- Modify: `src/container-manager.ts`

- [ ] **Step 1: Copy remaining env var logic from container-runner.ts**

Look at `container-runner.ts:buildContainerArgs` lines ~280-330 and port:
- `ANTHROPIC_BASE_URL` (credential proxy)
- `CREDENTIAL_PROXY_URL`
- `HOST_BROWSER_CDP_URL`
- `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` placeholder
- `hostGatewayArgs()` call
- `--user` and `HOME` for non-root UID

Also build the MCP config JSON inline:
```ts
private buildMcpConfigJson(group: RegisteredGroup): string {
  // Mirror the 5 servers from container/agent-runner/src/index.ts
  const mcpServers: Record<string, any> = {
    nanoclaw: { command: 'node', args: ['/app/src/ipc-mcp-stdio.js'] },
    gmail: { command: 'gmail-mcp' },
    'google-calendar': { command: 'google-calendar-mcp' },
    'host-browser': { command: 'chrome-devtools-mcp', args: ['--browserUrl', process.env.HOST_BROWSER_CDP_URL || ''] },
  };
  // nuk-tpa-mcp only if its extra mount exists
  return JSON.stringify({ mcpServers });
}
```

- [ ] **Step 2: Wire into buildRunArgs**

```ts
args.push('-e', `NANOCLAW_MCP_CONFIG_JSON=${this.buildMcpConfigJson(group)}`);
```

- [ ] **Step 3: Compile + lint**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/container-manager.ts
git commit -m "feat: wire credential proxy env vars into ContainerManager"
```

### Task 8: Implement `sendMessage` with merge window

**Files:**
- Modify: `src/container-manager.ts`

- [ ] **Step 1: Implement sendMessage + flushBuffer**

```ts
sendMessage(groupFolder: string, text: string): void {
  const state = this.states.get(groupFolder);
  if (!state) {
    logger.error({ groupFolder }, 'sendMessage: no container for group');
    return;
  }
  state.mergeBuffer.push(text);
  state.lastActivity = Date.now();

  if (state.mergeTimer) clearTimeout(state.mergeTimer);
  state.mergeTimer = setTimeout(() => this.flushBuffer(state), MERGE_WINDOW_MS);
}

private flushBuffer(state: ContainerState): void {
  if (state.mergeBuffer.length === 0) return;
  const merged = state.mergeBuffer.join('\n\n');
  state.mergeBuffer = [];
  state.mergeTimer = null;

  logger.debug(
    { group: state.group.name, chars: merged.length },
    'Flushing merge buffer to claude',
  );

  try {
    // load-buffer from stdin
    const loadProc = spawn(
      CONTAINER_RUNTIME_BIN,
      ['exec', '-i', state.containerName, 'tmux', 'load-buffer', '-'],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    loadProc.stdin.write(merged);
    loadProc.stdin.end();
    loadProc.on('close', (code) => {
      if (code !== 0) {
        logger.error({ group: state.group.name, code }, 'tmux load-buffer failed');
        return;
      }
      // paste-buffer -p (bracketed paste) + Enter
      execFileSync(
        CONTAINER_RUNTIME_BIN,
        ['exec', state.containerName, 'tmux', 'paste-buffer', '-p', '-t', 'nanoclaw:0'],
        { stdio: 'pipe' },
      );
      execFileSync(
        CONTAINER_RUNTIME_BIN,
        ['exec', state.containerName, 'tmux', 'send-keys', '-t', 'nanoclaw:0', 'Enter'],
        { stdio: 'pipe' },
      );
      state.turnInProgress = true;
    });
  } catch (err) {
    logger.error({ group: state.group.name, err }, 'Failed to inject message via tmux');
  }
}
```

- [ ] **Step 2: Compile check**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/container-manager.ts
git commit -m "feat: sendMessage with 2s merge window via tmux paste-buffer"
```

### Task 9: Implement output watcher

**Files:**
- Modify: `src/container-manager.ts`

- [ ] **Step 1: Implement watcher + file processing**

```ts
private startOutputWatcher(state: ContainerState, groupIpcDir: string): void {
  const outputDir = path.join(groupIpcDir, 'output');
  const turnCompleteDir = path.join(groupIpcDir, 'turn-complete');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(turnCompleteDir, { recursive: true });

  // Process any pre-existing files first (in case host restarted mid-turn)
  this.processOutputDir(state, outputDir);
  this.processTurnCompleteDir(state, turnCompleteDir);

  state.ipcOutputWatcher = fs.watch(outputDir, { persistent: false }, (ev, filename) => {
    if (ev === 'rename' && filename) this.processOutputDir(state, outputDir);
  });
  state.ipcTurnCompleteWatcher = fs.watch(turnCompleteDir, { persistent: false }, (ev, filename) => {
    if (ev === 'rename' && filename) this.processTurnCompleteDir(state, turnCompleteDir);
  });
}

private processOutputDir(state: ContainerState, dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch { return; }
  for (const name of entries) {
    if (state.processedOutputFiles.has(name)) continue;
    state.processedOutputFiles.add(name);
    try {
      const content = fs.readFileSync(path.join(dir, name), 'utf-8');
      const ev = JSON.parse(content);
      const output: AssistantOutput = {
        text: ev.text || '',
        toolUses: ev.toolUses || [],
        stopReason: ev.stopReason,
        timestamp: ev.timestamp,
      };
      // Fire listeners async, don't block
      for (const lst of this.listeners) {
        Promise.resolve(lst(state.group.folder, output)).catch((err) =>
          logger.error({ err, group: state.group.name }, 'Output listener threw'),
        );
      }
    } catch (err) {
      logger.warn({ err, name }, 'Failed to parse output file');
    }
  }
}

private processTurnCompleteDir(state: ContainerState, dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch { return; }
  for (const name of entries) {
    if (state.processedTurnCompleteFiles.has(name)) continue;
    state.processedTurnCompleteFiles.add(name);
    state.turnInProgress = false;
    logger.debug({ group: state.group.name }, 'Turn complete');
  }
}
```

- [ ] **Step 2: Compile**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/container-manager.ts
git commit -m "feat: watch IPC output/turn-complete dirs from transcript sidecar"
```

### Task 10: Implement health check + cleanup + stopAll

**Files:**
- Modify: `src/container-manager.ts`

- [ ] **Step 1: Implement healthCheck, cleanupState, stopAll**

```ts
private async healthCheck(state: ContainerState): Promise<void> {
  if (this.stopping) return;
  const running = this.isContainerRunning(state.containerName);
  if (!running) {
    logger.warn({ group: state.group.name }, 'Container stopped, restarting');
    this.cleanupState(state);
    this.states.delete(state.group.folder);
    try {
      await this.ensureRunning(state.group);
    } catch (err) {
      logger.error({ group: state.group.name, err }, 'Restart failed');
    }
  }
}

private cleanupState(state: ContainerState): void {
  if (state.mergeTimer) clearTimeout(state.mergeTimer);
  if (state.healthTimer) clearInterval(state.healthTimer);
  state.ipcOutputWatcher?.close();
  state.ipcTurnCompleteWatcher?.close();
}

async stopAll(): Promise<void> {
  this.stopping = true;
  for (const state of this.states.values()) {
    this.cleanupState(state);
    // Leave containers running per spec — they'll be adopted on next boot.
  }
  this.states.clear();
}
```

- [ ] **Step 2: Compile**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/container-manager.ts
git commit -m "feat: health check + graceful cleanup for ContainerManager"
```

---

## Phase 4 — Wire into NanoClaw

### Task 11: Swap runContainerAgent for containerManager.sendMessage in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import and instantiate ContainerManager at startup**

```ts
// near top of index.ts
import { ContainerManager } from './container-manager.js';
const containerManager = new ContainerManager();
```

- [ ] **Step 2: Start containers for all registered groups at boot**

After `registeredGroups` is loaded but before channels start:
```ts
for (const jid of Object.keys(registeredGroups)) {
  const group = registeredGroups[jid];
  try {
    await containerManager.ensureRunning(group);
  } catch (err) {
    logger.error({ group: group.name, err }, 'Failed to start container at boot');
  }
}
```

- [ ] **Step 3: Wire output listener to channel routing**

```ts
containerManager.onOutput(async (groupFolder, output) => {
  if (!output.text) return; // Skip tool-use-only events
  const group = Object.values(registeredGroups).find((g) => g.folder === groupFolder);
  if (!group) return;
  const channel = findChannel(channels, group.chatJid);
  if (!channel) return;
  await channel.sendMessage(group.chatJid, output.text);
});
```

- [ ] **Step 4: Replace `runContainerAgent` call site with `containerManager.sendMessage`**

Find where `runContainerAgent` is called in `processGroupMessages` (around line 219). Replace with:
```ts
containerManager.sendMessage(group.folder, prompt);
```

- [ ] **Step 5: Register shutdown hook**

```ts
process.on('SIGTERM', async () => { await containerManager.stopAll(); /* ... existing cleanup */ });
```

- [ ] **Step 6: Build and smoke test**

```bash
npm run build
# Do NOT run dev yet — first verify compile.
```

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: use ContainerManager for per-group persistent containers"
```

### Task 12: Update task-scheduler to use containerManager

**Files:**
- Modify: `src/task-scheduler.ts`

- [ ] **Step 1: Pass containerManager reference into scheduler**

Update `startSchedulerLoop` signature to accept a `sendMessage` callback:
```ts
export function startSchedulerLoop(
  registeredGroups: Record<string, RegisteredGroup>,
  sendMessage: (groupFolder: string, text: string) => void,
): void { /* ... */ }
```

- [ ] **Step 2: Replace `runContainerAgent` call with sendMessage**

In `runTask()`, replace the container spawn with:
```ts
sendMessage(group.folder, `[SCHEDULED TASK — ${task.name}] ${task.prompt}`);
```

- [ ] **Step 3: Update callsite in index.ts**

```ts
startSchedulerLoop(registeredGroups, containerManager.sendMessage.bind(containerManager));
```

- [ ] **Step 4: Compile check**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/task-scheduler.ts src/index.ts
git commit -m "feat: route scheduled tasks through ContainerManager"
```

---

## Phase 5 — Manual Integration Test

### Task 13: End-to-end test

**Files:** none (manual)

- [ ] **Step 1: Rebuild container image**

```bash
./container/build.sh
```

- [ ] **Step 2: Start NanoClaw in dev mode**

```bash
npm run dev 2>&1 | tee /tmp/nanoclaw-dev.log &
sleep 15  # wait for boot + container start
```

- [ ] **Step 3: Verify container is running**

```bash
docker ps --filter name=nanoclaw- --format '{{.Names}} {{.Status}}'
```
Expected: one container per registered group, status "Up".

- [ ] **Step 4: Verify transcript watcher is alive**

```bash
CONTAINER=$(docker ps --filter name=nanoclaw- --format '{{.Names}}' | head -1)
docker exec "$CONTAINER" ps aux | grep -E "tmux|claude|transcript-watcher"
```
Expected: all three processes visible.

- [ ] **Step 5: Send a test message via WhatsApp** (or whichever channel is main)

Watch `/tmp/nanoclaw-dev.log` for:
- "Flushing merge buffer to claude"
- "Turn complete"
- Output being sent back to the channel

- [ ] **Step 6: Inspect transcript file**

```bash
docker exec "$CONTAINER" ls /home/node/.claude/projects/-workspace-group/
docker exec "$CONTAINER" tail -5 /home/node/.claude/projects/-workspace-group/*.jsonl
```

- [ ] **Step 7: Stop NanoClaw, restart, verify container is adopted**

```bash
kill %1
sleep 2
docker ps --filter name=nanoclaw-  # container should still be running
npm run dev &
# Watch log — should say "adopting existing container" not "starting"
```

- [ ] **Step 8: Commit fixes if any issues found during test**

---

## Phase 6 — Cleanup Old Code

### Task 14: Remove old agent-runner + runContainerAgent

**Files:**
- Delete: `container/agent-runner/` (but keep `ipc-mcp-stdio.js` which the new sidecar doesn't replace)
- Delete: `runContainerAgent` and `buildVolumeMounts` (if no longer imported) from `src/container-runner.ts`
- Modify: `container/Dockerfile` (remove agent-runner COPY/build)

- [ ] **Step 1: Extract ipc-mcp-stdio.js to its own location**

```bash
mkdir -p container/mcp-servers/nanoclaw-ipc
cp container/agent-runner/src/ipc-mcp-stdio.js container/mcp-servers/nanoclaw-ipc/index.js
```

- [ ] **Step 2: Update Dockerfile — remove agent-runner steps, add mcp-server**

Remove these lines from Dockerfile:
```
COPY agent-runner/package*.json ./
RUN npm ci
COPY agent-runner/ ./
RUN npm run build
```

Add:
```dockerfile
COPY mcp-servers/ /app/mcp-servers/
```

Update managed-mcp.json's nanoclaw server command to `/app/mcp-servers/nanoclaw-ipc/index.js`.

- [ ] **Step 3: Delete dead code**

```bash
rm -rf container/agent-runner
# Keep container-runner.ts for now if buildVolumeMounts is still imported, else delete
```

Check imports:
```bash
grep -rn "from.*container-runner" src/
```
If `buildVolumeMounts` is the only export used, move it into `container-manager.ts` and delete `container-runner.ts`.

- [ ] **Step 4: Rebuild image + full smoke test**

```bash
./container/build.sh
npm run build
npm run dev  # manual check again
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove old SDK-based agent-runner"
```

---

## Self-Review Checklist

- [ ] All 5 risks from spec addressed (session-id, paste-buffer, mid-stream, MCP config, resources)
- [ ] Container startup, adoption, and crash recovery covered (Tasks 6, 10)
- [ ] Merge window + paste-buffer injection implemented (Task 8)
- [ ] Output routing via transcript watcher complete (Tasks 3, 9)
- [ ] Scheduled tasks rerouted (Task 12)
- [ ] Old code removed (Task 14)
- [ ] Manual integration test covers startup, message round-trip, restart-adoption (Task 13)
