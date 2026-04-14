/**
 * Integration tests for skill-pin enforcement inside `node9 check` (PreToolUse).
 * Spawns the real built CLI with an isolated HOME + cwd. Requires `npm run build`.
 *
 * Tests cover three config states:
 *   - enabled: false (default) → skip everything
 *   - enabled: true, mode: 'warn' → /dev/tty warning, exit 0, session flag 'warned'
 *   - enabled: true, mode: 'block' → quarantine, exit 2, JSON block payload
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI = path.resolve(__dirname, '../../dist/cli.js');

function runCheck(payload: object, env: Record<string, string>, cwd: string) {
  const baseEnv = { ...process.env };
  delete baseEnv.NODE9_API_KEY;
  delete baseEnv.NODE9_API_URL;
  const r = spawnSync(process.execPath, [CLI, 'check', JSON.stringify(payload)], {
    encoding: 'utf-8',
    timeout: 60000,
    cwd,
    env: {
      ...baseEnv,
      NODE9_NO_AUTO_DAEMON: '1',
      NODE9_TESTING: '1',
      FORCE_COLOR: '0',
      ...env,
      ...(env.HOME != null ? { USERPROFILE: env.HOME } : {}),
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeTempHome(skillPinning: { enabled: boolean; mode?: string }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'node9-skhook-home-'));
  fs.mkdirSync(path.join(home, '.node9'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.node9', 'config.json'),
    JSON.stringify({
      settings: { mode: 'standard', autoStartDaemon: false },
      policy: { skillPinning },
    })
  );
  return home;
}

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node9-skhook-proj-'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'original skill content\n');
  return dir;
}

const payload = (sessionId: string, cwd: string) => ({
  tool_name: 'glob',
  tool_input: { pattern: '**' },
  session_id: sessionId,
  cwd,
  hook_event_name: 'PreToolUse',
});

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(`dist/cli.js not found at ${CLI} — run \`npm run build\` first.`);
  }
});

// ── enabled: false (default) ────────────────────────────────────────────────

describe('skillPinning disabled (default)', () => {
  let tmpHome: string;
  let tmpProject: string;
  beforeEach(() => {
    tmpHome = makeTempHome({ enabled: false });
    tmpProject = makeTempProject();
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  it('skips skill check entirely — no pin file, no session flag', () => {
    const r = runCheck(payload('s1', tmpProject), { HOME: tmpHome }, tmpProject);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, '.node9', 'skill-pins.json'))).toBe(false);
  });
});

// ── mode: 'warn' ────────────────────────────────────────────────────────────

describe('skillPinning mode=warn', () => {
  let tmpHome: string;
  let tmpProject: string;
  beforeEach(() => {
    tmpHome = makeTempHome({ enabled: true, mode: 'warn' });
    tmpProject = makeTempProject();
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  it('first call pins and allows', () => {
    const r = runCheck(payload('w1', tmpProject), { HOME: tmpHome }, tmpProject);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, '.node9', 'skill-pins.json'))).toBe(true);
    const flag = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.node9', 'skill-sessions', 'w1.json'), 'utf-8')
    );
    expect(flag.state).toBe('verified');
  });

  it('drift exits 0 (allowed) with session flag "warned" — not quarantined', () => {
    // Prime
    runCheck(payload('prime', tmpProject), { HOME: tmpHome }, tmpProject);
    // Tamper
    fs.writeFileSync(path.join(tmpProject, 'CLAUDE.md'), 'MALICIOUS');
    const r = runCheck(payload('w2', tmpProject), { HOME: tmpHome }, tmpProject);
    expect(r.status).toBe(0); // NOT 2 — warn, don't block
    // No JSON block payload on stdout
    expect(r.stdout.trim()).toBe('');
    // Session flag is 'warned', not 'quarantined'
    const flag = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.node9', 'skill-sessions', 'w2.json'), 'utf-8')
    );
    expect(flag.state).toBe('warned');
    expect(flag.detail).toMatch(/changed/i);
  });

  it('subsequent call after warn skips re-hash (memoised)', () => {
    runCheck(payload('prime', tmpProject), { HOME: tmpHome }, tmpProject);
    fs.writeFileSync(path.join(tmpProject, 'CLAUDE.md'), 'TAMPERED');
    runCheck(payload('w3', tmpProject), { HOME: tmpHome }, tmpProject);
    // Second call in same warned session — still exit 0, no re-hash
    const r = runCheck(payload('w3', tmpProject), { HOME: tmpHome }, tmpProject);
    expect(r.status).toBe(0);
  });
});

// ── mode: 'block' ───────────────────────────────────────────────────────────

describe('skillPinning mode=block', () => {
  let tmpHome: string;
  let tmpProject: string;
  beforeEach(() => {
    tmpHome = makeTempHome({ enabled: true, mode: 'block' });
    tmpProject = makeTempProject();
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  it('drift exits 2 with JSON block and quarantines the session', () => {
    runCheck(payload('prime', tmpProject), { HOME: tmpHome }, tmpProject);
    fs.writeFileSync(path.join(tmpProject, 'CLAUDE.md'), 'MALICIOUS');
    const r = runCheck(payload('b1', tmpProject), { HOME: tmpHome }, tmpProject);
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/skill/i);
    const flag = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.node9', 'skill-sessions', 'b1.json'), 'utf-8')
    );
    expect(flag.state).toBe('quarantined');
  });

  it('corrupt pin file exits 2 (fail-closed)', () => {
    fs.writeFileSync(path.join(tmpHome, '.node9', 'skill-pins.json'), 'not json');
    const r = runCheck(payload('b2', tmpProject), { HOME: tmpHome }, tmpProject);
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(out.decision).toBe('block');
  });
});
