---
name: add-github
description: Add GitHub integration to NanoClaw agents. Agents can clone repos, create branches, commit, push, create PRs, and monitor CI checks. Requires gh CLI auth and a GITHUB_TOKEN. Triggers on "add github", "github integration", "repo access".
---

# Add GitHub Integration

This skill gives NanoClaw agents the ability to work with GitHub repositories — clone, branch, commit, push, create PRs, and monitor CI pipelines. Uses the `gh` CLI and git inside the container.

**Prerequisites:**
- `gh` CLI authenticated on the host (`gh auth login`)
- A `GITHUB_TOKEN` (personal access token or the one from `gh auth`)
- A directory where repos live (e.g., `~/Dev`)

## Phase 1: Pre-flight

### Check if already applied

```bash
docker run --rm nanoclaw-agent:latest which gh 2>/dev/null | grep -q gh && echo "GH_IN_CONTAINER" || echo "NEEDS_GH"
grep -q 'GITHUB_TOKEN' src/container-runner.ts && echo "TOKEN_PASSTHROUGH_EXISTS" || echo "NEEDS_TOKEN_PASSTHROUGH"
grep -q '\.gitconfig' src/container-runner.ts && echo "GIT_MOUNT_EXISTS" || echo "NEEDS_GIT_MOUNT"
```

If all three exist, skip to Phase 3 (Setup).

### Gather information

Use `AskUserQuestion`:
- What is your GitHub username?
- Where do your repos live? (default: `~/Dev`)

## Phase 2: Apply Code Changes

### Step 1: Add `gh` CLI to the container Dockerfile

Read `container/Dockerfile` and add `gh` installation to the system dependencies block (after `git`):

```dockerfile
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
```

### Step 2: Add git and GitHub credential mounts to container runner

Read `src/container-runner.ts` and add mounts for `.gitconfig` and `gh` CLI config. Place near other credential mounts:

```typescript
// Git and GitHub credentials (for repo operations inside containers)
const gitconfig = path.join(homeDir, '.gitconfig');
if (fs.existsSync(gitconfig)) {
  mounts.push({
    hostPath: gitconfig,
    containerPath: '/home/node/.gitconfig',
    readonly: true,
  });
}
const ghConfigDir = path.join(homeDir, '.config', 'gh');
if (fs.existsSync(ghConfigDir)) {
  mounts.push({
    hostPath: ghConfigDir,
    containerPath: '/home/node/.config/gh',
    readonly: true,
  });
}
```

### Step 3: Add GITHUB_TOKEN passthrough

In `src/container-runner.ts`, in the `buildContainerArgs` function (where env vars are set for the container), add:

```typescript
// Pass GitHub token if available (for gh CLI and git push)
const githubToken = process.env.GITHUB_TOKEN || readEnvFile(['GITHUB_TOKEN']).GITHUB_TOKEN;
if (githubToken) {
  args.push('-e', `GITHUB_TOKEN=${githubToken}`);
}
```

Also add the `readEnvFile` import if not already present:

```typescript
import { readEnvFile } from './env.js';
```

### Step 4: Configure the repo directory mount

The user's repo directory needs to be in the mount allowlist and configured as an additional mount on their main group.

**Add to mount allowlist** (`~/.config/nanoclaw/mount-allowlist.json`):

```json
{
  "allowedRoots": [
    {
      "path": "<user-repo-directory>",
      "allowReadWrite": true
    }
  ]
}
```

If the allowlist already has entries, add to the existing `allowedRoots` array.

