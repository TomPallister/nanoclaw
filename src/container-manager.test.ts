import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Set test-friendly timeout BEFORE any module imports ---
// vi.hoisted runs before vi.mock hoisting, ensuring the env var is set
// before the container-manager module evaluates TURN_TIMEOUT_MS.
vi.hoisted(() => {
  process.env.NANOCLAW_TURN_TIMEOUT_MS = '5000';
});

// --- Mock logger ---
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Mock child_process ---
const mockExecFileSync = vi.fn();
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// --- Mock node:fs ---
const mockWatch = vi.fn();
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockStatSync = vi.fn();
vi.mock('node:fs', () => ({
  default: {
    watch: (...args: unknown[]) => mockWatch(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
  },
}));

// --- Mock node:crypto ---
const mockRandomUUID = vi.fn();
vi.mock('node:crypto', () => ({
  randomUUID: () => mockRandomUUID(),
}));

// --- Mock NanoClaw deps ---
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'test-image:latest',
  CONTAINER_IDLE_SHUTDOWN_MS: 900_000,
  TIMEZONE: 'UTC',
}));
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
}));

const mockGetGroupClaudeSessionId = vi.fn();
const mockSetGroupClaudeSessionId = vi.fn();
vi.mock('./db.js', () => ({
  getGroupClaudeSessionId: (...args: unknown[]) =>
    mockGetGroupClaudeSessionId(...args),
  setGroupClaudeSessionId: (...args: unknown[]) =>
    mockSetGroupClaudeSessionId(...args),
}));

const mockResolveGroupIpcPath = vi.fn();
vi.mock('./group-folder.js', () => ({
  resolveGroupIpcPath: (...args: unknown[]) => mockResolveGroupIpcPath(...args),
}));

const mockBuildVolumeMounts = vi.fn();
vi.mock('./container-runner.js', () => ({
  buildVolumeMounts: (...args: unknown[]) => mockBuildVolumeMounts(...args),
}));

// --- Import SUT after all mocks ---
import { ContainerManager } from './container-manager.js';
import type { RegisteredGroup } from './types.js';

// --- Test helpers ---

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '^!claude',
  added_at: '2026-01-01T00:00:00.000Z',
  isMain: true,
};
const testJid = 'test@g.us';

const defaultMounts = [
  {
    hostPath: '/host/.claude',
    containerPath: '/home/node/.claude',
    readonly: false,
  },
  {
    hostPath: '/host/groups/test-group',
    containerPath: '/workspace/group',
    readonly: false,
  },
];

function createMockProc(exitCode = 0) {
  const handlers: Record<string, Function> = {};
  const proc = {
    stdin: { end: vi.fn(), write: vi.fn() },
    on: vi.fn((event: string, cb: Function) => {
      handlers[event] = cb;
      return proc;
    }),
    _emit: (event: string, ...args: unknown[]) => handlers[event]?.(...args),
  };
  // Auto-fire close after microtask if exitCode provided
  return { proc, handlers };
}

let outputWatchCallback: Function;
let turnCompleteWatchCallback: Function;
const watchCloseFns: Array<ReturnType<typeof vi.fn>> = [];

function setupDefaultMocks() {
  mockRandomUUID.mockReturnValue('test-uuid-1234');
  mockGetGroupClaudeSessionId.mockReturnValue(null);
  mockBuildVolumeMounts.mockReturnValue(defaultMounts);
  mockResolveGroupIpcPath.mockReturnValue('/ipc/test-group');

  // execFileSync: first call = rm -f (cleanup), second call = docker run
  // Then isContainerRunning calls etc.
  mockExecFileSync.mockReturnValue('');

  // fs.watch: capture callbacks
  mockWatch.mockImplementation((dir: string, _opts: unknown, cb: Function) => {
    if (dir.includes('output')) outputWatchCallback = cb;
    if (dir.includes('turn-complete')) turnCompleteWatchCallback = cb;
    const closeFn = vi.fn();
    watchCloseFns.push(closeFn);
    return { close: closeFn };
  });

  // readdirSync returns empty by default (stale file cleanup on startup)
  mockReaddirSync.mockReturnValue([]);
  mockMkdirSync.mockReturnValue(undefined);
  mockUnlinkSync.mockReturnValue(undefined);
}

let mgr: ContainerManager;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockSpawn.mockReset();
  watchCloseFns.length = 0;
  setupDefaultMocks();
  mgr = new ContainerManager();
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// onOutput / onTurnComplete
// ===========================================================================

