// src/__tests__/stateful-rules.spec.ts
// Tests for stateful smart rules (dependsOnState predicate evaluation).
// Verifies that a block rule with dependsOnState is only applied when
// the daemon confirms the state predicate is satisfied.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Environment setup (must come before imports) ──────────────────────────────
process.env.NODE9_TESTING = '1';
process.env.VITEST = 'true';
process.env.NODE_ENV = 'test';

vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }));
vi.mock('../ui/native', () => ({
  askNativePopup: vi.fn().mockResolvedValue('deny'),
  sendDesktopNotification: vi.fn(),
}));
vi.mock('child_process', () => ({
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
  spawnSync: vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: '' }),
}));

// `vi.mock` factories are hoisted — use vi.hoisted() to share refs with tests.
const { mockNotifySocket, mockCheckState } = vi.hoisted(() => ({
  mockNotifySocket: vi.fn().mockResolvedValue(undefined),
  mockCheckState: vi.fn<() => Promise<Record<string, boolean> | null>>(),
}));

// Mock the daemon module so network calls don't happen in tests.
vi.mock('../auth/daemon.js', () => ({
  DAEMON_PORT: 7391,
  DAEMON_HOST: '127.0.0.1',
  notifyActivitySocket: mockNotifySocket,
  checkStatePredicates: mockCheckState,
  isDaemonRunning: vi.fn().mockReturnValue(false),
  checkTaint: vi.fn().mockResolvedValue({ tainted: false }),
  registerDaemonEntry: vi.fn().mockResolvedValue('fake-id'),
  waitForDaemonDecision: vi.fn().mockResolvedValue({ decision: 'allow' }),
  notifyDaemonViewer: vi.fn().mockResolvedValue(undefined),
  resolveViaDaemon: vi.fn().mockResolvedValue(undefined),
  notifyTaint: vi.fn().mockResolvedValue(undefined),
  notifyTaintPropagate: vi.fn().mockResolvedValue(undefined),
  getInternalToken: vi.fn().mockReturnValue(null),
}));

// ── fs / homedir mocks ────────────────────────────────────────────────────────
const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
const readSpy = vi.spyOn(fs, 'readFileSync');
vi.spyOn(os, 'homedir').mockReturnValue('/mock/home');

// ── Module imports ────────────────────────────────────────────────────────────
import { authorizeHeadless, _resetConfigCache } from '../core.js';

// ── Config mock helper ────────────────────────────────────────────────────────

function mockProjectConfig(config: object) {
  const projectPath = path.join(process.cwd(), 'node9.config.json');
  existsSpy.mockImplementation((p) => String(p) === projectPath);
  readSpy.mockImplementation((p) => (String(p) === projectPath ? JSON.stringify(config) : ''));
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetConfigCache();
  existsSpy.mockReturnValue(false);
  readSpy.mockReturnValue('');
  mockNotifySocket.mockReset().mockResolvedValue(undefined);
  mockCheckState.mockReset();
});

// ── Orchestrator tests ────────────────────────────────────────────────────────

