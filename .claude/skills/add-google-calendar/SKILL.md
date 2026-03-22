---
name: add-google-calendar
description: Add Google Calendar integration to NanoClaw agents. Agents can query events, check availability, accept/decline invites, and manage scheduling. Requires a GCP project with Calendar API enabled. Triggers on "add calendar", "google calendar", "calendar integration".
---

# Add Google Calendar Integration

This skill adds Google Calendar tools to NanoClaw agent containers via the `@cocal/google-calendar-mcp` MCP server. Agents can list events, check free/busy, respond to invites, and create events.

**Prerequisite**: A GCP project with OAuth credentials. If Gmail is already set up, you can reuse the same project — just enable the Calendar API and create a Desktop app credential.

## Phase 1: Pre-flight

### Check if already applied

Check if the Google Calendar MCP server is already configured:

```bash
grep -q 'google-calendar' container/agent-runner/src/index.ts && echo "ALREADY_APPLIED" || echo "NEEDS_SETUP"
```

If `ALREADY_APPLIED`, skip to Phase 3 (Setup).

### Check for existing credentials

```bash
ls ~/.config/google-calendar-mcp/tokens.json 2>/dev/null && echo "HAS_TOKENS" || echo "NO_TOKENS"
```

If `HAS_TOKENS`, skip the OAuth steps in Phase 3.

## Phase 2: Apply Code Changes

### Step 1: Add MCP server to agent runner

Read `container/agent-runner/src/index.ts` and add the Google Calendar MCP server to the `mcpServers` object (alongside any existing servers like `nanoclaw` and `gmail`):

```typescript
'google-calendar': {
  command: 'npx',
  args: ['-y', '@cocal/google-calendar-mcp'],
  env: {
    GOOGLE_OAUTH_CREDENTIALS: '/workspace/gcal/gcal-oauth.keys.json',
    GOOGLE_CALENDAR_MCP_TOKEN_PATH: '/workspace/gcal/tokens.json',
  },
},
```

Also add `'mcp__google_calendar__*'` to the `allowedTools` array.

### Step 2: Add credentials mount to container runner

Read `src/container-runner.ts` and add a mount for the calendar credentials directory. Place this near the other credential mounts (Gmail, etc.):

```typescript
// Google Calendar credentials (for Calendar MCP inside the container)
// Keys and tokens are co-located in ~/.config/google-calendar-mcp/
const gcalDir = path.join(homeDir, '.config', 'google-calendar-mcp');
if (fs.existsSync(path.join(gcalDir, 'gcal-oauth.keys.json')) && fs.existsSync(path.join(gcalDir, 'tokens.json'))) {
  mounts.push({
    hostPath: gcalDir,
    containerPath: '/workspace/gcal',
    readonly: false, // MCP may need to refresh OAuth tokens
  });
}
```

### Step 3: Build and verify

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### GCP Project & Credentials

If the user doesn't have a GCP project with Calendar API enabled:

> 1. Open https://console.cloud.google.com — create a new project or select existing
> 2. Go to **APIs & Services > Library**, search "Google Calendar API", click **Enable**
> 3. Go to **APIs & Services > Credentials**, click **+ CREATE CREDENTIALS > OAuth client ID**
>    - Application type: **Desktop app** (important — must be Desktop, not Web)
>    - Name: anything (e.g., "NanoClaw Calendar")
> 4. Click **DOWNLOAD JSON**

If the user already has Gmail set up, they can reuse the same GCP project — just enable the Calendar API and create a new Desktop app credential.

Save the credentials:

```bash
mkdir -p ~/.config/google-calendar-mcp
cp /path/to/downloaded-credentials.json ~/.config/google-calendar-mcp/gcal-oauth.keys.json
```

### OAuth Authorization

Run the authorization flow:

```bash
GOOGLE_OAUTH_CREDENTIALS=~/.config/google-calendar-mcp/gcal-oauth.keys.json npx -y @cocal/google-calendar-mcp auth
```

This starts a local server and prints an auth URL. The user must:
1. Open the URL in their browser
2. Sign in and grant calendar access
3. The redirect goes to `localhost:3500/oauth2callback`

**If the user is SSH'd into the machine** (redirect won't reach the server): ask them to paste the full redirect URL from their browser, then `curl` it against the local server to complete the exchange:

```bash
curl -s "THE_FULL_REDIRECT_URL_FROM_BROWSER"
```

Verify credentials were saved:

```bash
ls ~/.config/google-calendar-mcp/tokens.json && echo "Auth complete!"
```

### Rebuild and restart

Clear stale agent-runner copies and rebuild the container:

```bash
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
./container/build.sh
npm run build
```

Restart the service:
- macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- Linux: `systemctl --user restart nanoclaw`

## Phase 4: Verify

Tell the user:

> Send this in your main channel: "What's on my calendar tomorrow?"
>
> The agent should query your Google Calendar and list events.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Group CLAUDE.md Integration

If the user wants calendar invite automation (e.g., auto-accept from a specific sender), add instructions to the relevant group's CLAUDE.md. Example for auto-accepting invites:

```markdown
### Calendar invites from <sender>
When you receive a calendar invite email from <sender>:
1. Use `mcp__google_calendar__list_events` to check for conflicting events
2. If NO conflict: accept using `mcp__google_calendar__respond_to_event` and notify the user
3. If CONFLICT: email the sender back explaining the conflict and suggesting free times (use `mcp__google_calendar__get_freebusy`)
```

## Troubleshooting

### "OAuth credentials not found"

Ensure the credentials file is at `~/.config/google-calendar-mcp/gcal-oauth.keys.json` and has `"installed"` as the top-level key (Desktop app type, not Web).

### Token expired

Re-authorize:

```bash
rm ~/.config/google-calendar-mcp/tokens.json
GOOGLE_OAUTH_CREDENTIALS=~/.config/google-calendar-mcp/gcal-oauth.keys.json npx -y @cocal/google-calendar-mcp auth
```

To avoid weekly expiration (test mode), publish the app in GCP: **OAuth consent screen > PUBLISH APP**.

### Container can't access calendar

Check the mount exists: look for `/workspace/gcal` mount in container logs. Verify both `gcal-oauth.keys.json` and `tokens.json` exist in `~/.config/google-calendar-mcp/`.

## Removal

1. Remove `'google-calendar'` MCP server from `container/agent-runner/src/index.ts`
2. Remove `'mcp__google_calendar__*'` from `allowedTools`
3. Remove the gcal mount block from `src/container-runner.ts`
4. Remove calendar-related instructions from group CLAUDE.md files
5. Clear stale sessions and rebuild:
```bash
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
./container/build.sh
npm run build
systemctl --user restart nanoclaw  # or launchctl on macOS
```
