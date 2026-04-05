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

import { CONTAINER_IMAGE, TIMEZONE } from './config.js';
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
  processedOutputFiles: Set<string>;
  processedTurnCompleteFiles: Set<string>;
}

export class ContainerManager {
  private states = new Map<string, ContainerState>(); // key = group.folder
  private outputListeners: OutputListener[] = [];
  private turnCompleteListeners: TurnCompleteListener[] = [];
  private stopping = false;

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

  /** Idempotent: creates or adopts the container for this group. */
  async ensureRunning(group: RegisteredGroup, chatJid: string): Promise<void> {
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

    // Load or generate session id
    let sessionId = getGroupClaudeSessionId(chatJid);
    const resume = sessionId !== null;
    if (!sessionId) {
      sessionId = randomUUID();
      setGroupClaudeSessionId(chatJid, sessionId);
    }

    // Build mounts (imported from container-runner to share logic)
    const { buildVolumeMounts } = await import('./container-runner.js');
    const mounts = buildVolumeMounts(group, group.isMain ?? false);

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
      processedOutputFiles: new Set(),
      processedTurnCompleteFiles: new Set(),
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

    // Promise resolved when THIS batch's turn-complete arrives (FIFO match)
    return new Promise<void>((resolve, reject) => {
      state.mergeBufferResolvers.push({ resolve, reject });
    });
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    for (const state of this.states.values()) {
      this.cleanupState(state);
    }
    this.states.clear();
  }

  // --- private helpers ---

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

    logger.debug(
      { group: state.group.name, chars: merged.length },
      'Flushing merge buffer to claude',
    );

    const rejectBatch = (err: Error) => {
      // Remove from queue (could be anywhere if called async, so splice by ref)
      const idx = state.flushQueue.indexOf(batchResolvers);
      if (idx !== -1) state.flushQueue.splice(idx, 1);
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
              '-p',
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
          state.turnInProgress = true;
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
      rejectBatch(
        err instanceof Error ? err : new Error('inject failed'),
      );
    }
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

    // Auth: production path routes through credential proxy with placeholder.
    // Integration tests set NANOCLAW_TEST_OAUTH_TOKEN to bypass proxy.
    const testToken = process.env.NANOCLAW_TEST_OAUTH_TOKEN;
    if (testToken) {
      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${testToken}`);
    } else {
      args.push(
        '-e',
        `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:9222`,
      );
      args.push(
        '-e',
        `CREDENTIAL_PROXY_URL=http://${CONTAINER_HOST_GATEWAY}:9222`,
      );
      args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
      args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
    }

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

    // Mark any existing files as processed (from previous boot)
    for (const name of safeReaddir(outputDir)) {
      state.processedOutputFiles.add(name);
    }
    for (const name of safeReaddir(turnCompleteDir)) {
      state.processedTurnCompleteFiles.add(name);
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
      if (state.processedOutputFiles.has(name)) continue;
      state.processedOutputFiles.add(name);
      let content: string;
      try {
        content = fs.readFileSync(path.join(dir, name), 'utf-8');
      } catch {
        continue; // file may be mid-write or already consumed
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
        logger.warn({ err, name }, 'Failed to parse output file');
        continue;
      }
      const output: AssistantOutput = {
        text: ev.text ?? '',
        toolUses: ev.toolUses ?? [],
        stopReason: ev.stopReason ?? null,
        timestamp: ev.timestamp ?? '',
        uuid: ev.uuid ?? '',
      };
      for (const lst of this.outputListeners) {
        Promise.resolve(lst(state.group.folder, output)).catch((err) =>
          logger.error(
            { err, group: state.group.name },
            'Output listener threw',
          ),
        );
      }
    }
  }

  private processTurnCompleteDir(state: ContainerState, dir: string): void {
    const entries = safeReaddir(dir).sort();
    for (const name of entries) {
      if (state.processedTurnCompleteFiles.has(name)) continue;
      state.processedTurnCompleteFiles.add(name);
      state.turnInProgress = false;
      logger.debug({ group: state.group.name }, 'Turn complete');

      // Resolve the oldest pending flush's resolvers (FIFO match with turn)
      const batch = state.flushQueue.shift();
      if (batch) {
        for (const r of batch) r.resolve();
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