**Add to the main group's container config** in SQLite:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json('{\"additionalMounts\":[{\"hostPath\":\"<user-repo-directory>\",\"containerPath\":\"dev\",\"readonly\":false}]}') WHERE is_main = 1;"
```

If the group already has `container_config`, merge the new mount into the existing `additionalMounts` array instead of replacing.

### Step 5: Add GITHUB_TOKEN to .env

```bash
echo "GITHUB_TOKEN=<token>" >> .env
cp .env data/env/env
```

Get the token from `gh auth token` or ask the user to provide it.

### Step 6: Build and verify

```bash
npm run build
./container/build.sh  # Required — Dockerfile changed
```

Build must be clean before proceeding.

## Phase 3: Setup

### Add agent instructions

Update the main group's CLAUDE.md (e.g., `groups/<main-folder>/CLAUDE.md`) with GitHub workflow instructions. Adapt the username and paths:

```markdown
## GitHub & Repository Work

You have access to the user's development directory at `/workspace/extra/dev` and GitHub credentials (`gh` CLI and git).

### Key rules
- All repos live in `/workspace/extra/dev`. Always `cd` there before cloning or creating repos.
- The user's GitHub username is `<USERNAME>`.
- Use `gh` CLI for GitHub operations (create repos, PRs, issues, etc.).
- Use `git` for local operations (clone, commit, push, branch, etc.).

### When asked to work on a GitHub issue
1. Clone or find the repo in `/workspace/extra/dev`
2. **CRITICAL: Read the issue AND all comments before doing anything:**
   - `gh issue view <number> --repo <USERNAME>/<repo> --comments`
   - If comments show conflicting opinions or ambiguity, message the user and ask for a decision
3. Read the codebase before making changes

### When asked to create a new repo
1. `cd /workspace/extra/dev`
2. `mkdir <repo-name> && cd <repo-name> && git init`
3. Set up the project (README, .gitignore, initial code, test framework)
4. `gh repo create <USERNAME>/<repo-name> --public --source=. --push` (use --private if asked)

### Development workflow (ALWAYS follow this)

*Branching:*
- NEVER commit directly to main. Always create a feature branch.
- Branch naming: `feat/<short-description>`, `fix/<short-description>`, `refactor/<short-description>`

*Commits:*
- Use conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`

*Testing:*
- Run ALL existing tests before and after changes
- Write tests for new functionality (90%+ coverage of new code)

*PR workflow:*
1. Push the branch and create a PR
2. Watch CI checks: `gh pr checks <number> --watch`
3. If checks fail: read the failure, fix, push, and loop until green
4. Notify the user with the PR link
```

### Restart service

```bash
systemctl --user restart nanoclaw  # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

## Phase 4: Verify

Tell the user:

> Send this in your main channel: "List my recent GitHub repos" or "Clone <repo-name> and show me the README"
>
> The agent should use `gh` and `git` to interact with your repos.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### "gh: command not found" inside container

Rebuild the container image — `gh` is installed during the Docker build:

```bash
./container/build.sh
```

### Authentication errors on push

- Verify `GITHUB_TOKEN` is in `.env` and synced to `data/env/env`
- Check the token has `repo` scope: `gh auth status`
- Restart the service after `.env` changes

### Mount not appearing

- Check `~/.config/nanoclaw/mount-allowlist.json` has the repo directory with `allowReadWrite: true`
- Check `container_config` in SQLite: `sqlite3 store/messages.db "SELECT container_config FROM registered_groups WHERE is_main = 1;"`
- The `allowedRoots` entries must be objects with a `path` field, not bare strings

### Permission denied on mounted repo directory

The container runs as the host user (UID passthrough). If files are owned by a different user, fix with `chown`.

## Removal

1. Remove `gh` installation block and wrapper scripts from `container/Dockerfile`
2. Remove git credential helper from `container/Dockerfile`
3. Remove `CREDENTIAL_PROXY_URL` env var from `src/container-runner.ts`
4. Remove `/github-credential` endpoint from `src/credential-proxy.ts`
5. Remove `GITHUB_TOKEN` from `.env`
6. Remove the repo directory mount from the group's `container_config` in SQLite
7. Remove GitHub instructions from group CLAUDE.md files
8. Rebuild:
```bash
./container/build.sh
npm run build
systemctl --user restart nanoclaw  # or launchctl on macOS
```
