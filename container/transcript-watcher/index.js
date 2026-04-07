#!/usr/bin/env node
/**
 * Transcript watcher for NanoClaw tmux-based agent.
 *
 * Tails ~/.claude/projects/<cwd-hash>/<session-id>.jsonl and writes parsed
 * assistant events to /workspace/ipc/output/*.json. Emits turn-complete
 * markers to /workspace/ipc/turn-complete/*. Periodically snapshots the tmux
 * pane to /workspace/ipc/health/pane.txt for host health checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const SESSION_ID = process.env.NANOCLAW_SESSION_ID;
if (!SESSION_ID) {
  console.error('[watcher] NANOCLAW_SESSION_ID not set');
  process.exit(1);
}

const CWD = process.cwd(); // set by Dockerfile WORKDIR (/workspace/group)
const CWD_HASH = CWD.replace(/\//g, '-'); // /workspace/group -> -workspace-group
const HOME = process.env.HOME || '/home/node';
const TRANSCRIPT = path.join(
  HOME,
  '.claude',
  'projects',
  CWD_HASH,
  `${SESSION_ID}.jsonl`,
);

const IPC_ROOT = '/workspace/ipc';
const OUTPUT_DIR = path.join(IPC_ROOT, 'output');
const TURN_COMPLETE_DIR = path.join(IPC_ROOT, 'turn-complete');
const HEALTH_DIR = path.join(IPC_ROOT, 'health');

for (const d of [OUTPUT_DIR, TURN_COMPLETE_DIR, HEALTH_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

console.error(
  `[watcher] session=${SESSION_ID} transcript=${TRANSCRIPT} cwd=${CWD}`,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFile() {
  for (let i = 0; i < 120; i++) {
    if (fs.existsSync(TRANSCRIPT)) return true;
    await sleep(1000);
  }
  return false;
}

function writeJson(dir, content) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  const file = path.join(dir, `${ts}-${rand}.json`);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(content) + '\n');
    fs.renameSync(tmp, file); // atomic so host watcher sees complete file
  } catch (err) {
    console.error(`[watcher] writeJson failed for ${file}: ${err.message}`);
    // Best-effort cleanup of stray tmp
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function handleLine(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // Ignore malformed
  }
  if (ev.type !== 'assistant') return;

  const msg = ev.message || {};
  const content = Array.isArray(msg.content) ? msg.content : [];
  const textBlocks = content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const toolUses = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ name: b.name, input: b.input }));

  writeJson(OUTPUT_DIR, {
    type: 'assistant',
    text: textBlocks,
    toolUses,
    stopReason: msg.stop_reason || null,
    timestamp: ev.timestamp,
    uuid: ev.uuid,
  });

  // Turn-complete: any stop reason except tool_use. The assistant continues
  // after tool_use once tool results come back, so that's NOT a turn boundary.
  // end_turn, max_tokens, stop_sequence, refusal, pause_turn etc. all end the turn.
  const stop = msg.stop_reason;
  if (stop && stop !== 'tool_use') {
    writeJson(TURN_COMPLETE_DIR, {
      stopReason: stop,
      timestamp: ev.timestamp,
      uuid: ev.uuid,
    });
  }
}

async function tailFile(filepath) {
  // On resume, the transcript file already has the full conversation history.
  // Start at the END of the file so we only emit events for NEW turns, not
  // replay hundreds of old assistant messages to the user.
  let pos = 0;
  try {
    pos = fs.statSync(filepath).size;
    if (pos > 0) {
      console.error(`[watcher] resuming at byte ${pos} (skipping existing history)`);
    }
  } catch {
    /* file may have just appeared — start from 0 */
  }
  let buffer = '';
  // StringDecoder handles UTF-8 sequences that span read boundaries correctly.
  const decoder = new StringDecoder('utf8');
  while (true) {
    try {
      const stat = fs.statSync(filepath);
      if (stat.size > pos) {
        const fd = fs.openSync(filepath, 'r');
        const len = stat.size - pos;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        fs.closeSync(fd);
        pos = stat.size;
        buffer += decoder.write(buf);
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim()) {
            try {
              handleLine(line);
            } catch (err) {
              console.error(`[watcher] handleLine threw: ${err.message}`);
            }
          }
        }
      } else if (stat.size < pos) {
        // File shrunk (compaction, rotation, manual edit). Skip to end —
        // we can't reliably identify which events are new vs rewritten,
        // and re-emitting old events would spam the user with duplicates
        // and misalign the flush queue.
        console.error(
          `[watcher] file shrunk (${pos} -> ${stat.size}), seeking to end`,
        );
        pos = stat.size;
        buffer = '';
      }
    } catch (err) {
      console.error(`[watcher] tail error: ${err.message}`);
    }
    await sleep(250);
  }
}

async function healthLoop() {
  while (true) {
    try {
      const out = spawnSync(
        'tmux',
        ['capture-pane', '-p', '-t', 'nanoclaw:0', '-S', '-100'],
        { encoding: 'utf-8' },
      );
      if (out.status === 0) {
        const tmp = path.join(HEALTH_DIR, 'pane.txt.tmp');
        const final = path.join(HEALTH_DIR, 'pane.txt');
        fs.writeFileSync(tmp, out.stdout);
        fs.renameSync(tmp, final);
      }
    } catch (err) {
      console.error(`[watcher] health check failed: ${err.message}`);
    }
    await sleep(5000);
  }
}

(async () => {
  // Start health loop first so host can detect stuck startup states
  // (e.g. bypass-permissions warning dialog before transcript exists).
  healthLoop();
  const exists = await waitForFile();
  if (!exists) {
    console.error(
      `[watcher] transcript file did not appear within 120s: ${TRANSCRIPT}`,
    );
    process.exit(1);
  }
  console.error('[watcher] transcript file found, starting tail');
  await tailFile(TRANSCRIPT);
})();
