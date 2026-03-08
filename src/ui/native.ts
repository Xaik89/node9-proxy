// src/ui/native.ts
import { spawn } from 'child_process';

const isTestEnv = () => {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true' ||
    !!process.env.VITEST ||
    process.env.CI === 'true' ||
    !!process.env.CI ||
    process.env.NODE9_TESTING === '1'
  );
};

/**
 * Sends a non-blocking, one-way system notification.
 */
export function sendDesktopNotification(title: string, body: string): void {
  if (isTestEnv()) return;

  try {
    const safeTitle = title.replace(/"/g, '\\"');
    const safeBody = body.replace(/"/g, '\\"');

    if (process.platform === 'darwin') {
      const script = `display notification "${safeBody}" with title "${safeTitle}"`;
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'linux') {
      spawn('notify-send', [safeTitle, safeBody, '--icon=dialog-warning'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  } catch {
    /* Silent fail for notifications */
  }
}

/**
 * Formats tool arguments into readable key: value lines.
 * Each value is truncated to avoid overwhelming the popup.
 */
function formatArgs(args: unknown): string {
  if (args === null || args === undefined) return '(none)';

  if (typeof args !== 'object' || Array.isArray(args)) {
    const str = typeof args === 'string' ? args : JSON.stringify(args);
    return str.length > 200 ? str.slice(0, 200) + '…' : str;
  }

  const entries = Object.entries(args as Record<string, unknown>).filter(
    ([, v]) => v !== null && v !== undefined && v !== ''
  );

  if (entries.length === 0) return '(none)';

  const MAX_FIELDS = 5;
  const MAX_VALUE_LEN = 120;

  const lines = entries.slice(0, MAX_FIELDS).map(([key, val]) => {
    const str = typeof val === 'string' ? val : JSON.stringify(val);
    const truncated = str.length > MAX_VALUE_LEN ? str.slice(0, MAX_VALUE_LEN) + '…' : str;
    return `  ${key}: ${truncated}`;
  });

  if (entries.length > MAX_FIELDS) {
    lines.push(`  … and ${entries.length - MAX_FIELDS} more field(s)`);
  }

  return lines.join('\n');
}

/**
 * Triggers an asynchronous, two-way OS dialog box.
 * Returns: 'allow' | 'deny' | 'always_allow'
 */
export async function askNativePopup(
  toolName: string,
  args: unknown,
  agent?: string,
  explainableLabel?: string,
  locked: boolean = false, // Phase 4.1: The Remote Lock
  signal?: AbortSignal // Phase 4.2: The Auto-Close Trigger
): Promise<'allow' | 'deny' | 'always_allow'> {
  if (isTestEnv()) return 'deny';
  if (process.env.NODE9_DEBUG === '1' || process.env.VITEST) {
    console.log(`[DEBUG Native] askNativePopup called for: ${toolName}`);
    console.log(`[DEBUG Native] isTestEnv check:`, {
      VITEST: process.env.VITEST,
      NODE_ENV: process.env.NODE_ENV,
      CI: process.env.CI,
      isTest: isTestEnv(),
    });
  }

  const title = locked
    ? `⚡ Node9 — Locked by Admin Policy`
    : `🛡️ Node9 — Action Requires Approval`;

  // Build a structured, scannable message
  let message = '';

  if (locked) {
    message += `⚡ Awaiting remote approval via Slack. Local override is disabled.\n`;
    message += `─────────────────────────────────\n`;
  }

  message += `Tool:    ${toolName}\n`;
  message += `Agent:   ${agent || 'AI Agent'}\n`;
  if (explainableLabel) {
    message += `Reason:  ${explainableLabel}\n`;
  }
  message += `\nArguments:\n${formatArgs(args)}`;

  if (!locked) {
    message += `\n\nEnter = Allow  |  Click "Block" to deny`;
  }

  // Escape for shell/applescript safety
  const safeMessage = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, "'");
  const safeTitle = title.replace(/"/g, '\\"');

  return new Promise((resolve) => {
    let childProcess: ReturnType<typeof spawn> | null = null;

    // The Auto-Close Logic (Fires when Cloud wins the race)
    const onAbort = () => {
      if (childProcess) {
        try {
          process.kill(childProcess.pid!, 'SIGKILL');
        } catch {}
      }
      resolve('deny');
    };

    if (signal) {
      if (signal.aborted) return resolve('deny');
      signal.addEventListener('abort', onAbort);
    }

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    try {
      // --- macOS ---
      if (process.platform === 'darwin') {
        // Default button is "Allow" — Enter = permit, Escape = Block
        const buttons = locked
          ? `buttons {"Waiting…"} default button "Waiting…"`
          : `buttons {"Block", "Always Allow", "Allow"} default button "Allow" cancel button "Block"`;

        const script = `
          tell application "System Events"
            activate
            display dialog "${safeMessage}" with title "${safeTitle}" ${buttons}
          end tell`;

        childProcess = spawn('osascript', ['-e', script]);
        let output = '';
        childProcess.stdout?.on('data', (d) => (output += d.toString()));

        childProcess.on('close', (code) => {
          cleanup();
          if (locked) return resolve('deny');
          if (code === 0) {
            if (output.includes('Always Allow')) return resolve('always_allow');
            if (output.includes('Allow')) return resolve('allow');
          }
          resolve('deny');
        });
      }

      // --- Linux ---
      else if (process.platform === 'linux') {
        const argsList = locked
          ? [
              '--info',
              '--title',
              title,
              '--text',
              safeMessage,
              '--ok-label',
              'Waiting for Slack…',
              '--timeout',
              '300',
            ]
          : [
              '--question',
              '--title',
              title,
              '--text',
              safeMessage,
              '--ok-label',
              'Allow',
              '--cancel-label',
              'Block',
              '--extra-button',
              'Always Allow',
              '--timeout',
              '300',
            ];

        childProcess = spawn('zenity', argsList);
        let output = '';
        childProcess.stdout?.on('data', (d) => (output += d.toString()));

        childProcess.on('close', (code) => {
          cleanup();
          if (locked) return resolve('deny');
          // zenity: --ok-label (Allow) = exit 0, --cancel-label (Block) = exit 1, extra-button = stdout
          if (output.trim() === 'Always Allow') return resolve('always_allow');
          if (code === 0) return resolve('allow'); // clicked "Allow" (ok-label, Enter)
          resolve('deny'); // clicked "Block" or timed out
        });
      }

      // --- Windows ---
      else if (process.platform === 'win32') {
        const buttonType = locked ? 'OK' : 'YesNo';
        const ps = `
          Add-Type -AssemblyName PresentationFramework;
          $res = [System.Windows.MessageBox]::Show("${safeMessage}", "${safeTitle}", "${buttonType}", "Warning", "Button2", "DefaultDesktopOnly");
          if ($res -eq "Yes") { exit 0 } else { exit 1 }`;

        childProcess = spawn('powershell', ['-Command', ps]);
        childProcess.on('close', (code) => {
          cleanup();
          if (locked) return resolve('deny');
          resolve(code === 0 ? 'allow' : 'deny');
        });
      } else {
        cleanup();
        resolve('deny');
      }
    } catch {
      cleanup();
      resolve('deny');
    }
  });
}
