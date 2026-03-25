// src/ui/terminal-approval.ts
//
// Terminal approval racer: renders an [A]/[D] prompt directly on /dev/tty,
// bypassing piped stdin (which is swallowed when node9 runs as a Claude Code
// PreToolUse subprocess). Communicates with the daemon via POST /decision/{id}
// so the result is idempotent against concurrent browser/native approvals.

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import tty from 'tty';
import type { RiskMetadata } from '../context-sniper';
import { isTestEnv, formatArgs } from './native';

// ── TTY detection ─────────────────────────────────────────────────────────────

/**
 * Returns the platform-appropriate controlling-terminal path.
 * On Windows, raw-mode /dev/tty semantics are unreliable across terminal
 * emulators — the terminal racer is disabled on Windows (falls through to
 * the native popup racer, which has a proper PowerShell dialog).
 */
function getTTYPath(): string {
  return os.platform() === 'win32' ? 'CON' : '/dev/tty';
}

/**
 * Returns true if the process has a controlling terminal that supports raw
 * mode (single-keypress reading).
 *
 * NODE9_FORCE_TERMINAL_APPROVAL=1 bypasses the open() probe, useful when
 * TTY detection fails (tmux, screen, some CI configurations).
 */
export function isTTYAvailable(): boolean {
  if (os.platform() === 'win32') return false; // see getTTYPath comment
  if (process.env.NODE9_FORCE_TERMINAL_APPROVAL === '1') return true;
  try {
    const fd = fs.openSync(getTTYPath(), 'r+');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

// ── CSRF token acquisition ────────────────────────────────────────────────────

/**
 * Opens an SSE connection to the daemon, reads the first `csrf` event, and
 * immediately closes the connection. The daemon emits the existing token on
 * every connection — never generates a new one.
 */
function getCsrfToken(port: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Aborted'));

    const req = http.get(`http://127.0.0.1:${port}/events`, (res) => {
      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        for (let i = 0; i < lines.length - 1; i++) {
          if (lines[i].startsWith('event: csrf') && lines[i + 1]?.startsWith('data: ')) {
            try {
              const { token } = JSON.parse(lines[i + 1].slice(6)) as { token: string };
              req.destroy();
              resolve(token);
            } catch {
              req.destroy();
              reject(new Error('Malformed csrf event from daemon'));
            }
            return;
          }
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    const onAbort = () => {
      req.destroy();
      reject(new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort);
  });
}

// ── Card rendering ────────────────────────────────────────────────────────────

const RESET = '\x1B[0m';
const BOLD = '\x1B[1m';
const RED = '\x1B[31m';
const YELLOW = '\x1B[33m';
const CYAN = '\x1B[36m';
const GRAY = '\x1B[90m';
const HIDE_CURSOR = '\x1B[?25l';
const SHOW_CURSOR = '\x1B[?25h';
const ERASE_LINE = '\x1B[2K';
const MOVE_UP = (n: number) => `\x1B[${n}A`;
const ERASE_DOWN = '\x1B[J';

interface CardState {
  ttyWrite: fs.WriteStream;
  lineCount: number; // number of lines printed, for cleanup
}

function renderCard(
  ttyWrite: fs.WriteStream,
  toolName: string,
  args: unknown,
  riskMetadata: RiskMetadata | undefined,
  timeoutMs: number
): CardState {
  const { message: argsPreview } = formatArgs(
    args,
    riskMetadata?.matchedField,
    riskMetadata?.matchedWord
  );
  const tierLabel =
    riskMetadata?.tier != null
      ? riskMetadata.tier <= 2
        ? `${YELLOW}⚠  Tier ${riskMetadata.tier}`
        : `${RED}🛑 Tier ${riskMetadata.tier}`
      : `${YELLOW}⚠  Review`;
  const blockedBy = riskMetadata?.blockedByLabel ?? 'Policy rule';
  const timeoutSecs = Math.round(timeoutMs / 1000);

  const lines = [
    ``,
    `${BOLD}${CYAN}╔══ Node9 Approval Required ══╗${RESET}`,
    `${CYAN}║${RESET} Tool:    ${BOLD}${toolName}${RESET}`,
    `${CYAN}║${RESET} Reason:  ${tierLabel} — ${blockedBy}${RESET}`,
    `${CYAN}║${RESET} Args:    ${GRAY}${argsPreview.split('\n')[0].slice(0, 60)}${RESET}`,
    `${CYAN}╚${RESET}`,
    ``,
    `  ${BOLD}[A]${RESET} Allow   ${BOLD}[D]${RESET} Deny`,
    `  ${GRAY}(auto-deny in ${timeoutSecs}s)${RESET}`,
    ``,
  ];

  for (const line of lines) {
    ttyWrite.write(line + '\n');
  }

  return { ttyWrite, lineCount: lines.length };
}

function clearCard(state: CardState): void {
  // Move cursor up by lineCount lines, then erase from cursor to end of screen
  state.ttyWrite.write(MOVE_UP(state.lineCount) + ERASE_DOWN);
}

function updateCountdown(state: CardState, remainingMs: number): void {
  const secs = Math.max(0, Math.round(remainingMs / 1000));
  // Move up 2 lines (past blank line at bottom + countdown line), rewrite countdown
  state.ttyWrite.write(MOVE_UP(2) + ERASE_LINE + `\r  ${GRAY}(auto-deny in ${secs}s)${RESET}\n\n`);
}

// ── Keypress reading ──────────────────────────────────────────────────────────

function readKeypress(ttyFd: number, signal: AbortSignal): Promise<'allow' | 'deny'> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Aborted'));

    // tty.ReadStream with autoClose:false so we control fd lifetime.
    // tty.ReadStream is required (not fs.ReadStream) because setRawMode()
    // is only available on tty streams.
    const ttyReadable = new tty.ReadStream(ttyFd);

    let settled = false;
    const settle = (result: 'allow' | 'deny' | Error) => {
      if (settled) return;
      settled = true;
      try {
        ttyReadable.setRawMode(false);
      } catch {
        /* ignore if already destroyed */
      }
      ttyReadable.pause();
      ttyReadable.removeAllListeners();
      signal.removeEventListener('abort', onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const onAbort = () => settle(new Error('Aborted'));
    signal.addEventListener('abort', onAbort);

    try {
      ttyReadable.setRawMode(true);
    } catch (err) {
      settle(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    ttyReadable.resume();
    ttyReadable.on('data', (key: Buffer) => {
      const k = key.toString().toLowerCase();
      if (k === 'a') {
        settle('allow');
      } else if (k === 'd' || k === '\r' || k === '\n' || k === '\x03' /* Ctrl-C */) {
        settle('deny');
      }
      // Any other key: keep waiting
    });
    ttyReadable.on('error', (err) => settle(err));
  });
}

// ── POST /decision ────────────────────────────────────────────────────────────

function postDecision(
  id: string,
  decision: 'allow' | 'deny',
  csrfToken: string,
  port: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ decision });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/decision/${id}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Node9-Token': csrfToken,
        },
      },
      (res) => {
        // 200 = success, 409 = idempotent conflict (another racer already decided) — both ok
        res.resume(); // drain body
        if (res.statusCode === 200 || res.statusCode === 409) resolve();
        else reject(new Error(`POST /decision returned ${res.statusCode}`));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Renders an [A]/[D] approval card on /dev/tty, reads a single keypress, and
 * posts the decision to the daemon. Returns 'allow' or 'deny'.
 *
 * Always returns 'deny' in test environments.
 */
export async function askTerminalApproval(
  id: string,
  toolName: string,
  args: unknown,
  riskMetadata: RiskMetadata | undefined,
  signal: AbortSignal,
  daemonPort: number,
  timeoutMs: number
): Promise<'allow' | 'deny'> {
  if (isTestEnv()) return 'deny';
  if (signal.aborted) return 'deny';

  let ttyFd: number | null = null;
  let cardState: CardState | null = null;
  let countdownInterval: ReturnType<typeof setInterval> | null = null;
  let autoReject: (() => void) | null = null;
  const ttyPath = getTTYPath();

  // Restore cursor on process exit (covers SIGTERM/SIGINT during prompt)
  const onExit = () => {
    try {
      if (ttyFd !== null) fs.writeSync(ttyFd, SHOW_CURSOR);
    } catch {
      /* best-effort */
    }
  };
  process.once('exit', onExit);

  try {
    ttyFd = fs.openSync(ttyPath, 'r+');
    const ttyWrite = fs.createWriteStream('', {
      fd: ttyFd,
      autoClose: false,
    } as Parameters<typeof fs.createWriteStream>[1]);

    ttyWrite.write(HIDE_CURSOR);
    cardState = renderCard(ttyWrite, toolName, args, riskMetadata, timeoutMs);

    // Countdown timer
    const startedAt = Date.now();
    countdownInterval = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      updateCountdown(cardState!, timeoutMs - elapsed);
    }, 1000);

    // Acquire CSRF and read keypress concurrently
    const [csrfToken, key] = await Promise.all([
      getCsrfToken(daemonPort, signal),
      new Promise<'allow' | 'deny'>((resolve, reject) => {
        autoReject = () => reject(new Error('Aborted'));
        if (signal.aborted) {
          reject(new Error('Aborted'));
          return;
        }
        readKeypress(ttyFd!, signal).then(resolve).catch(reject);
      }),
    ]);

    clearInterval(countdownInterval);
    countdownInterval = null;
    clearCard(cardState);
    ttyWrite.write(SHOW_CURSOR);

    // Post decision to daemon (best-effort — 409 = another racer won, that's fine)
    try {
      await postDecision(id, key, csrfToken, daemonPort);
    } catch (err) {
      // Log to hook-debug.log on error, but don't fail the racer — we already
      // have the user's answer from the keypress.
      try {
        const debugLog = path.join(os.homedir(), '.node9', 'hook-debug.log');
        fs.appendFileSync(debugLog, `[terminal-approval] POST /decision failed: ${String(err)}\n`);
      } catch {
        /* ignore debug log errors */
      }
    }

    return key;
  } catch (err) {
    // Abort = another racer won, not an error condition
    const isAbort =
      err instanceof Error && (err.message === 'Aborted' || err.name === 'AbortError');
    if (!isAbort) {
      try {
        const debugLog = path.join(os.homedir(), '.node9', 'hook-debug.log');
        fs.appendFileSync(debugLog, `[terminal-approval] error: ${String(err)}\n`);
      } catch {
        /* ignore */
      }
    }
    return 'deny';
  } finally {
    if (countdownInterval !== null) clearInterval(countdownInterval);
    if (cardState !== null) {
      try {
        clearCard(cardState);
        cardState.ttyWrite.write(SHOW_CURSOR);
      } catch {
        /* ignore cleanup errors */
      }
    }
    if (ttyFd !== null) {
      try {
        fs.writeSync(ttyFd, SHOW_CURSOR);
        fs.closeSync(ttyFd);
      } catch {
        /* ignore */
      }
      ttyFd = null;
    }
    void autoReject; // referenced to avoid lint warning
    process.removeListener('exit', onExit);
  }
}
