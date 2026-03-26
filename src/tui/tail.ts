// src/tui/tail.ts — Terminal Flight Recorder + Interactive Approvals
import http from 'http';
import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawn, execSync } from 'child_process';
import { DAEMON_PORT } from '../daemon';
import { getConfig } from '../core';

const PID_FILE = path.join(os.homedir(), '.node9', 'daemon.pid');

const ICONS: Record<string, string> = {
  bash: '💻',
  shell: '💻',
  terminal: '💻',
  read: '📖',
  edit: '✏️',
  write: '✏️',
  glob: '📂',
  grep: '🔍',
  agent: '🤖',
  search: '🔍',
  sql: '🗄️',
  query: '🗄️',
  list: '📂',
  delete: '🗑️',
  web: '🌐',
};

function getIcon(tool: string): string {
  const t = tool.toLowerCase();
  for (const [k, v] of Object.entries(ICONS)) {
    if (t.includes(k)) return v;
  }
  return '🛠️';
}

interface ActivityItem {
  id: string;
  tool: string;
  args: unknown;
  ts: number;
  status?: string;
}

interface ResultItem {
  id: string;
  status: string;
  label?: string;
}

interface ApprovalRequest {
  id: string;
  toolName: string;
  args: unknown;
  riskMetadata?: {
    tier?: number;
    blockedByLabel?: string;
    matchedField?: string;
    matchedWord?: string;
  };
  timestamp?: number;
}

export interface TailOptions {
  history?: boolean;
  clear?: boolean;
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const RESET = '\x1B[0m';
const BOLD = '\x1B[1m';
const RED = '\x1B[31m';
const YELLOW = '\x1B[33m';
const CYAN = '\x1B[36m';
const GRAY = '\x1B[90m';
const GREEN = '\x1B[32m';
const HIDE_CURSOR = '\x1B[?25l';
const SHOW_CURSOR = '\x1B[?25h';
const ERASE_DOWN = '\x1B[J';
const SAVE_CURSOR = '\x1B7';
const RESTORE_CURSOR = '\x1B8';

// ── Activity feed rendering ───────────────────────────────────────────────────

function formatBase(activity: ActivityItem): string {
  const time = new Date(activity.ts).toLocaleTimeString([], { hour12: false });
  const icon = getIcon(activity.tool);
  const toolName = activity.tool.slice(0, 16).padEnd(16);
  const argsStr = JSON.stringify(activity.args ?? {}).replace(/\s+/g, ' ');
  const argsPreview = argsStr.length > 70 ? argsStr.slice(0, 70) + '…' : argsStr;
  return `${chalk.gray(time)} ${icon} ${chalk.white.bold(toolName)} ${chalk.dim(argsPreview)}`;
}

function renderResult(activity: ActivityItem, result: ResultItem): void {
  const base = formatBase(activity);
  let status: string;
  if (result.status === 'allow') {
    status = chalk.green('✓ ALLOW');
  } else if (result.status === 'dlp') {
    status = chalk.bgRed.white.bold(' 🛡️  DLP ');
  } else {
    status = chalk.red('✗ BLOCK');
  }

  if (process.stdout.isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
  console.log(`${base}  ${status}`);
}

function renderPending(activity: ActivityItem): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`${formatBase(activity)}  ${chalk.yellow('● …')}\r`);
}

// ── Daemon startup ────────────────────────────────────────────────────────────