describe('onOutput / onTurnComplete', () => {
  it('registers listener and returns unsubscribe function', () => {
    const listener = vi.fn();
    const unsub = mgr.onOutput(listener);
    expect(typeof unsub).toBe('function');
  });

  it('unsubscribe removes the listener', async () => {
    const listener = vi.fn();
    const unsub = mgr.onOutput(listener);
    unsub();

    // Start container, simulate output, verify listener NOT called
    await mgr.ensureRunning(testGroup, testJid);
    mockReaddirSync.mockReturnValueOnce(['out.json']);
    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({
        text: 'hi',
        toolUses: [],
        stopReason: 'end_turn',
        timestamp: '2026-01-01',
        uuid: 'u1',
      }),
    );
    outputWatchCallback('rename', 'out.json');
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('multiple listeners all fire', async () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    mgr.onOutput(l1);
    mgr.onOutput(l2);

    await mgr.ensureRunning(testGroup, testJid);
    mockReaddirSync.mockReturnValueOnce(['out.json']);
    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({
        text: 'hello',
        toolUses: [],
        stopReason: 'end_turn',
        timestamp: '2026-01-01',
        uuid: 'u1',
      }),
    );
    outputWatchCallback('rename', 'out.json');
    await vi.advanceTimersByTimeAsync(0);
    expect(l1).toHaveBeenCalledWith(
      'test-group',
      expect.objectContaining({ text: 'hello' }),
    );
    expect(l2).toHaveBeenCalledWith(
      'test-group',
      expect.objectContaining({ text: 'hello' }),
    );
  });

  it('onTurnComplete registers and unsubscribes', async () => {
    const listener = vi.fn();
    const unsub = mgr.onTurnComplete(listener);

    await mgr.ensureRunning(testGroup, testJid);

    // Fire turn complete
    mockReaddirSync.mockReturnValueOnce(['tc.json']);
    turnCompleteWatchCallback('rename', 'tc.json');
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledWith('test-group');

    listener.mockClear();
    unsub();
    mockReaddirSync.mockReturnValueOnce(['tc2.json']);
    turnCompleteWatchCallback('rename', 'tc2.json');
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// ensureRunning
// ===========================================================================

describe('ensureRunning', () => {
  it('fresh start: generates UUID, calls docker run, sets state', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    expect(mockRandomUUID).toHaveBeenCalled();
    expect(mockSetGroupClaudeSessionId).toHaveBeenCalledWith(
      testJid,
      'test-uuid-1234',
    );
    // rm -f call + docker run call
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'nanoclaw-test-group']),
      expect.any(Object),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['run', '-d', '--name', 'nanoclaw-test-group']),
      expect.any(Object),
    );
  });

  it('idempotent: second call returns immediately if container is running', async () => {
    await mgr.ensureRunning(testGroup, testJid);
    const callCount = mockExecFileSync.mock.calls.length;

    // isContainerRunning returns true
    mockExecFileSync.mockReturnValueOnce('true');
    await mgr.ensureRunning(testGroup, testJid);

    // Only one additional call for isContainerRunning check
    expect(mockExecFileSync.mock.calls.length).toBe(callCount + 1);
  });

  it('concurrent calls share same promise', async () => {
    const p1 = mgr.ensureRunning(testGroup, testJid);
    const p2 = mgr.ensureRunning(testGroup, testJid);
    expect(p1).toBe(p2);
    await p1;
  });

  it('restarts dead container when isContainerRunning returns false', async () => {
    await mgr.ensureRunning(testGroup, testJid);
    const firstRunCalls = mockExecFileSync.mock.calls.length;

    // isContainerRunning returns false (container died)
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === 'inspect') throw new Error('no such container');
      return '';
    });
    mockReaddirSync.mockReturnValue([]);

    await mgr.ensureRunning(testGroup, testJid);

    // Should have called docker run again
    const runCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => (c[1] as string[])[0] === 'run',
    );
    expect(runCalls.length).toBe(2);
  });

  it('session resume: passes --resume when transcript exists', async () => {
    mockGetGroupClaudeSessionId.mockReturnValue('existing-session-id');
    mockStatSync.mockReturnValue({ isFile: () => true });

    await mgr.ensureRunning(testGroup, testJid);

    // Should NOT generate a new UUID
    const runCall = mockExecFileSync.mock.calls.find(
      (c: unknown[]) => (c[1] as string[])[0] === 'run',
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).toContain('NANOCLAW_RESUME=1');
    // Should NOT call setGroupClaudeSessionId (not new, resume=true)
    expect(mockSetGroupClaudeSessionId).not.toHaveBeenCalled();
  });

  it('session fresh: generates new UUID when transcript does not exist', async () => {
    mockGetGroupClaudeSessionId.mockReturnValue('old-session-id');
    mockStatSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    await mgr.ensureRunning(testGroup, testJid);

    expect(mockRandomUUID).toHaveBeenCalled();
    const runCall = mockExecFileSync.mock.calls.find(
      (c: unknown[]) => (c[1] as string[])[0] === 'run',
    );
    const runArgs = runCall![1] as string[];
    // Should contain the new UUID, not the old one
    expect(runArgs.join(' ')).toContain('test-uuid-1234');
    expect(runArgs).toContain('NANOCLAW_RESUME=0');
    expect(mockSetGroupClaudeSessionId).toHaveBeenCalledWith(
      testJid,
      'test-uuid-1234',
    );
  });
});

