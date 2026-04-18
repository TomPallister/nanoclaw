# Design: Host-side Google MCP Proxy

**Date:** 2026-04-18  
**Status:** Approved for implementation

## Problem

Gmail and Google Calendar credential files — containing `access_token`, `refresh_token`, and OAuth client secrets — are bind-mounted directly into agent containers. The agent can read them with a simple filesystem read, which contradicts the security model where credentials should only be accessible via the OneCLI gateway proxy.

Specifically, these paths are currently mounted into every container:
- `~/.gmail-mcp/credentials.json` (access_token, refresh_token, scope, token_type, expiry_date)
- `~/.config/google-calendar-mcp/gcal-oauth.keys.json` (client_id, client_secret, redirect_uris)
- `~/.config/google-calendar-mcp/tokens.json` (access_token, refresh_token, expiry_date)

## Goal

Remove credential file mounts from containers entirely. Gmail and Google Calendar MCP functionality must continue to work with no loss of capability.

## Approach: Host-side MCP Proxy

Run `gmail-mcp` and `google-calendar-mcp` as HTTP/SSE services on the **host** using `mcp-proxy`. Agent containers connect to them via URL. Credential files never enter the container.

The Claude Agent SDK supports `{ type: 'sse', url, headers }` MCP config natively, which enables this pattern without changes to the MCP server packages themselves.

## Architecture

```
Host (NanoClaw process)
├── src/google-mcp-proxy.ts  ← NEW
│     ├── mcp-proxy --host <PROXY_BIND_HOST> --port 10260 --apiKey <token> -- gmail-mcp
│     └── mcp-proxy --host <PROXY_BIND_HOST> --port 10261 --apiKey <token> -- google-calendar-mcp
│           (host-side credential files are accessible to these processes)
│
└── src/container-runner.ts  ← MODIFIED
      ├── NO credential file mounts
      └── passes GMAIL_MCP_URL + GCAL_MCP_URL + GOOGLE_MCP_AUTH_TOKEN env vars

Agent Container
└── agent-runner/src/index.ts  ← MODIFIED
      └── mcpServers: {
            gmail:    { type: 'sse', url: GMAIL_MCP_URL,  headers: { Authorization: 'Bearer <token>' } }
            'google-calendar': { type: 'sse', url: GCAL_MCP_URL, headers: { Authorization: 'Bearer <token>' } }
          }
```

## Files Changed

| File | Change |
|------|--------|
| `package.json` | Add `mcp-proxy`, `@gongrzhe/server-gmail-autoauth-mcp`, `@cocal/google-calendar-mcp` as exact-version host deps |
| `src/config.ts` | Add `GOOGLE_GMAIL_MCP_PORT` (10260), `GOOGLE_GCAL_MCP_PORT` (10261) |
| `src/google-mcp-proxy.ts` | **NEW** — starts/stops mcp-proxy child processes, returns active proxy URLs |
| `src/index.ts` | Start Google MCP proxies at startup; share state with container runner |
| `src/container-runner.ts` | Remove Gmail/GCal credential mounts; inject proxy URL + auth token env vars |
| `container/agent-runner/src/index.ts` | Use SSE config when env vars present; skip MCP servers when not |
| `container/Dockerfile` | Remove `@gongrzhe/server-gmail-autoauth-mcp` and `@cocal/google-calendar-mcp` from global install |

## Implementation Details

### Ports and Binding

- Gmail MCP proxy: port **10260**
- GCal MCP proxy: port **10261**
- Both bind to `PROXY_BIND_HOST` (reuses existing detection: `127.0.0.1` on macOS/WSL, docker0 IP on Linux)
- Containers reach them via `http://host.docker.internal:PORT`

### Authentication

`mcp-proxy` supports `--apiKey` which enforces `X-Api-Key` header auth on all requests. The container receives the token via `GOOGLE_MCP_AUTH_TOKEN` env var and passes it as `Authorization: Bearer <token>` in the SSE headers.

This is a proxy auth token, not a Google OAuth token — the agent seeing it gains no access to Google credentials.

The token is randomly generated at NanoClaw startup and lives in memory only.

### Lifecycle

- Proxies start at NanoClaw startup if credential files exist
- Each SSE connection spawns a fresh MCP server child process (per-session isolation)
- If a proxy process crashes, it is restarted with exponential backoff
- On NanoClaw shutdown, proxy processes are gracefully terminated
- If credentials don't exist → proxy not started → Gmail/GCal tools simply absent (same as today)

### google-mcp-proxy.ts Interface

```typescript
export interface GoogleMcpProxyState {
  gmailUrl: string | null;   // null if credentials absent or proxy failed
  gcalUrl: string | null;
  authToken: string | null;  // null if no proxies running
  shutdown: () => Promise<void>;
}

export async function startGoogleMcpProxies(): Promise<GoogleMcpProxyState>
```

### container-runner.ts Changes

Remove these mounts:
```typescript
// DELETE: Gmail credentials directory
// DELETE: Google Calendar credentials
```

Add these env vars (when proxy is running):
```typescript
configEnv['GMAIL_MCP_URL'] = gmailUrl;
configEnv['GCAL_MCP_URL'] = gcalUrl;
configEnv['GOOGLE_MCP_AUTH_TOKEN'] = authToken;
```

### agent-runner/src/index.ts Changes

Replace stdio MCP server config:
```typescript
// BEFORE
gmail: { command: 'gmail-mcp', args: [] }
'google-calendar': { command: 'google-calendar-mcp', env: {...} }

// AFTER
...(process.env.GMAIL_MCP_URL && {
  gmail: {
    type: 'sse',
    url: process.env.GMAIL_MCP_URL,
    headers: { Authorization: `Bearer ${process.env.GOOGLE_MCP_AUTH_TOKEN}` }
  }
}),
...(process.env.GCAL_MCP_URL && {
  'google-calendar': {
    type: 'sse',
    url: process.env.GCAL_MCP_URL,
    headers: { Authorization: `Bearer ${process.env.GOOGLE_MCP_AUTH_TOKEN}` }
  }
}),
```

### Dockerfile Changes

Remove from the global `npm install -g` line:
- `@gongrzhe/server-gmail-autoauth-mcp@1.1.11`
- `@cocal/google-calendar-mcp@2.6.1`

These are no longer needed inside the container. The container no longer spawns these MCP servers.

## Dependencies (exact versions per project convention)

Add to NanoClaw `package.json`:
```json
"@cocal/google-calendar-mcp": "2.6.1",
"@gongrzhe/server-gmail-autoauth-mcp": "1.1.11",
"mcp-proxy": "6.4.6"
```

These same versions are pinned in the Dockerfile today, maintaining consistency.

## Security Properties After Change

| Secret | Before | After |
|--------|--------|-------|
| Gmail `access_token` | Readable in container | Not in container |
| Gmail `refresh_token` | Readable in container | Not in container |
| GCal `client_secret` | Readable in container | Not in container |
| GCal `tokens.json` | Readable in container | Not in container |
| MCP proxy auth token | N/A | In container env — but this is a proxy-auth token only, not a Google credential |

## Non-Goals

- This does not route Google API traffic through OneCLI (that's a separate concern)
- This does not change how other MCP servers (nanoclaw, nuk-tpa-mcp, host-browser) work
- This does not add per-group Gmail/GCal isolation (one shared proxy for all groups)
