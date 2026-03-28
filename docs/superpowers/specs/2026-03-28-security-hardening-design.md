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

This fetches the latest version from npm on every container startup. A supply chain attack on either package would execute immediately.

**Changes:**
- Add `npm install -g` for both MCP packages at pinned versions in `container/Dockerfile`
- Update the MCP server config in `container/agent-runner/src/index.ts` to reference the installed global paths instead of `npx -y`

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

Add a `/gh/` path prefix handler to the existing credential proxy. Requests to `http://proxy:PORT/gh/repos/...` are forwarded to `https://api.github.com/repos/...` with the `Authorization: Bearer <real-token>` header injected. The container never sees the real token.

The proxy already does exactly this for Anthropic API traffic — this extends the same pattern.

**File:** `src/credential-proxy.ts`

#### 2b. Configure container to use proxied GitHub API

- Set `GITHUB_API_URL=http://host.docker.internal:PORT/gh` in container environment
- Remove `GITHUB_TOKEN` environment variable from container args
- Remove `~/.config/gh` mount (it contains the token in `hosts.yml`)

**File:** `src/container-runner.ts`

#### 2c. Git credential helper for proxied auth

Add a credential helper script to the container image that fetches credentials from a `/github-credential` proxy endpoint on demand. Git calls the helper when it needs auth for github.com. The token passes transiently through memory but is never stored in the environment or on disk.

**Files:** `container/Dockerfile` (install helper script), `src/credential-proxy.ts` (add `/github-credential` endpoint)

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

**Files:** `src/container-runtime.ts`, `src/container-runner.ts` (call sites)

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

## Files Changed (Summary)

| File | Changes |
|------|---------|
| `package.json` | Pin all dependency versions |
| `container/agent-runner/package.json` | Pin all dependency versions |
| `container/Dockerfile` | Pin global packages, pre-install MCP packages, use `npm ci` |
| `container/agent-runner/src/index.ts` | Update MCP server config to use installed paths |
| `src/credential-proxy.ts` | Add GitHub API proxy routes and credential endpoint |
| `src/container-runner.ts` | Remove `GITHUB_TOKEN` env var, remove gh config mount, set `GITHUB_API_URL` |
| `src/container-runtime.ts` | Refactor `stopContainer` to args array, fix `0.0.0.0` fallback |
