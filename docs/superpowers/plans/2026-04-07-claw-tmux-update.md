# Update claw CLI for tmux containers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `scripts/claw`'s `run_container()` to start a tmux-based container, inject prompts via `tmux load-buffer`, and tail the JSONL transcript for responses.

**Architecture:** Single-file rewrite of the Python claw script. Replace stdin JSON piping + OUTPUT_START/END parsing with: (1) `docker run -d` with entrypoint env vars, (2) prompt injection via `docker exec tmux load-buffer/paste-buffer/send-keys`, (3) JSONL transcript tailing via `docker exec tail`. Interactive mode reuses the same container across turns.

**Tech Stack:** Python 3.8+, subprocess, json

**Reference spec:** `docs/superpowers/specs/2026-04-07-claw-tmux-update-design.md`

---

## File Structure

- Modify: `scripts/claw` — rewrite `run_container()`, update `main()` loop for persistent container in interactive mode

---

### Task 1: Rewrite `run_container()` to use tmux-based flow

**Files:**
- Modify: `scripts/claw:125-251`

- [ ] **Step 1: Replace `run_container` with new implementation**

Replace the entire `run_container` function (lines 125-251) with:

```python
def run_container(runtime: str, image: str, session_id: str, resume: bool,
                  secrets: dict, group_folder: str, container_name: str | None = None,
                  timeout: int = 300) -> str:
    """Start a tmux-based container (or reuse existing), return container name."""
    import time

    if container_name and _container_running(runtime, container_name):
        dbg(f"reusing running container {container_name}")
        return container_name

    name = container_name or f"claw-{int(time.time())}"
    cmd = [runtime, "run", "-d", "--name", name]

    # Mount session directory for persistence across claw runs
    session_dir = DATA_DIR / "sessions" / group_folder / ".claude"
    session_dir.mkdir(parents=True, exist_ok=True)
    cmd.extend(["-v", f"{session_dir}:/home/node/.claude"])

    # Mount group workspace
    group_dir = NANOCLAW_DIR / "groups" / group_folder
    group_dir.mkdir(parents=True, exist_ok=True)
    cmd.extend(["-v", f"{group_dir}:/workspace/group"])

    # Mount IPC directory
    ipc_dir = DATA_DIR / "ipc" / group_folder
    ipc_dir.mkdir(parents=True, exist_ok=True)
    cmd.extend(["-v", f"{ipc_dir}:/workspace/ipc"])

    # Entrypoint env vars
    cmd.extend(["-e", f"NANOCLAW_SESSION_ID={session_id}"])
    cmd.extend(["-e", f"NANOCLAW_RESUME={'1' if resume else '0'}"])
    cmd.extend(["-e", 'NANOCLAW_MCP_CONFIG_JSON={"mcpServers":{}}'])

    # Pass secrets as environment variables
    for key, value in secrets.items():
        cmd.extend(["-e", f"{key}={value}"])

    cmd.append(image)
    dbg(f"cmd: {' '.join(cmd)}")

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"error: failed to start container: {result.stderr.strip()}")
    dbg(f"container {name} started")

    return name


def _container_running(runtime: str, name: str) -> bool:
    result = subprocess.run(
        [runtime, "inspect", "--format", "{{.State.Running}}", name],
        capture_output=True, text=True,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


def stop_container(runtime: str, name: str) -> None:
    dbg(f"stopping container {name}")
    subprocess.run([runtime, "stop", "-t", "2", name], capture_output=True, timeout=10)
    subprocess.run([runtime, "rm", "-f", name], capture_output=True, timeout=5)


TRANSCRIPT_PATH_IN_CONTAINER = "/home/node/.claude/projects/-workspace-group"


def wait_for_transcript(runtime: str, container: str, session_id: str, timeout: int = 60) -> None:
    """Poll until the transcript JSONL file exists inside the container."""
    import time
    path = f"{TRANSCRIPT_PATH_IN_CONTAINER}/{session_id}.jsonl"
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = subprocess.run(
            [runtime, "exec", container, "test", "-f", path],
            capture_output=True,
        )
        if result.returncode == 0:
            dbg(f"transcript file found: {path}")
            return
        time.sleep(1)
    sys.exit(f"error: transcript file did not appear within {timeout}s")


def get_transcript_size(runtime: str, container: str, session_id: str) -> int:
    """Get current byte size of the transcript file."""
    path = f"{TRANSCRIPT_PATH_IN_CONTAINER}/{session_id}.jsonl"
    result = subprocess.run(
        [runtime, "exec", container, "wc", "-c", path],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return 0
    # wc -c output: "  12345 /path/to/file"
    return int(result.stdout.strip().split()[0])


def send_prompt(runtime: str, container: str, prompt: str) -> None:
    """Inject prompt into the tmux pane via load-buffer + paste-buffer + Enter."""
    # load-buffer from stdin
    load = subprocess.run(
        [runtime, "exec", "-i", container, "tmux", "load-buffer", "-"],
        input=prompt.encode(), capture_output=True,
    )
    if load.returncode != 0:
        sys.exit(f"error: tmux load-buffer failed: {load.stderr.decode().strip()}")

    # paste-buffer with bracketed paste
    result = subprocess.run(
        [runtime, "exec", container, "tmux", "paste-buffer", "-p", "-t", "nanoclaw:0"],
        capture_output=True,
    )
    if result.returncode != 0:
        sys.exit(f"error: tmux paste-buffer failed: {result.stderr.decode().strip()}")

    # send Enter to submit
    result = subprocess.run(
        [runtime, "exec", container, "tmux", "send-keys", "-t", "nanoclaw:0", "Enter"],
        capture_output=True,
    )
    if result.returncode != 0:
        sys.exit(f"error: tmux send-keys failed: {result.stderr.decode().strip()}")

    dbg("prompt injected via tmux")


def tail_response(runtime: str, container: str, session_id: str,
                  start_pos: int, timeout: int = 300) -> str:
    """Tail the transcript JSONL from start_pos, return assistant text when turn completes."""
    import time
    path = f"{TRANSCRIPT_PATH_IN_CONTAINER}/{session_id}.jsonl"
    pos = start_pos
    collected_text: list[str] = []
    deadline = time.time() + timeout

    while time.time() < deadline:
        # Read new bytes from the transcript
        result = subprocess.run(
            [runtime, "exec", container, "tail", "-c", f"+{pos + 1}", path],
            capture_output=True, text=True,
        )
        if result.returncode != 0 or not result.stdout:
            time.sleep(0.5)
            continue

        new_data = result.stdout
        pos += len(new_data.encode("utf-8"))

        for line in new_data.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") != "assistant":
                continue

            msg = ev.get("message", {})
            content = msg.get("content", [])
            if isinstance(content, list):
                text = "".join(
                    block.get("text", "")
                    for block in content
                    if block.get("type") == "text"
                )
                if text:
                    collected_text.append(text)

            stop = msg.get("stop_reason")
            if stop and stop != "tool_use":
                dbg(f"turn complete (stop_reason={stop})")
                return "\n\n".join(collected_text)

        time.sleep(0.5)

    sys.exit(f"error: timed out after {timeout}s waiting for response")
```

