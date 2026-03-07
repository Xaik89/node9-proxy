// src/ui/native.ts
import { spawn } from 'child_process';

const isTestEnv = () =>
  !!(
    process.env.VITEST ||
    process.env.NODE_ENV === 'test' ||
    process.env.CI ||
    process.env.NODE9_TESTING === '1'
  );

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

  const details = JSON.stringify(args, null, 2);
  const title = `🛡️ Node9 Security: ${agent || 'AI Agent'}`;

  let message = '';
  // Apply the Governance Lock visual warning
  if (locked) {
    message += `⚡ LOCKED BY ADMIN POLICY: Awaiting Slack Approval.\n\n`;
  }

  message += `Action: ${toolName}\n`;
  if (explainableLabel) message += `Flagged By: ${explainableLabel}\n`;
  message += `\nArguments:\n${details.slice(0, 400)}${details.length > 400 ? '...' : ''}`;

  // Escape for shell/applescript safety
  const safeMessage = message.replace(/"/g, '\\"').replace(/`/g, "'");

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
        const buttons = locked
          ? `buttons {"Cancel"} default button "Cancel" cancel button "Cancel"`
          : `buttons {"Block", "Always Allow", "Allow"} default button "Allow" cancel button "Block"`;

        const script = `
          tell application "System Events"
            activate
            display dialog "${safeMessage}" with title "${title}" ${buttons}
          end tell`;

        childProcess = spawn('osascript', ['-e', script]);
        let output = '';
        childProcess.stdout?.on('data', (d) => (output += d.toString()));

        childProcess.on('close', (code) => {
          cleanup();
          if (locked) return resolve('deny'); // Can only cancel if locked
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
              'Cancel',
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
          if (code === 0) return resolve('allow');
          if (output.includes('Always Allow')) return resolve('always_allow');
          resolve('deny');
        });
      }

      // --- Windows ---
      else if (process.platform === 'win32') {
        const buttonType = locked ? 'OK' : 'YesNo';
        const ps = `
          Add-Type -AssemblyName PresentationFramework;
          $res = [System.Windows.MessageBox]::Show("${safeMessage}", "${title}", "${buttonType}", "Warning", "Button1", "DefaultDesktopOnly");
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
