# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden NanoClaw against supply chain compromise by pinning all dependencies, proxying the GitHub token, eliminating shell injection vectors, and fixing a dangerous network bind fallback.

**Architecture:** Four independent workstreams — supply chain pinning (package.json + Dockerfile), GitHub credential proxy (extend existing proxy + container wrapper scripts), command injection fix (refactor exec to execFile), and bind address safety (fail instead of fallback). Changes span host code, container image, and agent-runner config.

**Tech Stack:** Node.js, TypeScript, Docker, shell scripts, vitest

**Spec:** `docs/superpowers/specs/2026-03-28-security-hardening-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `package.json` | Modify | Pin all dependency versions to exact |
| `container/agent-runner/package.json` | Modify | Pin all dependency versions to exact |
| `container/Dockerfile` | Modify | Pin globals, pre-install MCPs, npm ci, add gh wrapper + credential helper |
| `container/agent-runner/src/index.ts` | Modify | Update MCP server commands from npx to global bins |
| `src/credential-proxy.ts` | Modify | Add /github-credential endpoint |
| `src/container-runner.ts` | Modify | Remove GITHUB_TOKEN env, remove gh config mount, update exec import |
| `src/container-runtime.ts` | Modify | Refactor stopContainer, convert to execFile, fix 0.0.0.0 fallback |
| `src/container-runtime.test.ts` | Modify | Update tests for new stopContainer signature and execFile |
| `.claude/skills/add-github/SKILL.md` | Modify | Update to reflect proxied GitHub token approach |

---

### Task 1: Pin host dependencies

**Files:**
- Modify: `package.json:23-50`

- [ ] **Step 1: Pin all dependency versions**

In `package.json`, replace every `^` prefix with the exact resolved version from the lockfile. Do NOT change `better-sqlite3` or `cron-parser` — they're already pinned.

```json
"dependencies": {
  "@whiskeysockets/baileys": "6.7.21",
  "better-sqlite3": "11.10.0",
  "cron-parser": "5.5.0",
  "google-auth-library": "10.6.2",
  "googleapis": "171.4.0",
  "grammy": "1.41.1",
  "pino": "9.14.0",
  "pino-pretty": "13.1.3",
  "qrcode-terminal": "0.12.0",
  "yaml": "2.8.2",
  "zod": "4.3.6"
},
"devDependencies": {
  "@eslint/js": "9.39.4",
  "@types/better-sqlite3": "7.6.13",
  "@types/node": "22.19.11",
  "@vitest/coverage-v8": "4.0.18",
  "eslint": "9.39.4",
  "eslint-plugin-no-catch-all": "1.1.0",
  "globals": "15.15.0",
  "husky": "9.1.7",
  "prettier": "3.8.1",
  "tsx": "4.21.0",
  "typescript": "5.9.3",
  "typescript-eslint": "8.57.1",
  "vitest": "4.0.18"
}
```

- [ ] **Step 2: Verify lockfile still valid**

Run: `npm ci`
Expected: installs successfully with no changes to package-lock.json

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: pin all host dependencies to exact versions"
```

---

### Task 2: Pin agent-runner dependencies

**Files:**
- Modify: `container/agent-runner/package.json:11-20`

- [ ] **Step 1: Pin all dependency versions**

In `container/agent-runner/package.json`, replace every `^` prefix with the exact resolved version from its lockfile:

```json
"dependencies": {
  "@anthropic-ai/claude-agent-sdk": "0.2.76",
  "@modelcontextprotocol/sdk": "1.26.0",
  "cron-parser": "5.5.0",
  "zod": "4.3.6"
},
"devDependencies": {
  "@types/node": "22.19.7",
  "typescript": "5.9.3"
}
```

Note: Use the versions from the agent-runner's own lockfile, not the host lockfile. The `cron-parser` and `zod` versions differ because this is a separate package.

- [ ] **Step 2: Verify lockfile still valid**