// ===========================================================================
// sendMessage
// ===========================================================================

describe('sendMessage', () => {
  it('rejects if no container for group', async () => {
    await expect(mgr.sendMessage('nonexistent', 'hello')).rejects.toThrow(
      'No container for group nonexistent',
    );
  });

  it('adds text to merge buffer and flushes after debounce', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    const { proc } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc);

    const promise = mgr.sendMessage('test-group', 'hello');

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(2000);

    // load-buffer should be spawned
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['exec', '-i', 'nanoclaw-test-group', 'tmux', 'load-buffer', '-'],
      expect.any(Object),
    );
    expect(proc.stdin.end).toHaveBeenCalledWith('hello');

    // Simulate load-buffer success
    proc._emit('close', 0);

    // paste-buffer + send-keys
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['paste-buffer']),
      expect.any(Object),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['send-keys']),
      expect.any(Object),
    );

    // Simulate turn-complete to resolve promise
    mockReaddirSync.mockReturnValueOnce(['tc.json']);
    turnCompleteWatchCallback('rename', 'tc.json');
    await vi.advanceTimersByTimeAsync(0);

    await promise;
  });

  it('multiple rapid messages merge into one flush', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    const { proc } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc);

    const p1 = mgr.sendMessage('test-group', 'msg1');
    const p2 = mgr.sendMessage('test-group', 'msg2');

    await vi.advanceTimersByTimeAsync(2000);

    // Only one spawn call — messages merged
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(proc.stdin.end).toHaveBeenCalledWith('msg1\n\nmsg2');

    // Complete the flow
    proc._emit('close', 0);
    mockReaddirSync.mockReturnValueOnce(['tc.json']);
    turnCompleteWatchCallback('rename', 'tc.json');
    await vi.advanceTimersByTimeAsync(0);

    await Promise.all([p1, p2]);
  });

  it('when turnInProgress, debounce sets pendingFlush instead of flushing', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    // First message flush
    const { proc: proc1 } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc1);
    const p1 = mgr.sendMessage('test-group', 'first');
    await vi.advanceTimersByTimeAsync(2000);
    proc1._emit('close', 0); // turnInProgress = true

    // Second message while turn in progress
    const { proc: proc2 } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc2);
    const p2 = mgr.sendMessage('test-group', 'second');
    await vi.advanceTimersByTimeAsync(2000); // debounce fires, but turnInProgress

    // Should NOT have spawned a second load-buffer yet
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Turn complete for first batch triggers pending flush
    mockReaddirSync.mockReturnValueOnce(['tc.json']);
    turnCompleteWatchCallback('rename', 'tc.json');
    await vi.advanceTimersByTimeAsync(0);

    await p1;

    // Now the pending flush should have fired
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    // Complete second batch
    proc2._emit('close', 0);
    mockReaddirSync.mockReturnValueOnce(['tc2.json']);
    turnCompleteWatchCallback('rename', 'tc2.json');
    await vi.advanceTimersByTimeAsync(0);

    await p2;
  });
});

// ===========================================================================
// flushNow (tested indirectly through sendMessage + timer)
// ===========================================================================

describe('flushNow', () => {
  it('on load-buffer failure (non-zero exit): rejects batch', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    const { proc } = createMockProc(1);
    mockSpawn.mockReturnValueOnce(proc);

    const promise = mgr
      .sendMessage('test-group', 'hello')
      .catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(2000);

    // Simulate load-buffer failure
    proc._emit('close', 1);
    await vi.advanceTimersByTimeAsync(0);

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('tmux load-buffer exit 1');
  });

  it('on spawn error event: rejects batch', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    const { proc } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc);

    const promise = mgr
      .sendMessage('test-group', 'hello')
      .catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(2000);

    proc._emit('error', new Error('spawn ENOENT'));
    await vi.advanceTimersByTimeAsync(0);

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('spawn ENOENT');
  });

  it('on paste/send-keys exception: rejects batch', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    const { proc } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc);

    const promise = mgr
      .sendMessage('test-group', 'hello')
      .catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(2000);

    // Make paste-buffer throw
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs.includes('paste-buffer')) {
        throw new Error('paste failed');
      }
      return '';
    });

    proc._emit('close', 0);
    await vi.advanceTimersByTimeAsync(0);

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('paste failed');
  });
});

