import { spawn } from 'node:child_process';

// Desktop notification with Accept / Decline. Resolves with 'accept' | 'decline' | null.
// Call cancel() to dismiss it (e.g. when the web UI answered first).
export function askNotification(title, body) {
  const proc = spawn('notify-send', ['-A', 'accept=Accept', '-A', 'decline=Decline', '-w', '-u', 'critical',
    '-a', 'Hotspot Share', title, body], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  const result = new Promise((resolve) => {
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const v = out.trim();
      resolve(v === 'accept' || v === 'decline' ? v : null);
    });
  });
  return { result, cancel: () => proc.kill() };
}

export function notify(title, body) {
  spawn('notify-send', ['-a', 'Hotspot Share', title, body], { stdio: 'ignore' }).on('error', () => {});
}
