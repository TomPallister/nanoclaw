# Security Hardening Design

**Date:** 2026-03-28
**Status:** Draft
**Context:** Personal NanoClaw instance on Raspberry Pi, home network (FritzBox router, no exposed ports), single user via WhatsApp DM, private repo.

## Threat Model

The primary attack surface is **supply chain compromise** — a malicious or compromised npm package running inside an agent container. Network-based attacks are mitigated by the home router with no port forwarding. The single-user WhatsApp DM setup eliminates multi-user prompt injection risks.

Key assets to protect:
- Anthropic API credentials (already proxied, well-protected)
- GitHub token (currently passed raw to containers)
- Gmail and Calendar OAuth tokens (mounted into containers, accepted risk)
- Host filesystem access (mitigated by container isolation)

## Changes

### 1. Supply Chain Hardening

#### 1a. Pin host dependencies to exact versions

Remove all `^` and `~` prefixes from `package.json` for both `dependencies` and `devDependencies`. The lockfile already pins exact versions, but pinning in `package.json` prevents version drift even when a lockfile is absent (fresh clone, accidental deletion).

**File:** `package.json`

#### 1b. Pin container agent-runner dependencies

Same treatment for `container/agent-runner/package.json` — remove all `^` prefixes.

**File:** `container/agent-runner/package.json`

#### 1c. Pin and pre-install MCP packages in Docker image

Currently, the agent-runner spawns Gmail and Calendar MCP servers via `npx -y` at runtime:
```typescript
command: 'npx',
args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
```

This fetches the latest version from npm on every container startup. A supply chain attack on either package would execute immediately. The `chrome-devtools-mcp` package (used by the `host-browser` MCP server) has the same problem.

**Changes:**
- Add `npm install -g` for all three MCP packages at pinned versions in `container/Dockerfile`
- Update the MCP server config in `container/agent-runner/src/index.ts` to use the globally installed binaries instead of `npx -y`. Check each package's `bin` entry in its `package.json` to determine the correct command (e.g., `server-gmail-autoauth-mcp` if it registers a bin, or `node /usr/local/lib/node_modules/<pkg>/dist/index.js` otherwise)

**Files:** `container/Dockerfile`, `container/agent-runner/src/index.ts`

#### 1d. Pin global container packages in Dockerfile

Currently:
```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code
```

Change to explicit version pins:
```dockerfile
RUN npm install -g agent-browser@<version> @anthropic-ai/claude-code@<version>
```

Exact versions to be determined at implementation time from current installed versions.

**File:** `container/Dockerfile`

#### 1e. Use npm ci in Dockerfile

Replace `npm install` with `npm ci` in the container build. `npm ci` uses the lockfile exclusively and verifies integrity hashes, refusing to install if anything has been tampered with. Requires `package-lock.json` to be present (it already is via the `COPY agent-runner/package*.json` step).

**File:** `container/Dockerfile`

### 2. GitHub Token Credential Proxy

#### 2a. Extend credential proxy for GitHub API

Add two new capabilities to the existing credential proxy:

1. **`/gh/` path prefix** — requests to `http://proxy:PORT/gh/repos/...` are forwarded to `https://api.github.com/repos/...` with the `Authorization: Bearer <real-token>` header injected. The container never sees the real token.

2. **`/github-credential` endpoint** — a simple GET endpoint that returns the GitHub token. Used by the git credential helper and gh wrapper (see 2c, 2d).

The proxy already does request forwarding for Anthropic API traffic — this extends the same pattern.

**File:** `src/credential-proxy.ts`

#### 2b. Configure container to remove direct token access

- Remove `GITHUB_TOKEN` environment variable from container args
- Remove `~/.config/gh` mount (it contains the token in `hosts.yml`)

**File:** `src/container-runner.ts`

#### 2c. Git credential helper

Add a shell script to the container image that acts as a git credential helper. When git needs credentials for github.com, it calls the helper, which fetches the token from the proxy's `/github-credential` endpoint via curl. The token passes transiently through memory but is never stored in the environment or on disk.