// ===========================================================================
// processOutputDir
// ===========================================================================

describe('processOutputDir', () => {
  beforeEach(async () => {
    await mgr.ensureRunning(testGroup, testJid);
  });

  it('skips non-.json files', () => {
    const listener = vi.fn();
    mgr.onOutput(listener);

    mockReaddirSync.mockReturnValueOnce(['file.tmp', 'file.txt']);
    outputWatchCallback('rename', 'file.tmp');

    expect(listener).not.toHaveBeenCalled();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('reads JSON, fires output listeners, deletes file', async () => {
    const listener = vi.fn();
    mgr.onOutput(listener);

    const outputData = {
      text: 'response',
      toolUses: [{ name: 'Read', input: { path: '/foo' } }],
      stopReason: 'end_turn',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'output-uuid',
    };

    mockReaddirSync.mockReturnValueOnce(['2026-01-01T00-00-00-000Z-abc.json']);
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(outputData));

    outputWatchCallback('rename', 'somefile.json');
    await vi.advanceTimersByTimeAsync(0);

    expect(listener).toHaveBeenCalledWith('test-group', {
      text: 'response',
      toolUses: [{ name: 'Read', input: { path: '/foo' } }],
      stopReason: 'end_turn',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'output-uuid',
    });

    // File should be deleted
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('2026-01-01T00-00-00-000Z-abc.json'),
    );
  });

  it('skips unreadable files (readFileSync throws)', async () => {
    const listener = vi.fn();
    mgr.onOutput(listener);

    mockReaddirSync.mockReturnValueOnce(['broken.json']);
    mockReadFileSync.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });

    outputWatchCallback('rename', 'broken.json');
    await vi.advanceTimersByTimeAsync(0);

    expect(listener).not.toHaveBeenCalled();
  });

  it('deletes and skips corrupted JSON', async () => {
    const listener = vi.fn();
    mgr.onOutput(listener);

    mockReaddirSync.mockReturnValueOnce(['corrupt.json']);
    mockReadFileSync.mockReturnValueOnce('not valid json {{{');

    outputWatchCallback('rename', 'corrupt.json');
    await vi.advanceTimersByTimeAsync(0);

    expect(listener).not.toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('corrupt.json'),
    );
  });
});

// ===========================================================================
// processTurnCompleteDir
// ===========================================================================

describe('processTurnCompleteDir', () => {
  beforeEach(async () => {
    await mgr.ensureRunning(testGroup, testJid);
  });

  it('deletes file first, skips if unlink fails', () => {
    const listener = vi.fn();
    mgr.onTurnComplete(listener);

    mockReaddirSync.mockReturnValueOnce(['tc1.json']);
    mockUnlinkSync.mockImplementationOnce(() => {
      throw new Error('ENOENT already gone');
    });

    turnCompleteWatchCallback('rename', 'tc1.json');

    // Listener should NOT fire because unlinkSync threw (file already processed)
    expect(listener).not.toHaveBeenCalled();
  });

  it('sets turnInProgress=false and fires turn-complete listeners', async () => {
    const listener = vi.fn();
    mgr.onTurnComplete(listener);

    mockReaddirSync.mockReturnValueOnce(['tc.json']);
    turnCompleteWatchCallback('rename', 'tc.json');
    await vi.advanceTimersByTimeAsync(0);

    expect(listener).toHaveBeenCalledWith('test-group');
  });

  it('shifts flushQueue and resolves batch', async () => {
    const { proc } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc);

    const promise = mgr.sendMessage('test-group', 'hello');
    await vi.advanceTimersByTimeAsync(2000);
    proc._emit('close', 0);

    // Now turnInProgress=true, flushQueue has one batch
    mockReaddirSync.mockReturnValueOnce(['tc.json']);
    turnCompleteWatchCallback('rename', 'tc.json');
    await vi.advanceTimersByTimeAsync(0);

    // Promise should resolve
    await promise;
  });

  it('fires pendingFlush if set', async () => {
    // First flush
    const { proc: proc1 } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc1);
    const p1 = mgr.sendMessage('test-group', 'first');
    await vi.advanceTimersByTimeAsync(2000);
    proc1._emit('close', 0);

    // Second message during turn
    const { proc: proc2 } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc2);
    mgr.sendMessage('test-group', 'second');
    await vi.advanceTimersByTimeAsync(2000); // debounce fires, sets pendingFlush

    expect(mockSpawn).toHaveBeenCalledTimes(1); // Only first flush spawned

    // Turn complete triggers pending flush
    mockReaddirSync.mockReturnValueOnce(['tc.json']);
    turnCompleteWatchCallback('rename', 'tc.json');
    await vi.advanceTimersByTimeAsync(0);

    await p1;
    expect(mockSpawn).toHaveBeenCalledTimes(2); // Second flush now spawned
  });
});

