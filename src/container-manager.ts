/**
 * ContainerManager — maintains one long-lived Docker container per registered
 * group. Each container runs `claude` CLI inside a tmux session, with a
 * transcript-watcher sidecar emitting assistant events to /workspace/ipc/output/.
 *
 * Message flow:
 * 1. sendMessage(groupFolder, text) — appends text to a per-group merge buffer,
 *    starts/resets a 2s debounce timer.
 * 2. When the timer fires AND turnInProgress=false: load-buffer + paste-buffer -p
 *    + Enter injects the accumulated text into the tmux pane.
 * 3. If turnInProgress=true when timer fires: pendingFlush=true; actual flush
 *    happens when the next turn-complete signal arrives.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  CONTAINER_IMAGE,
  CONTAINER_IDLE_SHUTDOWN_MS,
  CREDENTIAL_PROXY_PORT,
  TIMEZONE,
} from './config.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
} from './container-runtime.js';
import { getGroupClaudeSessionId, setGroupClaudeSessionId } from './db.js';
import { logger } from './logger.js';
import { resolveGroupIpcPath } from './group-folder.js';
import type { RegisteredGroup } from './types.js';

const MERGE_WINDOW_MS = 2000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const TURN_TIMEOUT_MS = parseInt(
  process.env.NANOCLAW_TURN_TIMEOUT_MS || '900000', // 15 min default
  10,
);

export interface AssistantOutput {
  text: string;
  toolUses: Array<{ name: string; input: unknown }>;
  stopReason: string | null;
  timestamp: string;
  uuid: string;
}

export type OutputListener = (
  groupFolder: string,
  output: AssistantOutput,
) => void | Promise<void>;

export type TurnCompleteListener = (
  groupFolder: string,
) => void | Promise<void>;

interface FlushResolver {
  resolve: () => void;
  reject: (err: Error) => void;
}

interface ContainerState {
  group: RegisteredGroup;
  chatJid: string;
  containerName: string;
  sessionId: string;
  mergeBuffer: string[];
  /** Promises waiting for the current (not-yet-flushed) merge batch to complete */
  mergeBufferResolvers: FlushResolver[];
  mergeTimer: NodeJS.Timeout | null;
  turnInProgress: boolean;
  pendingFlush: boolean; // debounce fired but turn was in progress
  /** FIFO of resolver batches, one per in-flight flush. Front = oldest pending turn. */
  flushQueue: FlushResolver[][];
  lastActivity: number;
  ipcOutputWatcher: fs.FSWatcher | null;
  ipcTurnCompleteWatcher: fs.FSWatcher | null;
  healthTimer: NodeJS.Timeout | null;
  /** Serializes output listener invocations per-group so outbound messages preserve order. */
  outputDeliveryChain: Promise<void>;
}

export class ContainerManager {
  private states = new Map<string, ContainerState>(); // key = group.folder
  private outputListeners: OutputListener[] = [];
  private turnCompleteListeners: TurnCompleteListener[] = [];
  private stopping = false;
  /** In-flight ensureRunning calls keyed by group.folder, for concurrency-safety. */
  private ensureInFlight = new Map<string, Promise<void>>();

  onOutput(listener: OutputListener): () => void {
    this.outputListeners.push(listener);
    return () => {
      const idx = this.outputListeners.indexOf(listener);
      if (idx !== -1) this.outputListeners.splice(idx, 1);
    };
  }

  onTurnComplete(listener: TurnCompleteListener): () => void {
    this.turnCompleteListeners.push(listener);
    return () => {
      const idx = this.turnCompleteListeners.indexOf(listener);
      if (idx !== -1) this.turnCompleteListeners.splice(idx, 1);
    };
  }

  /** Idempotent: creates or adopts the container for this group.
   *  Concurrent calls for the same group share a single in-flight promise. */
  ensureRunning(group: RegisteredGroup, chatJid: string): Promise<void> {
    const existing = this.ensureInFlight.get(group.folder);
    if (existing) return existing;
    const promise = this.doEnsureRunning(group, chatJid).finally(() => {
      this.ensureInFlight.delete(group.folder);
    });
    this.ensureInFlight.set(group.folder, promise);
    return promise;
  }

