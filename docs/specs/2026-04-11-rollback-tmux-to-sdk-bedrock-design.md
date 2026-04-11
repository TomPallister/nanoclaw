# Rollback tmux → Claude Agent SDK + AWS Bedrock

**Date:** 2026-04-11
**Status:** Draft — awaiting approval

## Problem

The recent migration from the Claude Agent SDK to a tmux + `claude` CLI architecture (commits `ec53d0a`–`19d7b18`, ~30 commits) introduced significant complexity: a persistent tmux session per container, a transcript-watcher sidecar, IPC file-based output parsing, merge windows, turn-complete gating, and 848 lines in a new `ContainerManager`. The tmux approach is considered a mistake and should be rolled back to the proven SDK-based model.

Additionally, the project is moving from the Anthropic API to **AWS Bedrock** as the Claude model provider. The rollback must support this.

## Current Architecture (tmux)

```
Host (Node.js)
  └─ ContainerManager (persistent container per group)
       └─ docker run → entrypoint.sh
            ├─ tmux session → claude CLI (long-lived)
            └─ transcript-watcher (sidecar, tails JSONL → IPC files)
       └─ fs.watch on /workspace/ipc/output/ for assistant events
```

**Problems:** Complex lifecycle, brittle tmux text injection, transcript file parsing, turn-complete gating, merge window debouncing, health check via pane capture.

## Target Architecture (SDK + Bedrock)

```
Host (Node.js)
  └─ runContainerAgent() (ephemeral container per message)
       └─ docker run -i → agent-runner/index.ts
            └─ SDK query() → AWS Bedrock (via env vars)
       └─ stdout markers for output parsing
       └─ IPC files for follow-up messages
```

**Benefits:** Proven model, SDK handles Bedrock natively, simple stdin/stdout protocol, no tmux/transcript parsing, no sidecar.

## Approaches Considered

### Approach A: Full git revert to pre-tmux commit

Revert all 30+ commits back to `a5eaabd` (last pre-tmux commit), then add Bedrock support.

- **Pros:** Cleanest possible baseline, no risk of leftover tmux artifacts
- **Cons:** Loses `82c1049` (docker/podman auto-detection) and any other minor improvements; one massive revert with potential merge conflicts across 28 files

### Approach B: Surgical restore — swap integration points (Recommended)

`runContainerAgent()` in `container-runner.ts` is **still fully intact** (only 2 trivial lines changed). Surgically restore the old integration points in `index.ts` and `task-scheduler.ts`, restore the old agent-runner, and remove tmux-specific files.

- **Pros:** Keeps unrelated improvements (docker/podman detection, `buildVolumeMounts` export); targeted changes; diffs are well-understood
- **Cons:** More manual than a revert; must verify all connection points

### Approach C: New branch from pre-tmux, cherry-pick

Branch from `a5eaabd`, cherry-pick useful commits like `82c1049`.

- **Pros:** Very clean starting point
- **Cons:** Same as A but with branch management overhead; hard to identify cherry-pickable commits since nearly all recent work is tmux-related

## Recommended: Approach B — Surgical Restore

### Why

1. `runContainerAgent()` already works — it's still in `container-runner.ts`
2. The `index.ts` and `task-scheduler.ts` diffs are well-contained (the old code paths were replaced, not restructured)
3. We keep the docker/podman auto-detection (`82c1049`) which is independent of tmux vs SDK
4. Lower risk than a 30-commit revert with potential conflict resolution

## Detailed Changes

### 1. Restore agent-runner SDK code

**Restore** `container/agent-runner/src/index.ts` from `git show 1df2da1~1:container/agent-runner/src/index.ts` (628 lines — the full SDK-based runner).

**Restore** `@anthropic-ai/claude-agent-sdk` in `container/agent-runner/package.json`:
```json
"dependencies": {
  "@anthropic-ai/claude-agent-sdk": "0.2.76",
  ...
}
```

Then `npm install` inside the agent-runner directory.

### 2. Revert index.ts to use runContainerAgent

Key changes:
- Remove `ContainerManager` import, restore `runContainerAgent` import
- Restore `sessions` state tracking (in-memory + DB persistence)
- Restore `processGroupMessages` to call `runContainerAgent` with idle timer
- Restore `runAgent` to pass `sessionId`, `wrappedOnOutput`, and spawn container
- Remove the global `containerManager.onOutput()` listener pattern
- Restore the `IDLE_TIMEOUT` config import

The diff is ~200 lines (the inverse of what was applied).

### 3. Revert task-scheduler.ts

- Restore `runContainerAgent` call with `onProcess` callback, `scheduleClose` timer
- Remove `sendToAgent` from `SchedulerDependencies`
- Restore `getSessions` dependency
- Restore `ASSISTANT_NAME` import

### 4. Revert Dockerfile

- Remove `tmux`, `jq`, `sudo` packages
- Remove `transcript-watcher/` COPY
- Remove `entrypoint.sh` COPY
- Restore old inline entrypoint (tsc → node agent-runner)
- Remove `/etc/claude-code` chmod 777

### 5. Remove tmux-specific files

- `src/container-manager.ts` (848 lines)
- `src/container-manager.test.ts` (1367 lines)
- `container/entrypoint.sh` (98 lines)
- `container/transcript-watcher/` (entire directory)
- `scripts/integration-test.mjs` (170 lines — tmux integration test)

### 6. Revert container-runner.ts

Two small changes:
- Un-export `buildVolumeMounts` (revert to private) — or keep exported, harmless
- Remove `skipDangerousModePermissionPrompt: true` from settings (not needed for SDK)