// ===========================================================================
// stopAll
// ===========================================================================

describe('stopAll', () => {
  it('cleans up all states and rejects pending promises', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    const { proc } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc);
    const promise = mgr.sendMessage('test-group', 'hello');

    await mgr.stopAll();

    await expect(promise).rejects.toThrow(
      'Container stopped before turn completed',
    );
  });
});

// ===========================================================================
// cleanupState
// ===========================================================================

describe('cleanupState (via stopAll)', () => {
  it('clears timers and closes fs.watch watchers', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    await mgr.stopAll();

    // All watchers should have been closed
    for (const closeFn of watchCloseFns) {
      expect(closeFn).toHaveBeenCalled();
    }
  });

  it('rejects mergeBufferResolvers and flushQueue resolvers', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    // Add a message (in merge buffer, not yet flushed)
    const promise = mgr.sendMessage('test-group', 'pending');

    await mgr.stopAll();

    await expect(promise).rejects.toThrow(
      'Container stopped before turn completed',
    );
  });
});

// ===========================================================================
// Turn timeout
// ===========================================================================

describe('Turn timeout', () => {
  it('sendMessage rejects after TURN_TIMEOUT_MS if no turn-complete arrives', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    const { proc } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc);

    let rejected: Error | null = null;
    const promise = mgr.sendMessage('test-group', 'hello');
    promise.catch((e: Error) => {
      rejected = e;
    });

    // Advance past debounce (2s)
    await vi.advanceTimersByTimeAsync(2001);
    // load-buffer spawned; simulate success
    proc._emit('close', 0);

    // Advance past the turn timeout (5s from sendMessage call)
    await vi.advanceTimersByTimeAsync(5000);

    expect(rejected).toBeInstanceOf(Error);
    expect(rejected!.message).toContain(
      'Turn timeout after 5000ms waiting for claude response',
    );
  }, 15000);

  it('after timeout, subsequent resolve is no-op (idempotent)', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    const { proc } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc);

    let rejected: Error | null = null;
    const promise = mgr.sendMessage('test-group', 'hello');
    promise.catch((e: Error) => {
      rejected = e;
    });

    await vi.advanceTimersByTimeAsync(2001);
    proc._emit('close', 0);

    // Timeout fires
    await vi.advanceTimersByTimeAsync(5000);

    expect(rejected).toBeInstanceOf(Error);
    expect(rejected!.message).toContain('Turn timeout');

    // Late turn-complete should not throw
    mockReaddirSync.mockReturnValueOnce(['tc.json']);
    expect(() => {
      turnCompleteWatchCallback('rename', 'tc.json');
    }).not.toThrow();
  }, 15000);
});

// ===========================================================================
// Integration: send -> flush -> output -> turn-complete -> resolve
// ===========================================================================

describe('Integration: full lifecycle', () => {
  it('sendMessage -> timer -> flush -> output -> turn-complete -> resolve', async () => {
    const outputListener = vi.fn();
    const turnCompleteListener = vi.fn();
    mgr.onOutput(outputListener);
    mgr.onTurnComplete(turnCompleteListener);

    await mgr.ensureRunning(testGroup, testJid);

    const { proc } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc);

    // 1. Send message
    const promise = mgr.sendMessage('test-group', 'What is 2+2?');

    // 2. Debounce fires
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // 3. load-buffer completes
    proc._emit('close', 0);

    // 4. Simulate output file appearing
    const outputData = {
      text: '2+2 = 4',
      toolUses: [],
      stopReason: 'end_turn',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'resp-uuid',
    };
    mockReaddirSync.mockReturnValueOnce(['out.json']);
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(outputData));
    outputWatchCallback('rename', 'out.json');
    await vi.advanceTimersByTimeAsync(0);

    expect(outputListener).toHaveBeenCalledWith(
      'test-group',
      expect.objectContaining({ text: '2+2 = 4' }),
    );

    // 5. Simulate turn-complete
    mockReaddirSync.mockReturnValueOnce(['tc.json']);
    turnCompleteWatchCallback('rename', 'tc.json');
    await vi.advanceTimersByTimeAsync(0);

    expect(turnCompleteListener).toHaveBeenCalledWith('test-group');

    // 6. Promise resolves
    await promise;
  });

  it('multiple sequential messages each go through full lifecycle', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    // First message
    const { proc: proc1 } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc1);
    const p1 = mgr.sendMessage('test-group', 'first');
    await vi.advanceTimersByTimeAsync(2000);
    proc1._emit('close', 0);
    mockReaddirSync.mockReturnValueOnce(['tc1.json']);
    turnCompleteWatchCallback('rename', 'tc1.json');
    await vi.advanceTimersByTimeAsync(0);
    await p1;

    // Second message
    const { proc: proc2 } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc2);
    const p2 = mgr.sendMessage('test-group', 'second');
    await vi.advanceTimersByTimeAsync(2000);
    proc2._emit('close', 0);
    mockReaddirSync.mockReturnValueOnce(['tc2.json']);
    turnCompleteWatchCallback('rename', 'tc2.json');
    await vi.advanceTimersByTimeAsync(0);
    await p2;
  });
});