async function ensureDaemon(): Promise<number> {
  // Read the port from PID file if it exists, then verify the daemon is alive
  let pidPort: number | null = null;
  if (fs.existsSync(PID_FILE)) {
    try {
      const { port } = JSON.parse(fs.readFileSync(PID_FILE, 'utf-8')) as { port: number };
      pidPort = port;
    } catch {
      // Corrupt or unreadable PID file — fall back to DAEMON_PORT for the health check
      console.error(chalk.dim('⚠️  Could not read PID file; falling back to default port.'));
    }
  }

  // Health check — covers both PID-file and orphaned daemon cases
  const checkPort = pidPort ?? DAEMON_PORT;
  try {
    const res = await fetch(`http://127.0.0.1:${checkPort}/settings`, {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) return checkPort;
  } catch {}

  // Not running — start it in the background
  console.log(chalk.dim('🛡️  Starting Node9 daemon...'));
  const child = spawn(process.execPath, [process.argv[1], 'daemon'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, NODE9_AUTO_STARTED: '1' },
  });
  child.unref();

  // Wait up to 5s for it to be ready
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/settings`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return DAEMON_PORT;
    } catch {}
  }

  console.error(chalk.red('❌ Daemon failed to start. Try: node9 daemon start'));
  process.exit(1);
}

// ── POST /decision ────────────────────────────────────────────────────────────

function postDecisionHttp(
  id: string,
  decision: 'allow' | 'deny',
  csrfToken: string,
  port: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ decision, source: 'terminal' });
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
        res.resume();
        // 200 = success, 409 = idempotent conflict (another racer already decided) — both ok
        if (res.statusCode === 200 || res.statusCode === 409) resolve();
        else reject(new Error(`POST /decision returned ${res.statusCode}`));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

// ── Approval card ─────────────────────────────────────────────────────────────

function buildCardLines(req: ApprovalRequest): string[] {
  const argsStr = JSON.stringify(req.args ?? {}).replace(/\s+/g, ' ');
  const argsPreview = argsStr.length > 60 ? argsStr.slice(0, 60) + '…' : argsStr;

  const tierLabel =
    req.riskMetadata?.tier != null
      ? req.riskMetadata.tier <= 2
        ? `${YELLOW}⚠  Tier ${req.riskMetadata.tier}`
        : `${RED}🛑 Tier ${req.riskMetadata.tier}`
      : `${YELLOW}⚠  Review`;
  const blockedBy = req.riskMetadata?.blockedByLabel ?? 'Policy rule';

  return [
    ``,
    `${BOLD}${CYAN}╔══ Node9 Approval Required ══╗${RESET}`,
    `${CYAN}║${RESET} Tool:    ${BOLD}${req.toolName}${RESET}`,
    `${CYAN}║${RESET} Reason:  ${tierLabel} — ${blockedBy}${RESET}`,
    `${CYAN}║${RESET} Args:    ${GRAY}${argsPreview}${RESET}`,
    `${CYAN}╚${RESET}`,
    ``,
    `  ${BOLD}${GREEN}[A]${RESET} Allow   ${BOLD}${RED}[D]${RESET} Deny`,
    ``,
  ];
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function startTail(options: TailOptions = {}): Promise<void> {
  const port = await ensureDaemon();

  if (options.clear) {
    const result = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
      const req = http.request(
        { method: 'POST', hostname: '127.0.0.1', port, path: '/events/clear' },
        (res) => {
          const status = res.statusCode ?? 0;
          // Attach 'end' before resume() so the event is never missed on fast responses
          res.on('end', () =>
            resolve({
              ok: status >= 200 && status < 300,
              code: status >= 200 && status < 300 ? undefined : `HTTP ${status}`,
            })
          );
          res.resume();
        }
      );
      // Register error handler before setTimeout so it is always in place before
      // any path that calls req.destroy() (timeout or caller abort).
      req.once('error', (err: NodeJS.ErrnoException) => resolve({ ok: false, code: err.code }));
      req.setTimeout(2000, () => {
        // resolve() before destroy() so the promise settles as ETIMEDOUT first.
        // destroy() may subsequently emit an error (e.g. ECONNRESET), but
        // req.once ensures the listener is already consumed by then — preventing
        // a second resolve(). Node.js guarantees no listener fires between a
        // synchronous resolve() and the next event-loop tick, so there is no
        // unhandled-rejection window here.
        resolve({ ok: false, code: 'ETIMEDOUT' });
        req.destroy();
      });
      req.end();
    });
    if (result.ok) {
      console.log(chalk.green('✓ Flight Recorder buffer cleared.'));
    } else if (result.code === 'ECONNREFUSED') {
      throw new Error('Daemon is not running. Start it with: node9 daemon start');
    } else if (result.code === 'ETIMEDOUT') {
      throw new Error('Daemon did not respond in time. Try: node9 daemon restart');
    } else {
      throw new Error(`Failed to clear buffer (${result.code ?? 'unknown error'})`);
    }
    return;
  }

  const connectionTime = Date.now();
  const activityPending = new Map<string, ActivityItem>();

  // ── Approval state ──────────────────────────────────────────────────────────
  let csrfToken = '';
  const approvalQueue: ApprovalRequest[] = [];
  let cardActive = false;
  // Number of lines the current card occupies (for clearing)
  let cardLineCount = 0;
  // Called when an external event (native popup, browser) resolves the active card
  let cancelActiveCard: (() => void) | null = null;

  const canApprove = process.stdout.isTTY && process.stdin.isTTY;
  // Enable keypress event parsing on stdin (idempotent — safe to call multiple times)
  if (canApprove) readline.emitKeypressEvents(process.stdin);

  function clearCard(): void {
    if (cardLineCount > 0) {
      process.stdout.write(RESTORE_CURSOR + ERASE_DOWN);
      cardLineCount = 0;
    }
  }

  function printCard(req: ApprovalRequest): void {
    process.stdout.write(HIDE_CURSOR + SAVE_CURSOR);
    const lines = buildCardLines(req);
    for (const line of lines) process.stdout.write(line + '\n');
    cardLineCount = lines.length;
  }

  function showNextCard(): void {
    if (cardActive || approvalQueue.length === 0 || !canApprove) return;

    // Attempt raw mode BEFORE rendering the card — if it fails we bail silently
    // rather than leaving a stranded card with no key handler attached.
    try {
      process.stdin.setRawMode(true);
    } catch {
      cardActive = false;
      return;
    }

    cardActive = true;
    const req = approvalQueue[0];
    printCard(req);

    let settled = false;
    type KeypressCb = (str: string, key: { name?: string; ctrl?: boolean }) => void;
    let onKeypress: KeypressCb | null = null;

    const cleanup = () => {
      const handler = onKeypress;
      onKeypress = null;
      if (handler) process.stdin.removeListener('keypress', handler);
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      process.stdin.pause();
      cancelActiveCard = null;
    };

    const settle = (decision: 'allow' | 'deny') => {
      if (settled) return;
      settled = true;
      cleanup();
      clearCard();
      process.stdout.write(SHOW_CURSOR);

      // POST decision best-effort; 409 = another racer already won
      postDecisionHttp(req.id, decision, csrfToken, port).catch((err) => {
        try {
          fs.appendFileSync(
            path.join(os.homedir(), '.node9', 'hook-debug.log'),
            `[tail] POST /decision failed: ${String(err)}\n`
          );
        } catch {
          /* ignore */
        }
      });

      // Print outcome in the activity feed
      const decisionLabel =
        decision === 'allow'
          ? chalk.green('✓ ALLOWED (terminal)')
          : chalk.red('✗ DENIED (terminal)');
      console.log(`${chalk.cyan('◆')} ${chalk.bold(req.toolName.padEnd(16))}  ${decisionLabel}`);

      approvalQueue.shift();
      cardActive = false;
      showNextCard();
    };

    // Exposed so the 'remove' SSE event can dismiss the card when another
    // racer (native popup, browser) already resolved the request.
    cancelActiveCard = () => {
      if (settled) return;
      settled = true;
      cleanup();
      clearCard();
      process.stdout.write(SHOW_CURSOR);
      approvalQueue.shift();
      cardActive = false;
      showNextCard();
    };

    process.stdin.resume();
    // Use keypress events (requires emitKeypressEvents called at startup) —
    // more reliable than raw 'data' buffer parsing across Node.js versions.
    onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      const name = key?.name ?? '';
      if (name === 'a') {
        settle('allow');
      } else if (
        name === 'd' ||
        name === 'return' ||
        name === 'enter' ||
        (key?.ctrl && name === 'c')
      ) {
        settle('deny');
      }
    };
    process.stdin.on('keypress', onKeypress);
  }

  const dashboardUrl = `http://127.0.0.1:${port}/`;

  // Open the browser dashboard from the foreground process — more reliable than
  // the daemon's detached spawn. Use execSync so failures throw and are caught.
  // getConfig() reads the actual project config (approvers.browser), unlike
  // GET /settings which only returns global settings and never includes approvers.
  try {
    const browserEnabled = getConfig().settings.approvers?.browser !== false;
    if (browserEnabled) {
      if (process.platform === 'darwin') execSync(`open "${dashboardUrl}"`, { stdio: 'ignore' });
      else if (process.platform === 'win32')
        execSync(`cmd /c start "" "${dashboardUrl}"`, { stdio: 'ignore' });
      else execSync(`xdg-open "${dashboardUrl}"`, { stdio: 'ignore' });
    }
  } catch {
    // Browser open failed — URL is printed in the banner below so the user
    // can open it manually.
  }

  console.log(chalk.cyan.bold(`\n🛰️  Node9 tail  `) + chalk.dim(`→ ${dashboardUrl}`));
  if (canApprove) {
    console.log(chalk.dim('Interactive approvals enabled. [A] Allow  [D] Deny'));
  }
  if (options.history) {
    console.log(chalk.dim('Showing history + live events. Press Ctrl+C to exit.\n'));
  } else {
    console.log(
      chalk.dim('Showing live events only. Use --history to include past. Press Ctrl+C to exit.\n')
    );
  }

  process.on('SIGINT', () => {
    clearCard();
    process.stdout.write(SHOW_CURSOR);
    if (process.stdout.isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    console.log(chalk.dim('\n🛰️  Disconnected.'));
    process.exit(0);
  });

  // Connect with capabilities=input so the daemon knows this is an interactive terminal
  const sseUrl = `http://127.0.0.1:${port}/events?capabilities=input`;
  const req = http.get(sseUrl, (res) => {
    if (res.statusCode !== 200) {
      console.error(chalk.red(`Failed to connect: HTTP ${res.statusCode}`));
      process.exit(1);
    }

    // Spec-compliant SSE parser: accumulate fields per message block
    let currentEvent = '';
    let currentData = '';
    res.on('error', () => {}); // handled by rl 'close'
    const rl = readline.createInterface({ input: res, crlfDelay: Infinity });
    rl.on('error', () => {}); // suppress — 'close' fires next and handles exit

    rl.on('line', (line) => {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        currentData = line.slice(5).trim();
      } else if (line === '') {
        // Message boundary — process accumulated fields
        if (currentEvent && currentData) {
          handleMessage(currentEvent, currentData);
        }
        currentEvent = '';
        currentData = '';
      }
    });

    rl.on('close', () => {
      clearCard();
      process.stdout.write(SHOW_CURSOR);
      if (process.stdout.isTTY) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
      }
      console.log(chalk.red('\n❌ Daemon disconnected.'));
      process.exit(1);
    });
  });

  function handleMessage(event: string, rawData: string): void {
    // ── CSRF token ───────────────────────────────────────────────────────────
    if (event === 'csrf') {
      try {
        const parsed = JSON.parse(rawData) as { token: string };
        if (parsed.token) csrfToken = parsed.token;
      } catch {}
      return;
    }

    // ── Initial payload ──────────────────────────────────────────────────────
    if (event === 'init') {
      try {
        const parsed = JSON.parse(rawData) as {
          requests?: ApprovalRequest[];
        };
        // Queue any requests that were pending before we connected
        if (canApprove && Array.isArray(parsed.requests)) {
          for (const r of parsed.requests) {
            approvalQueue.push(r);
          }
          showNextCard();
        }
      } catch {}
      return;
    }

    // ── New approval request ─────────────────────────────────────────────────
    if (event === 'add') {
      if (canApprove) {
        try {
          const parsed = JSON.parse(rawData) as ApprovalRequest & { interactive?: boolean };
          // Only show approval card when terminal approver is enabled in config.
          // browser-only configs still receive 'add' events for the browser UI,
          // but should not render a card in the tail terminal.
          if (parsed.interactive !== false) {
            approvalQueue.push(parsed);
            showNextCard();
          }
        } catch {}
      }
      return;
    }

    // ── Request resolved (by another racer) ──────────────────────────────────
    if (event === 'remove') {
      try {
        const { id } = JSON.parse(rawData) as { id: string };
        const idx = approvalQueue.findIndex((r) => r.id === id);
        if (idx !== -1) {
          if (idx === 0 && cardActive && cancelActiveCard) {
            // Current card was resolved externally (native popup, browser, timeout).
            // cancelActiveCard() stops raw-mode, clears the card, and advances the queue.
            cancelActiveCard();
          } else {
            approvalQueue.splice(idx, 1);
          }
        }
      } catch {}
      return;
    }

    // ── Activity feed ────────────────────────────────────────────────────────
    let data: ActivityItem & ResultItem;
    try {
      data = JSON.parse(rawData) as ActivityItem & ResultItem;
    } catch {
      return;
    }

    if (event === 'activity') {
      // History filter: skip replayed events unless --history requested
      if (!options.history && data.ts > 0 && data.ts < connectionTime) return;

      // Ring-buffer replay: activity events already have a resolved status — render immediately
      if (data.status && data.status !== 'pending') {
        renderResult(data, data);
        return;
      }

      activityPending.set(data.id, data);

      // Show pending indicator immediately for slow operations (bash, sql, agent)
      const slowTool = /bash|shell|query|sql|agent/i.test(data.tool);
      if (slowTool) renderPending(data);
    }

    if (event === 'activity-result') {
      const original = activityPending.get(data.id);
      if (original) {
        renderResult(original, data);
        activityPending.delete(data.id);
      }
    }
  }

  req.on('error', (err: NodeJS.ErrnoException) => {
    const msg =
      err.code === 'ECONNREFUSED'
        ? 'Daemon is not running. Start it with: node9 daemon start'
        : err.message;
    console.error(chalk.red(`\n❌ ${msg}`));
    process.exit(1);
  });
}
