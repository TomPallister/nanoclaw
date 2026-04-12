# Audit Log Design

**Date:** 2026-04-12  
**Status:** Approved  
**Scope:** Persistent, immutable, append-only audit log capturing all inbound and outbound messages plus system events across all channels.

---

## Problem

`messages.db` has two categories of gaps:

1. **Missing outbound coverage** — emails sent by the bot go directly through the Gmail MCP API with no record in the app. Bot messages sent via IPC/scheduled tasks are only captured if the channel echoes them back (WhatsApp does; others may not).
2. **Missing event types** — remote control commands (`/remote-control`, `/remote-control-end`) are intercepted before `storeMessage` and silently dropped. Sender-allowlist drops, channel connects/disconnects, and startup/shutdown events are not stored.
3. **No deletion protection** — `messages.db` has no immutability guarantee at any level.

---

## Goal

A separate, append-only audit log at `store/audit.log` that:

- Captures every inbound and outbound message across all channels, with full content
- Captures system events (connections, disconnections, startup, shutdown, remote control, allowlist drops)
- Can never be modified or deleted by the application — enforced at both application level (append-only file mode) and OS level (`chattr +a`)
- Is not accessible to container agents
- Requires no changes to `messages.db` or its existing behaviour

---

## Architecture

### `src/audit.ts` — new module

A thin, standalone module. No dependencies on the rest of the app except `config.ts` for the path.

```
auditEvent(event: AuditEvent): void
```

- Opens `store/audit.log` in append mode (`fs.appendFileSync`) on first call
- At process startup, applies `chattr +a store/audit.log` to set filesystem append-only. **If this fails, the process exits with a fatal error.** No degraded mode.
- Writes are synchronous — SQLite-style async drops events on crash; sync writes don't
- Never throws from `auditEvent` itself — catches write errors and exits the process (a failed audit write is a security failure, not a soft error)

### `AuditEvent` type

```ts
type AuditEvent = {
  ts: string;          // ISO timestamp
  event_type: AuditEventType;
  direction?: 'inbound' | 'outbound';
  channel?: string;    // 'whatsapp' | 'gmail' | 'telegram' | 'slack' | etc.
  sender?: string;     // JID, email address, or 'system'
  sender_name?: string;
  recipient?: string;  // JID or email address
  content?: string;    // full message body or email body
  metadata?: Record<string, unknown>; // subject, error details, etc.
};

type AuditEventType =
  | 'message_inbound'
  | 'message_outbound'
  | 'email_inbound'
  | 'email_outbound'
  | 'remote_control'
  | 'allowlist_drop'
  | 'system';
```

### Output format — JSONL

One JSON object per line:

```json
{"ts":"2026-04-12T13:00:00.000Z","event_type":"message_inbound","direction":"inbound","channel":"whatsapp","sender":"447772859248@s.whatsapp.net","sender_name":"Tom GP","recipient":"120363...@g.us","content":"Hello bot","metadata":{}}
```

---

## Hook Points

All hooks call `auditEvent()` in addition to (not instead of) existing behaviour.

| Location | Event type | Notes |
|---|---|---|
| `src/index.ts` — `onMessage` after `storeMessage` | `message_inbound` | All inbound, all channels |
| `src/index.ts` — `onMessage` remote control intercept | `remote_control` | Currently dropped before storage |
| `src/index.ts` — `onMessage` allowlist drop block | `allowlist_drop` | Currently silently discarded |
| `src/index.ts` — each `channel.sendMessage()` call site | `message_outbound` | Wraps all outbound WhatsApp/other channel sends |
| `src/ipc.ts` — `sendMessage` and `sendPhoto` wrappers | `message_outbound` | IPC-triggered container output |
| `src/channels/gmail.ts` — `ingestEmail()` | `email_inbound` | With `metadata.subject` |
| `src/channels/gmail.ts` — `sendMessage()` | `email_outbound` | Email replies sent via the Gmail channel (bot replying to an inbound email thread) |
| `src/index.ts` — process startup | `system` | `metadata.event: 'startup'` |
| `src/index.ts` — SIGTERM/SIGINT handlers | `system` | `metadata.event: 'shutdown', signal` |
| Channel `connect()` / disconnect | `system` | `metadata.event: 'channel_connected' / 'channel_disconnected', channel` |

---

## Immutability Enforcement

### Application level
- `audit.ts` opens the file exclusively with `fs.appendFileSync` — the file descriptor is never used for seek/overwrite
- No `DELETE`, `UPDATE`, or `truncate` operation is ever issued against `audit.log` anywhere in the codebase

### Filesystem level
- At startup (before the first write), `audit.ts` calls `execFileSync('chattr', ['+a', auditLogPath])`
- If this call fails for any reason, `audit.ts` calls `logger.fatal(...)` and `process.exit(1)`
- With `chattr +a` set, even `root` cannot overwrite or truncate the file without first removing the flag — providing meaningful protection against accidental or automated deletion

### Container isolation
- `store/audit.log` is not listed in any container mount in `container-runner.ts`
- The container agent has no path to read or write the audit log
- Verified by reviewing the existing named mount list in `container-runner.ts`

---

## Known Limitations

- **Proactive outbound emails via Gmail MCP**: When the container agent sends emails proactively using the `gmail-mcp` tool (not in reply to an inbound email), those calls go directly from inside the container to the Gmail API. The host process has no visibility. These emails will appear in Gmail Sent mail but are not captured in `audit.log`. Fixing this would require either modifying the container MCP infrastructure or adding a dedicated `log_email_sent` IPC tool that the agent must call — out of scope for this change.

---



- Log rotation or archiving (audit logs should grow unboundedly by design)
- Remote/off-site backup (out of scope for this change)
- Querying via the container agent (explicitly excluded)
- A UI or query tool (use `grep`, `jq`, or `sqlite3` with a JSONL-to-SQLite import script)

---

## Testing

- Unit tests in `src/audit.test.ts`:
  - `auditEvent` writes a valid JSONL line
  - Multiple events produce multiple lines, each valid JSON
  - Write failures cause process exit (mock `appendFileSync` to throw)
  - `chattr` failure causes process exit (mock `execFileSync` to throw)
- Integration: verify each hook point by checking `store/audit.log` after a test message round-trip