Configure git to use this helper via a system-level gitconfig in the Dockerfile (the host's `.gitconfig` is mounted read-only at `/home/node/.gitconfig`, so we use `/etc/gitconfig` which git reads first as system config):

```bash
# In Dockerfile
RUN git config --system credential.helper '/usr/local/bin/github-credential-helper'
```

The helper script follows the standard git credential helper protocol:
- Reads `host=` from stdin
- If host matches `github.com`, fetches token from proxy and outputs `username=x-access-token\npassword=<token>`
- Ignores `store` and `erase` operations

**Files:** `container/Dockerfile` (install helper script, configure git), `src/credential-proxy.ts` (add `/github-credential` endpoint)

#### 2d. gh CLI wrapper

The `gh` CLI does not support custom API base URLs for github.com — it hardcodes `https://api.github.com`. A proxy-based redirect (like `GITHUB_API_URL`) will not work.

Instead, add a wrapper script that replaces the `gh` binary in the container's PATH. The wrapper fetches the token from the proxy's `/github-credential` endpoint, sets `GH_TOKEN` in its own subprocess environment, and execs the real `gh` binary:

```bash
#!/bin/bash
export GH_TOKEN=$(curl -sf http://host.docker.internal:PORT/github-token)
exec /usr/bin/gh.real "$@"
```

The real `gh` binary is renamed to `gh.real` in the Dockerfile. The token is only in the subprocess environment for the duration of the `gh` command — it's not in the container's global environment and not readable via `/proc/1/environ`.

**Files:** `container/Dockerfile` (install wrapper, rename real binary)

#### 2e. Update add-github skill documentation

The add-github skill at `.claude/skills/add-github/SKILL.md` documents the old `GITHUB_TOKEN` passthrough pattern and `~/.config/gh` mount. Update to reflect the new proxied approach.

**File:** `.claude/skills/add-github/SKILL.md`

### 3. Command Injection Fix

#### 3a. Refactor stopContainer to use execFile

Change `stopContainer` from returning a shell command string to returning a structured `{ bin, args }` object:

```typescript
// Before
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`;
}

// After
export function stopContainer(name: string): { bin: string; args: string[] } {
  return { bin: CONTAINER_RUNTIME_BIN, args: ['stop', '-t', '1', name] };
}
```

Update all call sites to use `execFile`/`execFileSync` (which bypass the shell) instead of `exec`/`execSync`.

Call sites:
- `src/container-runner.ts` — `killOnTimeout` calls `exec(stopContainer(...))`
- `src/container-runtime.ts` — `cleanupOrphans` calls `execSync(stopContainer(...))`

For consistency, also convert `ensureContainerRuntimeRunning` and the `docker ps` call in `cleanupOrphans` to use `execFileSync` (these use hardcoded constants, so the risk is theoretical, but it's the same file and the same pattern).

**Files:** `src/container-runtime.ts`, `src/container-runner.ts`, `src/container-runtime.test.ts` (update tests for new return type)

### 4. Credential Proxy Bind Address Safety

#### 4a. Fail on missing docker0 instead of falling back to 0.0.0.0

On Linux (the Raspberry Pi), if the `docker0` bridge interface is not found, the proxy currently falls back to binding on `0.0.0.0` — exposing it to all devices on the home network.

Change: throw an error with a clear message instead of silently falling back. NanoClaw should refuse to start rather than expose the credential proxy.

```typescript
// Before
return '0.0.0.0';

// After
throw new Error(
  'Cannot detect docker0 bridge IP. Set CREDENTIAL_PROXY_HOST explicitly.'
);
```

The `CREDENTIAL_PROXY_HOST` environment variable override remains available for non-standard setups.

**File:** `src/container-runtime.ts`

## Out of Scope (Accepted Risks)

- **Agent self-modification:** The agent-runner source is mounted read-write so the agent can customize its own behavior from WhatsApp. This is a feature, not a bug. Per-group isolation limits blast radius.
- **Gmail/Calendar OAuth mounts:** These remain read-write. Proxying OAuth refresh flows would be a large project. Supply chain pinning (Section 1) is the primary mitigation for credential theft from containers.
- **Container network access:** Containers have unrestricted outbound internet. Restricting this adds operational complexity (allowlisting every service the agent needs). The FritzBox provides the network perimeter.
- **Phone numbers in repo:** Repo is private and will remain private. Low risk.
- **Sender allowlist:** Single-user DM setup means only the registered main chat triggers the agent. Other senders are already ignored.

## Implementation Notes

- Run `./container/build.sh` after all Dockerfile changes. Per project CLAUDE.md, a buildkit cache prune may be needed to ensure COPY steps pick up new files.
- `scripts/claw` also references `GITHUB_TOKEN` — verify if it needs updating.

## Files Changed (Summary)

| File | Changes |
|------|---------|
| `package.json` | Pin all dependency versions |
| `container/agent-runner/package.json` | Pin all dependency versions |
| `container/Dockerfile` | Pin global packages, pre-install MCP packages, use `npm ci`, add gh wrapper + credential helper |
| `container/agent-runner/src/index.ts` | Update MCP server config to use installed paths |
| `src/credential-proxy.ts` | Add GitHub API proxy routes and `/github-credential` endpoint |
| `src/container-runner.ts` | Remove `GITHUB_TOKEN` env var, remove `~/.config/gh` mount |
| `src/container-runtime.ts` | Refactor `stopContainer` to args array, convert `exec` to `execFile`, fix `0.0.0.0` fallback |
| `src/container-runtime.test.ts` | Update tests for new `stopContainer` return type |
| `.claude/skills/add-github/SKILL.md` | Update to reflect proxied GitHub token approach |