// ===========================================================================
// buildRunArgs edge cases
// ===========================================================================

describe('buildRunArgs edge cases', () => {
  it('includes NANOCLAW_TEST_OAUTH_TOKEN when env var is set', async () => {
    process.env.NANOCLAW_TEST_OAUTH_TOKEN = 'test-token-xyz';
    try {
      await mgr.ensureRunning(testGroup, testJid);

      const runCall = mockExecFileSync.mock.calls.find(
        (c: unknown[]) => (c[1] as string[])[0] === 'run',
      );
      const runArgs = (runCall![1] as string[]).join(' ');
      expect(runArgs).toContain('CLAUDE_CODE_OAUTH_TOKEN=test-token-xyz');
      // Should NOT contain the proxy URLs
      expect(runArgs).not.toContain('ANTHROPIC_BASE_URL');
    } finally {
      delete process.env.NANOCLAW_TEST_OAUTH_TOKEN;
    }
  });

  it('sanitizes folder name for container name', async () => {
    const specialGroup: RegisteredGroup = {
      ...testGroup,
      folder: 'my.special_group!',
    };
    mockResolveGroupIpcPath.mockReturnValue('/ipc/my.special_group!');

    await mgr.ensureRunning(specialGroup, testJid);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['--name', 'nanoclaw-my-special-group-']),
      expect.any(Object),
    );
  });

  it('non-main group sets NANOCLAW_IS_MAIN=0', async () => {
    const nonMainGroup: RegisteredGroup = {
      ...testGroup,
      isMain: false,
    };

    await mgr.ensureRunning(nonMainGroup, testJid);

    const runCall = mockExecFileSync.mock.calls.find(
      (c: unknown[]) => (c[1] as string[])[0] === 'run',
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).toContain('NANOCLAW_IS_MAIN=0');
  });
});

// ===========================================================================
// safeReaddir (tested through processOutputDir when readdirSync throws)
// ===========================================================================

describe('safeReaddir fallback', () => {
  it('returns empty when readdirSync throws', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    const listener = vi.fn();
    mgr.onOutput(listener);

    mockReaddirSync.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });

    // Should not throw
    outputWatchCallback('rename', 'somefile.json');
    expect(listener).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// fs.watch event filtering
// ===========================================================================

describe('fs.watch event filtering', () => {
  it('ignores non-rename events', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    const listener = vi.fn();
    mgr.onOutput(listener);

    // Clear mocks after startup so we can check fresh calls
    mockReaddirSync.mockClear();

    // 'change' event should be ignored (only 'rename' is processed)
    outputWatchCallback('change', 'somefile.json');
    expect(mockReaddirSync).not.toHaveBeenCalled();
  });

  it('ignores events with null filename', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    const listener = vi.fn();
    mgr.onOutput(listener);

    outputWatchCallback('rename', null);
    // readdirSync should not be called for output directory processing
    // (the last calls are from startup cleanup)
  });
});

// ===========================================================================
// healthCheck
// ===========================================================================