describe('stateful smart rules — dependsOnState', () => {
  it('block rule without dependsOnState always hard-blocks', async () => {
    // Use ./deploy.sh — does not match any built-in default smart rule,
    // so the project rule fires first without being shadowed.
    mockProjectConfig({
      settings: { mode: 'standard', approvalTimeoutMs: 100 },
      policy: {
        smartRules: [
          {
            name: 'block-deploy',
            tool: 'Bash',
            conditions: [{ field: 'command', op: 'matches', value: './deploy.sh' }],
            verdict: 'block',
            reason: 'No stateful check',
          },
        ],
      },
    });

    const result = await authorizeHeadless('Bash', { command: './deploy.sh --env=production' });
    expect(result.approved).toBe(false);
    expect(result.blockedByLabel).toContain('block-deploy');
    expect(result.blockedBy).toBe('local-config');
    // No state check needed for a plain block rule
    expect(mockCheckState).not.toHaveBeenCalled();
  });

  it('block rule with dependsOnState fires when predicate is satisfied', async () => {
    mockCheckState.mockResolvedValue({ no_test_passed_since_last_edit: true });

    mockProjectConfig({
      settings: { mode: 'standard', approvalTimeoutMs: 100 },
      policy: {
        smartRules: [
          {
            name: 'require-tests-before-deploy',
            tool: 'Bash',
            conditions: [{ field: 'command', op: 'matches', value: './deploy.sh' }],
            verdict: 'block',
            reason: 'Run tests before deploying',
            dependsOnState: ['no_test_passed_since_last_edit'],
          },
        ],
      },
    });

    const result = await authorizeHeadless('Bash', { command: './deploy.sh --env=production' });
    expect(result.approved).toBe(false);
    // Predicates met → race engine → timeout (no interactive channels in test)
    expect(result.blockedBy).toBe('timeout');
    expect(mockCheckState).toHaveBeenCalledWith(['no_test_passed_since_last_edit']);
  });

  it('block rule with dependsOnState is skipped when predicate is false (tests passed)', async () => {
    mockCheckState.mockResolvedValue({ no_test_passed_since_last_edit: false });

    mockProjectConfig({
      settings: { mode: 'standard', approvalTimeoutMs: 100, approvers: { native: false } },
      policy: {
        smartRules: [
          {
            name: 'require-tests-before-deploy',
            tool: 'Bash',
            conditions: [{ field: 'command', op: 'matches', value: './deploy.sh' }],
            verdict: 'block',
            reason: 'Run tests before deploying',
            dependsOnState: ['no_test_passed_since_last_edit'],
          },
        ],
      },
    });

    // Predicate false → rule is downgraded to review → race engine runs
    const result = await authorizeHeadless('Bash', { command: './deploy.sh --env=production' });
    // Must NOT be hard-blocked by the smart rule
    expect(result.blockedByLabel).not.toContain('require-tests-before-deploy');
    expect(result.blockedBy).not.toBe('local-config');
    expect(mockCheckState).toHaveBeenCalledWith(['no_test_passed_since_last_edit']);
  });

  it('block rule with dependsOnState is skipped when daemon is unreachable', async () => {
    mockCheckState.mockResolvedValue(null); // daemon unreachable

    mockProjectConfig({
      settings: { mode: 'standard', approvalTimeoutMs: 100, approvers: { native: false } },
      policy: {
        smartRules: [
          {
            name: 'require-tests-before-deploy',
            tool: 'Bash',
            conditions: [{ field: 'command', op: 'matches', value: './deploy.sh' }],
            verdict: 'block',
            reason: 'Run tests before deploying',
            dependsOnState: ['no_test_passed_since_last_edit'],
          },
        ],
      },
    });

    const result = await authorizeHeadless('Bash', { command: './deploy.sh --env=production' });
    // Daemon unreachable → predicates unknown → no hard-block
    expect(result.blockedByLabel).not.toContain('require-tests-before-deploy');
    expect(result.blockedBy).not.toBe('local-config');
  });

  it('rule conditions that do not match never trigger state check', async () => {
    mockProjectConfig({
      settings: { mode: 'standard', approvalTimeoutMs: 100 },
      policy: {
        smartRules: [
          {
            name: 'require-tests-before-deploy',
            tool: 'Bash',
            conditions: [{ field: 'command', op: 'matches', value: './deploy.sh' }],
            verdict: 'block',
            dependsOnState: ['no_test_passed_since_last_edit'],
          },
        ],
      },
    });

    // Different command → conditions don't match → no state check
    await authorizeHeadless('Bash', { command: 'npm install' });
    expect(mockCheckState).not.toHaveBeenCalled();
  });
});

// ── Schema validation tests ───────────────────────────────────────────────────

describe('SmartRule schema — dependsOnState field', () => {
  it('accepts a valid dependsOnState array', async () => {
    const { validateConfig } = await import('../config-schema.js');
    const err = validateConfig(
      {
        policy: {
          smartRules: [
            {
              name: 'test-rule',
              tool: 'Bash',
              conditions: [{ field: 'command', op: 'exists' }],
              verdict: 'block',
              dependsOnState: ['no_test_passed_since_last_edit'],
            },
          ],
        },
      },
      '/test.json'
    );
    expect(err).toBeNull();
  });

  it('rejects unknown predicate names', async () => {
    const { validateConfig } = await import('../config-schema.js');
    const err = validateConfig(
      {
        policy: {
          smartRules: [
            {
              name: 'test-rule',
              tool: 'Bash',
              conditions: [{ field: 'command', op: 'exists' }],
              verdict: 'block',
              dependsOnState: ['unknown_predicate'],
            },
          ],
        },
      },
      '/test.json'
    );
    expect(err).not.toBeNull();
    expect(err).toContain('dependsOnState');
  });

  it('accepts a rule without dependsOnState (optional field)', async () => {
    const { validateConfig } = await import('../config-schema.js');
    const err = validateConfig(
      {
        policy: {
          smartRules: [
            {
              tool: 'Bash',
              conditions: [{ field: 'command', op: 'exists' }],
              verdict: 'block',
            },
          ],
        },
      },
      '/test.json'
    );
    expect(err).toBeNull();
  });

  it('accepts a valid recoveryCommand string', async () => {
    const { validateConfig } = await import('../config-schema.js');
    const err = validateConfig(
      {
        policy: {
          smartRules: [
            {
              name: 'test-rule',
              tool: 'Bash',
              conditions: [{ field: 'command', op: 'exists' }],
              verdict: 'block',
              dependsOnState: ['no_test_passed_since_last_edit'],
              recoveryCommand: 'npm test',
            },
          ],
        },
      },
      '/test.json'
    );
    expect(err).toBeNull();
  });

  it('accepts a rule without recoveryCommand (optional field)', async () => {
    const { validateConfig } = await import('../config-schema.js');
    const err = validateConfig(
      {
        policy: {
          smartRules: [
            {
              tool: 'Bash',
              conditions: [{ field: 'command', op: 'exists' }],
              verdict: 'block',
              dependsOnState: ['no_test_passed_since_last_edit'],
            },
          ],
        },
      },
      '/test.json'
    );
    expect(err).toBeNull();
  });
});