- [ ] **Step 2: Verify the script parses without errors**

```bash
python3 -c "import ast; ast.parse(open('scripts/claw').read()); print('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add scripts/claw
git commit -m "feat(claw): rewrite run_container for tmux-based containers"
```

---

### Task 2: Update `main()` to use the new container lifecycle

**Files:**
- Modify: `scripts/claw:254-375` (the `main()` function)

- [ ] **Step 1: Rewrite the main loop**

Replace lines 338-371 (from `current_prompt = prompt` to end of `while True` loop) with:

```python
    current_prompt = prompt
    current_session = args.session or str(__import__("uuid").uuid4())
    resume = args.session is not None
    container_name = f"claw-{int(__import__('time').time())}"

    if not resume:
        print(f"[{group_name or jid}] running via {runtime}...", file=sys.stderr)

    try:
        # Start container (or reuse in interactive mode)
        container_name = run_container(
            runtime, args.image, current_session, resume,
            secrets, group_folder or "default", container_name,
        )

        # Wait for claude to boot and transcript to appear
        wait_for_transcript(runtime, container_name, current_session)

        while True:
            # Get current transcript size (seek point)
            start_pos = get_transcript_size(runtime, container_name, current_session)

            # Inject prompt
            send_prompt(runtime, container_name, current_prompt)

            # Tail transcript for response
            response = tail_response(
                runtime, container_name, current_session,
                start_pos, timeout=args.timeout,
            )

            print(response)
            print(f"\n[session: {current_session}]", file=sys.stderr)

            # Interactive mode: prompt for next input, reuse same container
            if args.interactive:
                try:
                    print("\n> ", end="", file=sys.stderr, flush=True)
                    next_prompt = input()
                    if not next_prompt.strip():
                        break
                    current_prompt = next_prompt
                    resume = True
                except (EOFError, KeyboardInterrupt):
                    print("\n[exiting]", file=sys.stderr)
                    break
            else:
                break

    finally:
        stop_container(runtime, container_name)
```

- [ ] **Step 2: Remove unused imports and the old `payload` dict construction**

Remove these lines that are no longer used (the `payload` dict, `re` import):

In the import block at the top, remove:
```python
import re
import threading
```

- [ ] **Step 3: Verify script parses**

```bash
python3 -c "import ast; ast.parse(open('scripts/claw').read()); print('OK')"
```

- [ ] **Step 4: Commit**

```bash
git add scripts/claw
git commit -m "feat(claw): update main() for tmux container lifecycle"
```

---

### Task 3: Manual end-to-end test

- [ ] **Step 1: Test basic prompt**

```bash
./scripts/claw -v "Respond with just the word PONG"
```

Expected: prints `PONG` (or similar) to stdout, `[session: <uuid>]` to stderr.

- [ ] **Step 2: Test session resume**

```bash
# Use the session ID from step 1
./scripts/claw -v -s <session-id> "What did I just ask you?"
```

Expected: claude references the previous PONG prompt.

- [ ] **Step 3: Test interactive mode**

```bash
./scripts/claw -v -i "Hello"
```

Expected: prints response, shows `> ` prompt. Type a follow-up, get a response. Ctrl+C exits cleanly.

- [ ] **Step 4: Test pipe mode**

```bash
echo "What is 7 times 8?" | ./scripts/claw --pipe -v
```

Expected: prints `56` or similar.

- [ ] **Step 5: Test --list-groups**

```bash
./scripts/claw --list-groups
```

Expected: prints registered groups table (or empty if no DB).

- [ ] **Step 6: Commit any fixes from testing**

```bash
git add scripts/claw
git commit -m "fix(claw): fixes from manual testing"
```

---

## Self-Review

- [x] Spec coverage: run_container rewrite (Task 1), main() update (Task 2), session resume (Task 2 via `-s` flag), interactive mode (Task 2 inner loop), error handling (sys.exit calls in each helper), cleanup (finally block), manual tests (Task 3)
- [x] No placeholders — all code is complete
- [x] Type consistency — function signatures match between declaration and call sites