describe('healthCheck', () => {
  it('restarts container when not running', async () => {
    await mgr.ensureRunning(testGroup, testJid);
    const firstRunCount = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => (c[1] as string[])[0] === 'run',
    ).length;

    // Make isContainerRunning return false
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === 'inspect') throw new Error('not running');
      return '';
    });
    mockReaddirSync.mockReturnValue([]);

    // Trigger health check interval
    await vi.advanceTimersByTimeAsync(30_000);

    const secondRunCount = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => (c[1] as string[])[0] === 'run',
    ).length;
    expect(secondRunCount).toBeGreaterThan(firstRunCount);
  });

  it('does nothing when stopping flag is set', async () => {
    await mgr.ensureRunning(testGroup, testJid);
    const callCountBefore = mockExecFileSync.mock.calls.length;

    await mgr.stopAll(); // sets stopping=true
    vi.clearAllMocks();

    // Health check interval fires but should no-op
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Output delivery order
// ===========================================================================

describe('output delivery ordering', () => {
  it('processes multiple output files in sorted order', async () => {
    const outputs: string[] = [];
    mgr.onOutput((_folder, output) => {
      outputs.push(output.text);
    });

    await mgr.ensureRunning(testGroup, testJid);

    mockReaddirSync.mockReturnValueOnce([
      '2026-01-01T00-00-02.json',
      '2026-01-01T00-00-01.json',
    ]);
    mockReadFileSync
      .mockReturnValueOnce(
        JSON.stringify({
          text: 'first',
          toolUses: [],
          stopReason: null,
          timestamp: '1',
          uuid: 'u1',
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          text: 'second',
          toolUses: [],
          stopReason: null,
          timestamp: '2',
          uuid: 'u2',
        }),
      );

    outputWatchCallback('rename', 'file.json');
    await vi.advanceTimersByTimeAsync(0);

    // Sorted order: 00-00-01 before 00-00-02
    expect(outputs).toEqual(['first', 'second']);
  });
});

// ===========================================================================
// Output listener error handling
// ===========================================================================

describe('output listener error handling', () => {
  it('continues to next listener when one throws', async () => {
    const l1 = vi.fn().mockRejectedValueOnce(new Error('listener error'));
    const l2 = vi.fn();
    mgr.onOutput(l1);
    mgr.onOutput(l2);

    await mgr.ensureRunning(testGroup, testJid);

    mockReaddirSync.mockReturnValueOnce(['out.json']);
    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({
        text: 'hi',
        toolUses: [],
        stopReason: 'end_turn',
        timestamp: 't',
        uuid: 'u',
      }),
    );

    outputWatchCallback('rename', 'out.json');
    await vi.advanceTimersByTimeAsync(0);

    expect(l1).toHaveBeenCalled();
    expect(l2).toHaveBeenCalled();
  });
});

// ===========================================================================
// Stale file cleanup on startup
// ===========================================================================

// ===========================================================================
// flushNow: spawn itself throws (catch block at line ~380)
// ===========================================================================

describe('flushNow: spawn throws synchronously', () => {
  it('rejects batch when spawn throws', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    mockSpawn.mockImplementationOnce(() => {
      throw new Error('spawn itself failed');
    });

    let rejected: Error | null = null;
    const promise = mgr.sendMessage('test-group', 'hello');
    promise.catch((e: Error) => {
      rejected = e;
    });

    await vi.advanceTimersByTimeAsync(2001);
    // Allow microtask (Promise rejection handler) to run
    await vi.advanceTimersByTimeAsync(0);

    expect(rejected).toBeInstanceOf(Error);
    expect(rejected!.message).toContain('spawn itself failed');
  });
});

// ===========================================================================
// Turn-complete listener error handling
// ===========================================================================

describe('turn-complete listener error handling', () => {
  it('continues when turn-complete listener throws', async () => {
    const badListener = vi.fn().mockRejectedValue(new Error('listener boom'));
    const goodListener = vi.fn();
    mgr.onTurnComplete(badListener);
    mgr.onTurnComplete(goodListener);

    await mgr.ensureRunning(testGroup, testJid);

    mockReaddirSync.mockReturnValueOnce(['tc.json']);
    turnCompleteWatchCallback('rename', 'tc.json');
    await vi.advanceTimersByTimeAsync(0);

    expect(badListener).toHaveBeenCalledWith('test-group');
    expect(goodListener).toHaveBeenCalledWith('test-group');
  });
});

// ===========================================================================
// healthCheck restart failure
// ===========================================================================

describe('healthCheck restart failure', () => {
  it('logs error when restart fails', async () => {
    await mgr.ensureRunning(testGroup, testJid);
    const { logger: loggerMock } = await import('./logger.js');
    (loggerMock.error as ReturnType<typeof vi.fn>).mockClear();

    // After initial ensureRunning, make ALL subsequent execFileSync calls fail.
    // This will cause isContainerRunning -> false (inspect throws),
    // and then the restart's docker run also throws.
    mockExecFileSync.mockImplementation(() => {
      throw new Error('everything fails');
    });
    mockReaddirSync.mockReturnValue([]);

    // Trigger health check interval
    await vi.advanceTimersByTimeAsync(30_000);
    // Allow the async healthCheck promise to settle
    await vi.advanceTimersByTimeAsync(1);

    expect(loggerMock.error as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ group: 'Test Group' }),
      'Restart failed',
    );
  });
});

// ===========================================================================
// cleanupState with items in flushQueue
// ===========================================================================

