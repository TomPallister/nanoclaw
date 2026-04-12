import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetAuditForTest, auditEvent } from './audit.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

let tmpDir: string;
let tmpLog: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  tmpLog = path.join(tmpDir, 'audit.log');
  mockExecFileSync.mockReset();
  _resetAuditForTest(tmpLog);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('auditEvent', () => {
  it('writes a valid JSONL line for a simple event', () => {
    const event = {
      ts: '2026-04-12T13:00:00.000Z',
      event_type: 'message_inbound' as const,
      direction: 'inbound' as const,
      channel: 'whatsapp',
      sender: '447123456789@s.whatsapp.net',
      sender_name: 'Alice',
      recipient: '120363@g.us',
      content: 'Hello!',
    };

    auditEvent(event);

    const lines = fs.readFileSync(tmpLog, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject(event);
  });

  it('writes multiple events as separate JSONL lines', () => {
    auditEvent({
      ts: '2026-04-12T13:00:00.000Z',
      event_type: 'system',
      metadata: { event: 'startup' },
    });
    auditEvent({
      ts: '2026-04-12T13:01:00.000Z',
      event_type: 'message_inbound',
      content: 'hi',
    });
    auditEvent({
      ts: '2026-04-12T13:02:00.000Z',
      event_type: 'message_outbound',
      content: 'hello back',
    });

    const lines = fs.readFileSync(tmpLog, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(JSON.parse(lines[0]).event_type).toBe('system');
    expect(JSON.parse(lines[1]).event_type).toBe('message_inbound');
    expect(JSON.parse(lines[2]).event_type).toBe('message_outbound');
  });

  it('applies chattr +a on first call', () => {
    auditEvent({ ts: '2026-04-12T13:00:00.000Z', event_type: 'system' });
    expect(mockExecFileSync).toHaveBeenCalledWith('sudo', [
      '-n',
      'chattr',
      '+a',
      tmpLog,
    ]);
  });

  it('only calls chattr once across multiple writes', () => {
    auditEvent({ ts: '2026-04-12T13:00:00.000Z', event_type: 'system' });
    auditEvent({ ts: '2026-04-12T13:01:00.000Z', event_type: 'system' });
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('exits the process if chattr fails', () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as never);
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('chattr not available');
    });

    auditEvent({ ts: '2026-04-12T13:00:00.000Z', event_type: 'system' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits the process if appendFileSync fails', () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as never);
    const appendSpy = vi
      .spyOn(fs, 'appendFileSync')
      .mockImplementationOnce(() => {
        throw new Error('disk full');
      });

    auditEvent({ ts: '2026-04-12T13:00:00.000Z', event_type: 'system' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    appendSpy.mockRestore();
  });
});
