/**
 * Integration tests for the daemon SSE /events endpoint.
 *
 * Regression for: "Active Shields panel stuck on Loading — shields-status event
 * never emitted on connect". The fix emits shields-status in the initial SSE
 * payload alongside init and decisions.
 *
 * Requirements:
 *   - `npm run build` must be run before these tests (suite checks for dist/cli.js)
 *   - Port 7391 must be free — tests are skipped when another daemon is running
 *   - Tests use an isolated HOME to control shields state
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import http from 'http';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const DAEMON_PORT = 7391;

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(
      `dist/cli.js not found. Run "npm run build" before running integration tests.\nExpected: ${CLI}`
    );
  }
});

function makeTempHome(): string {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'node9-daemon-test-'));
  const node9Dir = path.join(tmpHome, '.node9');
  fs.mkdirSync(node9Dir, { recursive: true });
  fs.writeFileSync(
    path.join(node9Dir, 'config.json'),
    JSON.stringify({ settings: { mode: 'audit', autoStartDaemon: false } })
  );
  return tmpHome;
}

function cleanupDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function waitForDaemon(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/settings`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Read the SSE /events stream for up to timeoutMs, then close.
 * Returns the raw text received.
 */
function readSseStream(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const req = http.get(`http://127.0.0.1:${DAEMON_PORT}/events`, (res) => {
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        data += chunk;
      });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    // Close after timeoutMs — enough time to receive the initial burst of events
    setTimeout(() => {
      req.destroy();
      resolve(data);
    }, timeoutMs);
  });
}

/**
 * Parse SSE stream text into a map of event name → parsed JSON payload.
 * When the same event appears multiple times, the last occurrence wins.
 */
function parseSseEvents(raw: string): Map<string, unknown> {
  const events = new Map<string, unknown>();
  for (const chunk of raw.split('\n\n')) {
    let eventName = 'message';
    let dataLine = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim();
      if (line.startsWith('data: ')) dataLine = line.slice(6).trim();
    }
    if (dataLine) {
      try {
        events.set(eventName, JSON.parse(dataLine));
      } catch {
        // non-JSON data line — skip
      }
    }
  }
  return events;
}

// ── shields-status emitted on SSE connect ─────────────────────────────────────
// Regression: shields-status was only broadcast on toggle (POST /shields/toggle).
// A freshly connected dashboard never received it and stayed on "Loading…" forever.
// Fix: emit shields-status in the GET /events initial payload alongside init and decisions.

describe('daemon /events — shields-status emitted on connect', () => {
  let tmpHome: string;
  let daemonProc: ChildProcess;
  let portWasFree = false;

  beforeAll(async () => {
    portWasFree = await isPortFree(DAEMON_PORT);
    if (!portWasFree) return; // skip setup — tests will self-skip

    tmpHome = makeTempHome();
    // Write active shields to the isolated home
    fs.writeFileSync(
      path.join(tmpHome, '.node9', 'shields.json'),
      JSON.stringify({ active: ['filesystem'] })
    );

    daemonProc = spawn(process.execPath, [CLI, 'daemon', 'start'], {
      env: { ...process.env, HOME: tmpHome, NODE9_TESTING: '1' },
      stdio: 'pipe',
    });

    const ready = await waitForDaemon(6000);
    if (!ready) {
      daemonProc.kill();
      throw new Error('Daemon did not start within 6s');
    }
  });

  afterAll(() => {
    if (!portWasFree) return;
    spawnSync(process.execPath, [CLI, 'daemon', 'stop'], {
      env: { ...process.env, HOME: tmpHome, NODE9_TESTING: '1' },
      timeout: 3000,
    });
    daemonProc?.kill('SIGTERM');
    if (tmpHome) cleanupDir(tmpHome);
  });

  it('emits shields-status in the initial SSE payload', async () => {
    if (!portWasFree) {
      console.warn('Skipping: port 7391 is already in use by another daemon');
      return;
    }

    const raw = await readSseStream(1500);
    expect(raw, 'SSE stream must not be empty').toBeTruthy();

    const events = parseSseEvents(raw);
    expect(
      events.has('shields-status'),
      `shields-status event must be present in initial SSE payload.\nGot events: ${[...events.keys()].join(', ')}\nRaw stream:\n${raw}`
    ).toBe(true);
  });

  it('shields-status payload lists all shields with correct active state', async () => {
    if (!portWasFree) return;

    const raw = await readSseStream(1500);
    const events = parseSseEvents(raw);

    const payload = events.get('shields-status') as {
      shields: Array<{ name: string; description: string; active: boolean }>;
    };

    expect(Array.isArray(payload?.shields)).toBe(true);

    const filesystem = payload.shields.find((s) => s.name === 'filesystem');
    expect(filesystem, 'filesystem shield must appear in payload').toBeDefined();
    expect(filesystem!.active).toBe(true); // configured active in shields.json

    const postgres = payload.shields.find((s) => s.name === 'postgres');
    expect(postgres, 'postgres shield must appear in payload').toBeDefined();
    expect(postgres!.active).toBe(false); // not in shields.json → inactive

    // Every entry must have name and description
    for (const s of payload.shields) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.description).toBe('string');
    }
  });

  it('init and decisions events are still present alongside shields-status', async () => {
    if (!portWasFree) return;

    const raw = await readSseStream(1500);
    const events = parseSseEvents(raw);

    // Existing events must not have been removed by the fix
    expect(events.has('init'), 'init event must still be present').toBe(true);
    expect(events.has('decisions'), 'decisions event must still be present').toBe(true);
    expect(events.has('shields-status'), 'shields-status event must be present').toBe(true);
  });
});