### 7. Revert DB changes

- Remove `claude_session_id` column accessors from `db.ts`
- The `sessions` table (pre-existing) continues to be used for SDK session tracking

### 8. Revert config.ts

- Remove `CONTAINER_IDLE_SHUTDOWN_MS` (only relevant to persistent containers)

### 9. Revert claw script

Restore `scripts/claw` from `git show ec53d0a~1:scripts/claw` (the pre-tmux version). The tmux rewrite changed the claw script substantially (~377 lines of changes).

### 10. Clean up design/plan docs

Remove (or archive) tmux-specific documentation:
- `docs/plans/2026-04-05-tmux-claude-cli-agent.md`
- `docs/plans/2026-04-07-claw-tmux-update.md`
- `docs/plans/2026-04-07-container-idle-shutdown.md`
- `docs/specs/2026-04-05-tmux-claude-cli-agent-design.md`
- `docs/specs/2026-04-07-claw-tmux-update-design.md`
- `docs/specs/2026-04-07-container-idle-shutdown-design.md`

## AWS Bedrock Support

### How the SDK supports Bedrock

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) supports Bedrock natively via environment variables:

| Variable | Purpose |
|----------|---------|
| `CLAUDE_CODE_USE_BEDROCK=1` | Tells the SDK to use Bedrock instead of Anthropic API |
| `AWS_ACCESS_KEY_ID` | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials |
| `AWS_SESSION_TOKEN` | Optional, for temporary credentials / STS |
| `AWS_REGION` | Bedrock region (e.g., `us-east-1`) |
| `ANTHROPIC_MODEL` | Model ID (e.g., `us.anthropic.claude-sonnet-4-20250514`) |

When `CLAUDE_CODE_USE_BEDROCK=1` is set, the SDK bypasses `ANTHROPIC_BASE_URL` entirely and calls `bedrock-runtime.<region>.amazonaws.com` using the AWS SDK internally.

### Credential handling changes

**Current model (Anthropic API):**
- Container gets `ANTHROPIC_BASE_URL=http://proxy:port` + `ANTHROPIC_API_KEY=placeholder`
- Credential proxy intercepts, injects real API key, forwards to `api.anthropic.com`

**New model (Bedrock):**
- Container gets `CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials directly
- SDK talks to Bedrock directly — credential proxy is NOT in the loop for Claude API calls
- Credential proxy remains active for GitHub token endpoint

**Implementation:**

1. Add Bedrock env vars to `.env`:
   ```
   CLAUDE_CODE_USE_BEDROCK=1
   AWS_ACCESS_KEY_ID=AKIA...
   AWS_SECRET_ACCESS_KEY=...
   AWS_REGION=us-east-1
   ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-20250514
   ```

2. Update `container-runner.ts` `buildContainerArgs()`:
   ```typescript
   const authMode = detectAuthMode();
   if (authMode === 'bedrock') {
     // Bedrock: SDK calls AWS directly, no credential proxy needed for Claude API
     args.push('-e', 'CLAUDE_CODE_USE_BEDROCK=1');
     const bedrockKeys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
                          'AWS_SESSION_TOKEN', 'AWS_REGION', 'ANTHROPIC_MODEL'];
     const bedrockEnv = readEnvFile(bedrockKeys);
     for (const key of bedrockKeys) {
       if (bedrockEnv[key]) args.push('-e', `${key}=${bedrockEnv[key]}`);
     }
   } else if (authMode === 'api-key') {
     // Existing Anthropic API flow via credential proxy
     args.push('-e', `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`);
     args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
   } else {
     // OAuth flow via credential proxy
     args.push('-e', `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`);
     args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
   }
   ```

3. Update `detectAuthMode()` in `credential-proxy.ts`:
   ```typescript
   export type AuthMode = 'api-key' | 'oauth' | 'bedrock';

   export function detectAuthMode(): AuthMode {
     const secrets = readEnvFile(['CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_API_KEY']);
     if (secrets.CLAUDE_CODE_USE_BEDROCK === '1') return 'bedrock';
     if (secrets.ANTHROPIC_API_KEY) return 'api-key';
     return 'oauth';
   }
   ```

### Security considerations

- AWS credentials are passed as container env vars (not through the credential proxy)
- This is acceptable because: containers are locally-run, network-restricted, and ephemeral (destroyed after each message)
- For production deployments on AWS infrastructure, IAM roles can be used instead (no explicit credentials needed — the SDK picks up the instance role automatically)
- The `.env` file is still shadowed inside containers (`/dev/null` mount) so the agent can't read other secrets

## Testing

1. **Build:** `npm run build` — verify TypeScript compiles cleanly
2. **Container build:** `./container/build.sh` — verify Dockerfile builds
3. **Unit tests:** `npm test` — existing tests (remove container-manager tests)
4. **Manual test:** Send a message via WhatsApp/Telegram, verify agent responds using Bedrock
5. **Scheduled tasks:** Verify task-scheduler still triggers agent runs

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Missing a tmux integration point | Low | Diffs are well-understood; grep for `containerManager` / `ContainerManager` |
| SDK version incompatibility | Low | Using same version `0.2.76` that worked before |
| Bedrock env vars not propagating | Medium | Test with `docker inspect` to verify env vars |
| Claw script regression | Medium | Old version restored from git; manual testing |
| Session history loss | Certain | Expected — tmux sessions are incompatible with SDK sessions. Fresh start. |