describe('cleanupState with flushQueue items', () => {
  it('rejects all flushQueue batches on stopAll', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    // Send message and let it flush (creates flushQueue entry)
    const { proc } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc);

    let rejected: Error | null = null;
    const promise = mgr.sendMessage('test-group', 'hello');
    promise.catch((e: Error) => {
      rejected = e;
    });

    // Advance past debounce to trigger flush
    await vi.advanceTimersByTimeAsync(2001);
    // Simulate load-buffer success -- batch is now in flushQueue waiting for turn-complete
    proc._emit('close', 0);

    // Stop should reject the flushQueue entry
    await mgr.stopAll();

    expect(rejected).toBeInstanceOf(Error);
    expect(rejected!.message).toContain('Container stopped');
  });
});

describe('stale file cleanup on startup', () => {
  it('deletes stale files from output and turn-complete dirs on startup', async () => {
    // First two readdirSync calls during startOutputWatchers are for cleanup
    mockReaddirSync
      .mockReturnValueOnce(['stale-output.json'])
      .mockReturnValueOnce(['stale-tc.json']);

    await mgr.ensureRunning(testGroup, testJid);

    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('stale-output.json'),
    );
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('stale-tc.json'),
    );
  });
});

// ===========================================================================
// Idle shutdown
// ===========================================================================

describe('idle shutdown', () => {
  it('stops container when idle exceeds threshold', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    // isContainerRunning must return true for the idle-shutdown branch
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === 'inspect') return 'true';
      return '';
    });

    // First health check at 30s — container recently active, should NOT shut down
    await vi.advanceTimersByTimeAsync(30_000);
    const stopCallsBefore = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        Array.isArray(c[1]) && (c[1] as string[]).includes('stop'),
    );
    expect(stopCallsBefore).toHaveLength(0);

    // Advance past the idle threshold (900_000ms = 15 min)
    await vi.advanceTimersByTimeAsync(900_001);

    // Health check fires and sees idle > threshold — docker stop should be called
    const stopCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        Array.isArray(c[1]) && (c[1] as string[]).includes('stop'),
    );
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
    expect(stopCalls[0]).toEqual([
      'docker',
      ['stop', '-t', '5', 'nanoclaw-test-group'],
      expect.objectContaining({ timeout: 15000 }),
    ]);
  });

  it('does NOT stop container when turnInProgress', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    // isContainerRunning must return true for health checks
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === 'inspect') return 'true';
      return '';
    });

    // Start a message to set turnInProgress=true
    const { proc } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc);
    const promise = mgr.sendMessage('test-group', 'hello');
    promise.catch(() => {}); // prevent unhandled rejection from turn timeout

    // Advance past debounce (2s) to trigger flushNow
    await vi.advanceTimersByTimeAsync(2001);
    // load-buffer succeeds -> turnInProgress = true, flushQueue has one batch
    proc._emit('close', 0);

    // Advance one health check (30s). This also triggers the turn timeout (5s),
    // which clears turnInProgress — but lastActivity was set ~2s ago, so idle
    // time is only ~28s, far below the 900_000ms threshold. No idle stop should occur.
    await vi.advanceTimersByTimeAsync(30_000);

    // docker stop should NOT have been called by idle shutdown
    // (either turnInProgress was true, or idle time was way under threshold)
    const stopCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        Array.isArray(c[1]) && (c[1] as string[]).includes('stop'),
    );
    expect(stopCalls).toHaveLength(0);

    // Clean up
    await mgr.stopAll();
  });

  it('does NOT stop container when flushQueue has pending batches', async () => {
    await mgr.ensureRunning(testGroup, testJid);

    // isContainerRunning must return true
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === 'inspect') return 'true';
      return '';
    });

    // Send a message and flush it so flushQueue has a pending batch
    const { proc } = createMockProc(0);
    mockSpawn.mockReturnValueOnce(proc);
    const promise = mgr.sendMessage('test-group', 'hello');
    promise.catch(() => {}); // prevent unhandled rejection from turn timeout

    await vi.advanceTimersByTimeAsync(2001);
    proc._emit('close', 0);
    // turnInProgress = true, flushQueue has one batch

    // Advance one health check (30s). Turn timeout fires at 5s (turnInProgress
    // resets, flushQueue drained). After that, the container is idle but only
    // ~28s idle — far under the 900_000ms threshold. No stop should occur.
    await vi.advanceTimersByTimeAsync(30_000);

    const stopCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        Array.isArray(c[1]) && (c[1] as string[]).includes('stop'),
    );
    expect(stopCalls).toHaveLength(0);

    // Clean up
    await mgr.stopAll();
  });
});
