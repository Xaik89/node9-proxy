// src/daemon/index.ts — Node9 localhost approval server (barrel)
// Public API for the daemon module. Internal implementation split into:
//   daemon/state.ts  — shared state, types, utility functions, SSE/broadcast
//   daemon/server.ts — HTTP server and all route handlers (startDaemon)
import fs from 'fs';
import chalk from 'chalk';
import { spawnSync } from 'child_process';

export { startDaemon } from './server';
export {
  DAEMON_PORT,
  DAEMON_HOST,
  DAEMON_PID_FILE,
  DECISIONS_FILE,
  AUDIT_LOG_FILE,
  hasInteractiveClient,
} from './state';

import { DAEMON_PORT, DAEMON_PID_FILE } from './state';

export function stopDaemon(): void {
  if (!fs.existsSync(DAEMON_PID_FILE)) return console.log(chalk.yellow('Not running.'));
  try {
    const { pid } = JSON.parse(fs.readFileSync(DAEMON_PID_FILE, 'utf-8'));
    process.kill(pid, 'SIGTERM');
    console.log(chalk.green('✅ Stopped.'));
  } catch {
    console.log(chalk.gray('Cleaned up stale PID file.'));
  } finally {
    try {
      fs.unlinkSync(DAEMON_PID_FILE);
    } catch {}
  }
}

export function daemonStatus(): void {
  if (fs.existsSync(DAEMON_PID_FILE)) {
    try {
      const { pid } = JSON.parse(fs.readFileSync(DAEMON_PID_FILE, 'utf-8'));
      process.kill(pid, 0);
      console.log(chalk.green('Node9 daemon: running'));
      return;
    } catch {
      console.log(chalk.yellow('Node9 daemon: not running (stale PID)'));
      return;
    }
  }
  // No PID file — check if port is actually in use (orphaned daemon)
  const r = spawnSync('ss', ['-Htnp', `sport = :${DAEMON_PORT}`], {
    encoding: 'utf8',
    timeout: 500,
  });
  if (r.status === 0 && (r.stdout ?? '').includes(`:${DAEMON_PORT}`)) {
    console.log(chalk.yellow('Node9 daemon: running (no PID file — orphaned)'));
  } else {
    console.log(chalk.yellow('Node9 daemon: not running'));
  }
}
