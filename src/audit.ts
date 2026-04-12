import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

export type AuditEventType =
  | 'message_inbound'
  | 'message_outbound'
  | 'email_inbound'
  | 'email_outbound'
  | 'remote_control'
  | 'allowlist_drop'
  | 'system';

export interface AuditEvent {
  ts: string;
  event_type: AuditEventType;
  direction?: 'inbound' | 'outbound';
  channel?: string;
  sender?: string;
  sender_name?: string;
  recipient?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

let auditLogPath = path.join(STORE_DIR, 'audit.log');
let initialised = false;

function init(): void {
  if (initialised) return;

  // Ensure the file exists before applying chattr
  if (!fs.existsSync(auditLogPath)) {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    fs.writeFileSync(auditLogPath, '');
  }

  // Apply filesystem append-only flag via sudo (requires NOPASSWD entry for chattr).
  // Fatal if this fails — no degraded mode.
  try {
    execFileSync('sudo', ['-n', 'chattr', '+a', auditLogPath]);
  } catch (err) {
    logger.fatal(
      { err, path: auditLogPath },
      'Failed to set append-only flag on audit log — cannot guarantee immutability. Refusing to start.',
    );
    process.exit(1);
  }

  initialised = true;
}

/**
 * Write an event to the append-only audit log.
 * Writes are synchronous to ensure events are not lost on crash.
 * If a write fails, the process exits — a failed audit write is a security
 * failure, not a soft error.
 */
export function auditEvent(event: AuditEvent): void {
  init();
  const line = JSON.stringify(event) + '\n';
  try {
    fs.appendFileSync(auditLogPath, line, 'utf-8');
  } catch (err) {
    logger.fatal({ err, path: auditLogPath }, 'Failed to write to audit log');
    process.exit(1);
  }
}

/** Exposed for tests only — resets initialisation state and optionally overrides the log path. */
export function _resetAuditForTest(customPath?: string): void {
  initialised = false;
  auditLogPath = customPath ?? path.join(STORE_DIR, 'audit.log');
}