Run: `cd container/agent-runner && npm ci`
Expected: installs successfully

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/package.json
git commit -m "chore: pin agent-runner dependencies to exact versions"
```

---

### Task 3: Refactor stopContainer and fix 0.0.0.0 fallback

**Files:**
- Modify: `src/container-runtime.ts:1-130`
- Modify: `src/container-runtime.test.ts:1-149`
- Modify: `src/container-runner.ts:5,500`

- [ ] **Step 1: Update tests for new stopContainer signature**

In `src/container-runtime.test.ts`, update the `stopContainer` test to expect the new `{ bin, args }` return type:

```typescript
describe('stopContainer', () => {
  it('returns bin and args for execFile', () => {
    const result = stopContainer('nanoclaw-test-123');
    expect(result).toEqual({
      bin: CONTAINER_RUNTIME_BIN,
      args: ['stop', '-t', '1', 'nanoclaw-test-123'],
    });
  });
});
```

- [ ] **Step 2: Update cleanupOrphans tests for execFileSync**

The cleanupOrphans tests currently assert that `mockExecSync` is called with `stopContainer(name)` as a string. Update to mock `execFileSync` and assert it receives the `{ bin, args }` values. Also update the `docker ps` call to use `execFileSync`.

Replace the mock setup at the top of the file:

```typescript
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));
```

Update the import to include `execFileSync`:

```typescript
// No import change needed — the mock handles it
```

Update `cleanupOrphans` tests — the `docker ps` call uses `execFileSync` now, and `stopContainer` calls use `execFileSync` with bin + args:

```typescript
describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', () => {
    mockExecFileSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    mockExecFileSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
    // docker ps
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      1,
      CONTAINER_RUNTIME_BIN,
      ['ps', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    // stop calls
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-group1-111'],
      { stdio: 'pipe' },
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      3,
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-group2-222'],
      { stdio: 'pipe' },
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecFileSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecFileSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    mockExecFileSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
  });
});
```

Update `ensureContainerRuntimeRunning` test to use `execFileSync`:

```typescript
describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecFileSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['info'],
      { stdio: 'pipe', timeout: 10000 },
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/container-runtime.test.ts`
Expected: FAIL — `stopContainer` still returns a string, not `{ bin, args }`

- [ ] **Step 4: Implement container-runtime.ts changes**

In `src/container-runtime.ts`:

1. Change import from `execSync` to `execFileSync`:
```typescript
import { execFileSync } from 'child_process';
```

2. Refactor `stopContainer` (line 60-63):
```typescript
/** Returns the bin and args to stop a container by name. */
export function stopContainer(name: string): { bin: string; args: string[] } {
  return { bin: CONTAINER_RUNTIME_BIN, args: ['stop', '-t', '1', name] };
}
```

3. Convert `ensureContainerRuntimeRunning` (line 66-103) — change the `execSync` call to `execFileSync`:
```typescript
export function ensureContainerRuntimeRunning(): void {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['info'], {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    // ... error handling unchanged ...
  }
}
```

4. Convert `cleanupOrphans` (line 106-129):
```typescript
export function cleanupOrphans(): void {
  try {
    const output = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['ps', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        const { bin, args } = stopContainer(name);
        execFileSync(bin, args, { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    // ... logging unchanged ...
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
```

5. Fix the `0.0.0.0` fallback in `detectProxyBindHost` (line 40):
```typescript
  throw new Error(
    'Cannot detect docker0 bridge IP on Linux. Set CREDENTIAL_PROXY_HOST env var explicitly.',
  );
```

- [ ] **Step 5: Update container-runner.ts call site**

In `src/container-runner.ts`:

1. Change import (line 5) — add `execFile`, keep `spawn`:
```typescript
import { ChildProcess, execFile, spawn } from 'child_process';
```

Remove `exec` from the import since it's no longer used.

2. Update `killOnTimeout` (line 500):
```typescript
      const { bin, args } = stopContainer(containerName);
      execFile(bin, args, { timeout: 15000 }, (err) => {
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- src/container-runtime.test.ts`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add src/container-runtime.ts src/container-runtime.test.ts src/container-runner.ts
git commit -m "fix: replace shell exec with execFile and fail on missing docker0"
```

---

### Task 4: Add /github-credential endpoint to credential proxy

**Files:**
- Modify: `src/credential-proxy.ts:26-119`

- [ ] **Step 1: Add GITHUB_TOKEN to the secrets read in startCredentialProxy**

In `src/credential-proxy.ts`, add `'GITHUB_TOKEN'` to the `readEnvFile` call at line 30-35:

```typescript
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'GITHUB_TOKEN',
  ]);
```

- [ ] **Step 2: Add /github-credential handler before the Anthropic proxy logic**

Inside the `createServer` callback (line 48), add a handler for the `/github-credential` GET endpoint before the existing body-reading logic. This must be added right after `const server = createServer((req, res) => {`:

```typescript
    const server = createServer((req, res) => {
      // GitHub credential endpoint — returns token as plaintext for
      // container-side git credential helper and gh CLI wrapper.
      if (req.url === '/github-credential' && req.method === 'GET') {
        const ghToken =
          process.env.GITHUB_TOKEN || secrets.GITHUB_TOKEN || '';
        if (!ghToken) {
          res.writeHead(404);
          res.end('No GitHub token configured');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(ghToken);
        return;
      }

      // Existing Anthropic proxy logic below...
      const chunks: Buffer[] = [];
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: PASS (no existing tests break)

- [ ] **Step 5: Commit**

```bash
git add src/credential-proxy.ts
git commit -m "feat: add /github-credential endpoint to credential proxy"
```

---

### Task 5: Remove direct GitHub token access from containers

**Files:**
- Modify: `src/container-runner.ts:5,264-271,318-323`

- [ ] **Step 1: Remove GITHUB_TOKEN env var from buildContainerArgs**

In `src/container-runner.ts`, delete lines 318-323 (the entire GitHub token block):

```typescript
  // Pass GitHub token if available (for gh CLI and git push)
  const githubToken =
    process.env.GITHUB_TOKEN || readEnvFile(['GITHUB_TOKEN']).GITHUB_TOKEN;
  if (githubToken) {
    args.push('-e', `GITHUB_TOKEN=${githubToken}`);
  }
```

- [ ] **Step 2: Remove ~/.config/gh mount from buildVolumeMounts**

In `src/container-runner.ts`, delete lines 264-271 (the gh config mount):

```typescript
  const ghConfigDir = path.join(homeDir, '.config', 'gh');
  if (fs.existsSync(ghConfigDir)) {
    mounts.push({
      hostPath: ghConfigDir,
      containerPath: '/home/node/.config/gh',
      readonly: true,
    });
  }
```

- [ ] **Step 3: Add CREDENTIAL_PROXY_URL env var for container scripts**

In `buildContainerArgs`, after the `ANTHROPIC_BASE_URL` env var (line 296-299), add the proxy URL so the credential helper and gh wrapper scripts can use it:

```typescript
  // Credential proxy URL for GitHub credential helper and gh wrapper
  args.push(
    '-e',
    `CREDENTIAL_PROXY_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: remove direct GitHub token access from containers"
```

---

### Task 6: Update Dockerfile — pin versions, pre-install MCPs, add wrapper scripts

**Files:**
- Modify: `container/Dockerfile`

- [ ] **Step 1: Pin global npm packages**

Replace line 39:
```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code
```

With pinned versions plus the three MCP packages:
```dockerfile
# Pin all global packages to exact versions for supply chain safety.
# MCP packages are pre-installed here instead of fetched via npx at runtime.
RUN npm install -g \
    agent-browser@0.23.0 \
    @anthropic-ai/claude-code@2.1.86 \
    @gongrzhe/server-gmail-autoauth-mcp@1.1.11 \
    @cocal/google-calendar-mcp@2.6.1 \
    chrome-devtools-mcp@0.20.3
```

- [ ] **Step 2: Replace npm install with npm ci**

Replace line 48:
```dockerfile
RUN npm install
```

With:
```dockerfile
RUN npm ci
```

- [ ] **Step 3: Add git credential helper script**

After the `RUN chown` line (line 66) but before `USER node` (line 69), add:

```dockerfile
# Git credential helper — fetches GitHub token from credential proxy on demand.
# Token passes transiently through memory, never stored in environment or on disk.
RUN printf '#!/bin/bash\nif [ "$1" != "get" ]; then exit 0; fi\nhost=""\nwhile IFS= read -r line; do\n  case "$line" in host=*) host="${line#host=}" ;; esac\n  [ -z "$line" ] && break\ndone\nif [ "$host" = "github.com" ]; then\n  TOKEN=$(curl -sf "$CREDENTIAL_PROXY_URL/github-credential")\n  if [ -n "$TOKEN" ]; then\n    echo "username=x-access-token"\n    echo "password=$TOKEN"\n  fi\nfi\n' > /usr/local/bin/github-credential-helper \
    && chmod +x /usr/local/bin/github-credential-helper \
    && git config --system credential.helper /usr/local/bin/github-credential-helper
```

- [ ] **Step 4: Add gh CLI wrapper**

After the credential helper, add:

```dockerfile
# gh CLI wrapper — fetches GitHub token from credential proxy per invocation.
# The real gh binary is renamed; this wrapper injects auth transiently.
RUN mv /usr/bin/gh /usr/bin/gh.real \
    && printf '#!/bin/bash\nexport GH_TOKEN=$(curl -sf "$CREDENTIAL_PROXY_URL/github-credential")\nexec /usr/bin/gh.real "$@"\n' > /usr/bin/gh \
    && chmod +x /usr/bin/gh
```

- [ ] **Step 5: Commit**

```bash
git add container/Dockerfile
git commit -m "feat: pin container packages, pre-install MCPs, add GitHub credential scripts"
```

---

### Task 7: Update agent-runner MCP config to use global bins

**Files:**
- Modify: `container/agent-runner/src/index.ts:469-491`

- [ ] **Step 1: Replace npx commands with global bin names**

In `container/agent-runner/src/index.ts`, update the three MCP server configs that use `npx -y`:

Replace gmail MCP (lines 469-472):
```typescript
        gmail: {
          command: 'gmail-mcp',
          args: [],
        },
```

Replace google-calendar MCP (lines 473-480):
```typescript
        'google-calendar': {
          command: 'google-calendar-mcp',
          args: [],
          env: {
            GOOGLE_OAUTH_CREDENTIALS: '/workspace/gcal/gcal-oauth.keys.json',
            GOOGLE_CALENDAR_MCP_TOKEN_PATH: '/workspace/gcal/tokens.json',
          },
        },
```

Replace host-browser MCP (lines 485-491):
```typescript
        'host-browser': {
          command: 'chrome-devtools-mcp',
          args: [],
          env: {
            CHROME_REMOTE_DEBUGGING_URL: process.env.HOST_BROWSER_CDP_URL || 'ws://host.docker.internal:9222',
          },
        },
```

- [ ] **Step 2: Run typecheck**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat: use pre-installed MCP binaries instead of npx runtime fetch"
```

---

### Task 8: Update add-github skill documentation

**Files:**
- Modify: `.claude/skills/add-github/SKILL.md:231-244`

- [ ] **Step 1: Update the Removal section**

Replace the removal instructions (lines 231-244) to reflect the new architecture:

```markdown
## Removal

1. Remove `gh` installation block and wrapper scripts from `container/Dockerfile`
2. Remove git credential helper from `container/Dockerfile`
3. Remove `CREDENTIAL_PROXY_URL` env var from `src/container-runner.ts`
4. Remove `/github-credential` endpoint from `src/credential-proxy.ts`
5. Remove `GITHUB_TOKEN` from `.env`
6. Remove the repo directory mount from the group's `container_config` in SQLite
7. Remove GitHub instructions from group CLAUDE.md files
8. Rebuild:
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/add-github/SKILL.md
git commit -m "docs: update add-github skill for proxied GitHub token"
```

---

### Task 9: Build and verify

- [ ] **Step 1: Run full host test suite**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no errors (unused imports or similar issues after refactors)

- [ ] **Step 4: Build host TypeScript**

Run: `npm run build`
Expected: compiles successfully

- [ ] **Step 5: Build container image**

Run: `./container/build.sh`
Expected: builds successfully

Note: If the build uses cached layers and doesn't pick up changes, prune the buildkit cache first:
```bash
docker builder prune -f
./container/build.sh
```

- [ ] **Step 6: Note about scripts/claw**

The `scripts/claw` CLI tool also passes `GITHUB_TOKEN` directly to containers it spawns. Since `claw` runs independently of the main NanoClaw process (no credential proxy running), it would need its own proxy implementation to get the same protection. This is out of scope for this plan — `claw` is a development/debugging tool with lower risk than the always-running main process. File a follow-up issue if needed.

- [ ] **Step 7: Final commit (if any uncommitted changes)**

```bash
git status
# If clean, nothing to do
```