  private async doEnsureRunning(
    group: RegisteredGroup,
    chatJid: string,
  ): Promise<void> {
    const existing = this.states.get(group.folder);
    if (existing) {
      if (this.isContainerRunning(existing.containerName)) return;
      logger.warn({ group: group.name }, 'Container died, restarting');
      this.cleanupState(existing);
      this.states.delete(group.folder);
    }

    const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
    const containerName = `nanoclaw-${safeName}`;

    // Remove any stale container with the same name (from previous crash)
    try {
      execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', containerName], {
        stdio: 'pipe',
      });
    } catch {
      /* no existing container */
    }

    // Build mounts (imported from container-runner to share logic)
    const { buildVolumeMounts } = await import('./container-runner.js');
    const mounts = buildVolumeMounts(group, group.isMain ?? false);

    // Load session id, but only use `--resume` if the transcript file
    // actually exists on disk. Otherwise claude would error with
    // "No conversation found with session ID" and crash-loop.
    let sessionId = getGroupClaudeSessionId(chatJid);
    let resume = false;
    const isNewSession = sessionId === null;
    if (sessionId) {
      resume = this.transcriptExists(mounts, sessionId);
      if (!resume) {
        logger.warn(
          { group: group.name, sessionId },
          'Stored session id has no transcript on disk, starting fresh',
        );
        sessionId = randomUUID();
      }
    } else {
      sessionId = randomUUID();
    }

    const args = this.buildRunArgs(
      containerName,
      mounts,
      sessionId,
      resume,
      group,
      chatJid,
    );

    logger.info(
      { group: group.name, containerName, sessionId, resume },
      'Starting persistent container',
    );
    execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe' });

    // Wait for claude TUI to be ready before allowing sendMessage calls.
    // The TUI renders a ❯ (U+276F) prompt when ready to accept input.
    await this.waitForTuiReady(containerName, group.name);

    // Persist session id only AFTER successful container start so a failed
    // run doesn't leave a dangling session id in the DB.
    if (isNewSession || !resume) {
      setGroupClaudeSessionId(chatJid, sessionId);
    }

    // Set up state
    const groupIpcDir = resolveGroupIpcPath(group.folder);
    const state: ContainerState = {
      group,
      chatJid,
      containerName,
      sessionId,
      mergeBuffer: [],
      mergeBufferResolvers: [],
      mergeTimer: null,
      turnInProgress: false,
      pendingFlush: false,
      flushQueue: [],
      lastActivity: Date.now(),
      ipcOutputWatcher: null,
      ipcTurnCompleteWatcher: null,
      healthTimer: null,
      outputDeliveryChain: Promise.resolve(),
    };
    this.states.set(group.folder, state);

    this.startOutputWatchers(state, groupIpcDir);
    state.healthTimer = setInterval(
      () => this.healthCheck(state),
      HEALTH_CHECK_INTERVAL_MS,
    );
  }

  /**
   * Adds text to the merge window. Resolves when the batch containing this
   * text has been flushed to claude AND a turn-complete signal has arrived
   * specifically for that batch (in-order via the flush queue).
   */
  sendMessage(groupFolder: string, text: string): Promise<void> {
    const state = this.states.get(groupFolder);
    if (!state) {
      logger.error({ groupFolder }, 'sendMessage: no container for group');
      return Promise.reject(new Error('No container for group ' + groupFolder));
    }

    state.mergeBuffer.push(text);
    state.lastActivity = Date.now();

    // Debounce: (re)start timer
    if (state.mergeTimer) clearTimeout(state.mergeTimer);
    state.mergeTimer = setTimeout(
      () => this.onDebounceFired(state),
      MERGE_WINDOW_MS,
    );

    // Promise resolved when THIS batch's turn-complete arrives (FIFO match).
    // Wrap resolve/reject with a turn-timeout so a hung claude can't block
    // the caller indefinitely. On timeout, we also clean up the state machine
    // (turnInProgress, flushQueue) so future messages aren't permanently stuck.
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Clean up the state machine — find and remove the batch containing
        // this resolver, reset turnInProgress, and flush any pending messages.
        this.handleTurnTimeout(state, resolver);
        reject(
          new Error(
            `Turn timeout after ${TURN_TIMEOUT_MS}ms waiting for claude response`,
          ),
        );
      }, TURN_TIMEOUT_MS);
      const resolver: FlushResolver = {
        resolve: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      };
      state.mergeBufferResolvers.push(resolver);
    });
  }

  /**
   * Waits for all pending output deliveries for a group to complete.
   * Call after sendMessage resolves to ensure late-arriving output files
   * (fs.watch event ordering race) are fully delivered before unsubscribing
   * output listeners.
   */
  async drainOutputs(groupFolder: string): Promise<void> {
    const state = this.states.get(groupFolder);
    if (!state) return;
    // Wait a tick for any pending fs.watch callbacks to fire and enqueue.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Then wait for the delivery chain to settle.
    await state.outputDeliveryChain;
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    for (const state of this.states.values()) {
      // Stop the container gracefully (5s timeout before SIGKILL).
      // The credential proxy shuts down before us, so leaving containers
      // running would cause API errors inside the container.
      try {
        execFileSync(
          CONTAINER_RUNTIME_BIN,
          ['stop', '-t', '5', state.containerName],
          { stdio: 'pipe', timeout: 15000 },
        );
      } catch {
        /* already stopped or timed out */
      }
      this.cleanupState(state);
    }
    this.states.clear();
  }

  // --- private helpers ---

  /**
   * Called when a resolver's turn-timeout fires. Cleans up the state machine
   * so future messages aren't permanently stuck behind a dead turn.
   */
  private handleTurnTimeout(
    state: ContainerState,
    timedOutResolver: FlushResolver,
  ): void {
    // Find the batch that contains this resolver
    const batchIdx = state.flushQueue.findIndex((batch) =>
      batch.includes(timedOutResolver),
    );
    if (batchIdx !== -1) {
      const [batch] = state.flushQueue.splice(batchIdx, 1);
      // Reject all OTHER resolvers in the same batch (they share the same turn)
      const timeoutErr = new Error('Turn timeout (co-batched resolver)');
      for (const r of batch) {
        if (r !== timedOutResolver) r.reject(timeoutErr);
      }
    }
    // Also check mergeBufferResolvers (batch not yet flushed)
    const bufIdx = state.mergeBufferResolvers.indexOf(timedOutResolver);
    if (bufIdx !== -1) {
      state.mergeBufferResolvers.splice(bufIdx, 1);
    }

    // Reset turnInProgress if no more batches are in flight
    if (state.flushQueue.length === 0) {
      state.turnInProgress = false;
    }

    // If messages accumulated during the stuck turn, flush them now
    if (state.pendingFlush && !state.turnInProgress) {
      this.flushNow(state);
    }
  }

  private onDebounceFired(state: ContainerState): void {
    state.mergeTimer = null;
    if (state.mergeBuffer.length === 0) return;
    if (state.turnInProgress) {
      // Wait for turn-complete to trigger the flush
      state.pendingFlush = true;
      return;
    }
    this.flushNow(state);
  }

  private flushNow(state: ContainerState): void {
    if (state.mergeBuffer.length === 0) return;
    const merged = state.mergeBuffer.join('\n\n');
    state.mergeBuffer = [];
    state.pendingFlush = false;

    // Claim the resolvers for this batch and push onto the flush queue BEFORE
    // attempting the paste. If the paste fails we reject them and shift back.
    const batchResolvers = state.mergeBufferResolvers;
    state.mergeBufferResolvers = [];
    state.flushQueue.push(batchResolvers);

    // Mark turnInProgress UPFRONT (before the async load-buffer completes) so
    // a second debounce firing during the async window defers via pendingFlush
    // instead of racing a parallel flush into tmux.
    state.turnInProgress = true;

    logger.debug(
      { group: state.group.name, chars: merged.length },
      'Flushing merge buffer to claude',
    );

    const rejectBatch = (err: Error) => {
      // Remove from queue (could be anywhere if called async, so splice by ref)
      const idx = state.flushQueue.indexOf(batchResolvers);
      if (idx !== -1) state.flushQueue.splice(idx, 1);
      // Roll back turnInProgress so next sendMessage can flush normally
      state.turnInProgress = false;
      for (const r of batchResolvers) r.reject(err);
    };

    try {
      const loadProc = spawn(
        CONTAINER_RUNTIME_BIN,
        ['exec', '-i', state.containerName, 'tmux', 'load-buffer', '-'],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
      loadProc.stdin?.end(merged);
      loadProc.on('close', (code) => {
        if (code !== 0) {
          logger.error(
            { group: state.group.name, code },
            'tmux load-buffer failed',
          );
          rejectBatch(new Error(`tmux load-buffer exit ${code}`));
          return;
        }
        try {
          execFileSync(
            CONTAINER_RUNTIME_BIN,
            [
              'exec',
              state.containerName,
              'tmux',
              'paste-buffer',
              '-t',
              'nanoclaw:0',
            ],
            { stdio: 'pipe' },
          );
          execFileSync(
            CONTAINER_RUNTIME_BIN,
            [
              'exec',
              state.containerName,
              'tmux',
              'send-keys',
              '-t',
              'nanoclaw:0',
              'Enter',
            ],
            { stdio: 'pipe' },
          );
          // turnInProgress already set at flush start (see flushNow top)
        } catch (err) {
          logger.error(
            { group: state.group.name, err },
            'tmux paste/send-keys failed',
          );
          rejectBatch(
            err instanceof Error ? err : new Error('paste/send-keys failed'),
          );
        }
      });
      loadProc.on('error', (err) => {
        logger.error(
          { group: state.group.name, err },
          'tmux load-buffer spawn error',
        );
        rejectBatch(err);
      });
    } catch (err) {
      logger.error(
        { group: state.group.name, err },
        'Failed to inject message via tmux',
      );
      rejectBatch(err instanceof Error ? err : new Error('inject failed'));
    }
  }

  /** Check whether claude has a transcript file for the given session id.
   *  Uses the host-side path of the mounted .claude/ directory. */
  private transcriptExists(
    mounts: Array<{
      hostPath: string;
      containerPath: string;
      readonly: boolean;
    }>,
    sessionId: string,
  ): boolean {
    const claudeMount = mounts.find(
      (m) => m.containerPath === '/home/node/.claude',
    );
    if (!claudeMount) return false;
    // Transcript path inside container is .claude/projects/-workspace-group/<id>.jsonl
    // The '-workspace-group' hash is the container's cwd (/workspace/group).
    const transcriptPath = path.join(
      claudeMount.hostPath,
      'projects',
      '-workspace-group',
      `${sessionId}.jsonl`,
    );
    try {
      return fs.statSync(transcriptPath).isFile();
    } catch {
      return false;
    }
  }

  /** Poll the tmux pane until the claude TUI prompt (❯) appears. */
  private async waitForTuiReady(
    containerName: string,
    groupName: string,
    timeoutMs = 120_000,
  ): Promise<void> {
    const start = Date.now();
    const pollMs = 2000;
    while (Date.now() - start < timeoutMs) {
      try {
        const pane = execFileSync(
          CONTAINER_RUNTIME_BIN,
          [
            'exec',
            containerName,
            'tmux',
            'capture-pane',
            '-p',
            '-t',
            'nanoclaw:0',
          ],
          { stdio: 'pipe', encoding: 'utf-8', timeout: 10_000 },
        );
        // ❯ is U+276F — the claude TUI prompt character
        if (pane.includes('❯')) {
          logger.info(
            { group: groupName, waitMs: Date.now() - start },
            'Claude TUI ready',
          );
          return;
        }
      } catch {
        // Container or tmux not ready yet — keep polling
      }
      await new Promise<void>((r) => setTimeout(r, pollMs));
    }
    logger.warn(
      { group: groupName, timeoutMs },
      'Timed out waiting for claude TUI readiness',
    );
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
    mounts: Array<{
      hostPath: string;
      containerPath: string;
      readonly: boolean;
    }>,
    sessionId: string,
    resume: boolean,
    group: RegisteredGroup,
    chatJid: string,
  ): string[] {
    const args: string[] = ['run', '-d', '--name', containerName];

    // Host timezone
    args.push('-e', `TZ=${TIMEZONE}`);

    // Host browser CDP endpoint (always)
    args.push('-e', `HOST_BROWSER_CDP_URL=ws://${CONTAINER_HOST_GATEWAY}:9222`);

    // Auth: Claude CLI uses the host's OAuth credentials copied into the
    // per-group .claude/.credentials.json (see container-runner.ts).
    // The credential proxy is still used for GitHub tokens and other services.
    // Integration tests can override with a direct token.
    const testToken = process.env.NANOCLAW_TEST_OAUTH_TOKEN;
    if (testToken) {
      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${testToken}`);
    }
    args.push(
      '-e',
      `CREDENTIAL_PROXY_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
    );

    // Nanoclaw-specific entrypoint config
    args.push('-e', `NANOCLAW_SESSION_ID=${sessionId}`);
    args.push('-e', `NANOCLAW_RESUME=${resume ? '1' : '0'}`);
    args.push('-e', `NANOCLAW_ALLOWED_TOOLS=${this.defaultAllowedTools()}`);
    args.push(
      '-e',
      `NANOCLAW_MCP_CONFIG_JSON=${this.buildMcpConfigJson(group)}`,
    );
    args.push('-e', `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`);
    args.push('-e', `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`);
    args.push('-e', `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0`);

    // Env vars consumed by the nanoclaw IPC MCP server (reads chat/group context)
    args.push('-e', `NANOCLAW_CHAT_JID=${chatJid}`);
    args.push('-e', `NANOCLAW_GROUP_FOLDER=${group.folder}`);
    args.push('-e', `NANOCLAW_IS_MAIN=${group.isMain ? '1' : '0'}`);

    // Host gateway for Linux
    args.push(...hostGatewayArgs());

    // Run as host user when possible (bind-mount permissions)
    const hostUid = process.getuid?.();
    const hostGid = process.getgid?.();
    if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
      args.push('--user', `${hostUid}:${hostGid}`);
      args.push('-e', 'HOME=/home/node');
    }

    // Mounts
    for (const m of mounts) {
      const vol = m.readonly
        ? `${m.hostPath}:${m.containerPath}:ro`
        : `${m.hostPath}:${m.containerPath}`;
      args.push('-v', vol);
    }

    args.push(CONTAINER_IMAGE);
    return args;
  }

  private defaultAllowedTools(): string {
    // Mirror current SDK config in container/agent-runner/src/index.ts
    return [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
      'Task',
      'TodoWrite',
      'ToolSearch',
      'Skill',
      'NotebookEdit',
      'mcp__*',
    ].join(',');
  }

  private buildMcpConfigJson(_group: RegisteredGroup): string {
    // Mirror the MCP servers from container/agent-runner/src/index.ts.
    // Paths assume the image was built with the agent-runner TypeScript
    // compiled into /app/dist/ (Dockerfile runs `npm run build`).
    const mcpServers: Record<string, unknown> = {
      nanoclaw: {
        command: 'node',
        args: ['/app/dist/ipc-mcp-stdio.js'],
      },
      gmail: { command: 'gmail-mcp' },
      'google-calendar': { command: 'google-calendar-mcp' },
      'host-browser': {
        command: 'chrome-devtools-mcp',
        args: ['--browserUrl', `ws://${CONTAINER_HOST_GATEWAY}:9222`],
      },
    };
    return JSON.stringify({ mcpServers });
  }

  // --- Output / turn-complete watchers ---

  private startOutputWatchers(
    state: ContainerState,
    groupIpcDir: string,
  ): void {
    const outputDir = path.join(groupIpcDir, 'output');
    const turnCompleteDir = path.join(groupIpcDir, 'turn-complete');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(turnCompleteDir, { recursive: true });

    // Delete any stale files from a previous run — they correspond to flush
    // queue state that no longer exists, so processing them would misalign
    // the FIFO queue. Fresh start.
    for (const name of safeReaddir(outputDir)) {
      try {
        fs.unlinkSync(path.join(outputDir, name));
      } catch {
        /* ignore */
      }
    }
    for (const name of safeReaddir(turnCompleteDir)) {
      try {
        fs.unlinkSync(path.join(turnCompleteDir, name));
      } catch {
        /* ignore */
      }
    }

    state.ipcOutputWatcher = fs.watch(
      outputDir,
      { persistent: false },
      (ev, filename) => {
        if (ev === 'rename' && filename) {
          this.processOutputDir(state, outputDir);
        }
      },
    );
    state.ipcTurnCompleteWatcher = fs.watch(
      turnCompleteDir,
      { persistent: false },
      (ev, filename) => {
        if (ev === 'rename' && filename) {
          this.processTurnCompleteDir(state, turnCompleteDir);
        }
      },
    );
  }

  private processOutputDir(state: ContainerState, dir: string): void {
    const entries = safeReaddir(dir).sort();
    for (const name of entries) {
      // Skip .tmp files — container writes tmp then renames atomically.
      // Reading/deleting a .tmp would race the container's rename.
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(dir, name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        // File raced-deleted by another handler or still mid-write; skip.
        // Will be retried on the next fs.watch tick if it still exists.
        continue;
      }
      let ev: {
        text?: string;
        toolUses?: Array<{ name: string; input: unknown }>;
        stopReason?: string | null;
        timestamp?: string;
        uuid?: string;
      };
      try {
        ev = JSON.parse(content);
      } catch (err) {
        logger.warn({ err, name }, 'Failed to parse output file, deleting');
        // Delete corrupted file so we don't loop on it forever.
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* already gone */
        }
        continue;
      }
      const output: AssistantOutput = {
        text: ev.text ?? '',
        toolUses: ev.toolUses ?? [],
        stopReason: ev.stopReason ?? null,
        timestamp: ev.timestamp ?? '',
        uuid: ev.uuid ?? '',
      };
      // Serialize output delivery per group so listeners (channel.sendMessage)
      // preserve the order in which transcript events were written.
      const listeners = [...this.outputListeners];
      state.outputDeliveryChain = state.outputDeliveryChain.then(async () => {
        for (const lst of listeners) {
          try {
            await lst(state.group.folder, output);
          } catch (err) {
            logger.error(
              { err, group: state.group.name },
              'Output listener threw',
            );
          }
        }
      });
      // Delete the file synchronously (before the async delivery runs) so a
      // second fs.watch event for the same file doesn't re-queue delivery.
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* already gone */
      }
    }
  }

  private processTurnCompleteDir(state: ContainerState, dir: string): void {
    const entries = safeReaddir(dir).sort();
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(dir, name);
      // Delete FIRST so a re-fired fs.watch event doesn't reprocess the same
      // turn-complete marker (which would spuriously shift the flush queue).
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Already gone — raced with another handler; skip.
        continue;
      }

      state.turnInProgress = false;
      logger.debug({ group: state.group.name }, 'Turn complete');

      // Resolve the oldest pending flush's resolvers (FIFO match with turn).
      // Chain the resolve onto outputDeliveryChain so sendMessage promises only
      // resolve AFTER any assistant outputs from this turn have been delivered.
      const batch = state.flushQueue.shift();
      if (batch) {
        state.outputDeliveryChain = state.outputDeliveryChain.then(() => {
          for (const r of batch) r.resolve();
        });
      }

      // Fire any external turn-complete listeners
      for (const lst of [...this.turnCompleteListeners]) {
        Promise.resolve(lst(state.group.folder)).catch((err) =>
          logger.error(
            { err, group: state.group.name },
            'Turn-complete listener threw',
          ),
        );
      }

      // If a flush is pending from a debounce during this turn, fire it now
      if (state.pendingFlush) {
        this.flushNow(state);
      }
    }
  }

  // --- Health monitoring + cleanup ---

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

  private cleanupState(state: ContainerState): void {
    if (state.mergeTimer) clearTimeout(state.mergeTimer);
    if (state.healthTimer) clearInterval(state.healthTimer);
    state.ipcOutputWatcher?.close();
    state.ipcTurnCompleteWatcher?.close();

    // Reject any outstanding promises so callers don't hang forever.
    const err = new Error('Container stopped before turn completed');
    for (const r of state.mergeBufferResolvers) r.reject(err);
    state.mergeBufferResolvers = [];
    for (const batch of state.flushQueue) {
      for (const r of batch) r.reject(err);
    }
    state.flushQueue = [];
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
