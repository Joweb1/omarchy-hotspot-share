import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { HOSTNAME } from './certs.js';

const SKIP = /^(lo|docker|br-|veth|virbr|tun|tap|tailscale|zt|wg)/;

// Usable LAN addresses, Wi-Fi first.
export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (SKIP.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
    }
  }
  return out.sort((a, b) => Number(b.name.startsWith('wl')) - Number(a.name.startsWith('wl')));
}

export const isLoopback = (addr = '') => addr === '::1' || addr === '127.0.0.1' || addr.startsWith('::ffff:127.');

export function isLocalAddress(addr = '') {
  const a = addr.replace(/^::ffff:/, '');
  return isLoopback(addr) || lanAddresses().some((l) => l.ip === a);
}

// Keeps `hotspot-share.local` pointing at the current LAN IP via avahi.
export function createMdns() {
  let proc = null;
  let ip = null;
  return {
    set(next) {
      if (next === ip) return;
      ip = next;
      proc?.kill();
      proc = null;
      if (!ip) return;
      proc = spawn('avahi-publish', ['-a', '-R', HOSTNAME, ip], { stdio: 'ignore' });
      proc.on('error', () => {});
    },
    stop() { proc?.kill(); },
  };
}

// Omarchy theme colors (falls back to Tokyo Night).
const FALLBACK = {
  background: '#1a1b26', darker_background: '#0e0e14', lighter_background: '#24283b', selection: '#292e42',
  foreground: '#a9b1d6', dark_foreground: '#565f89', bright_foreground: '#c0caf5',
  accent: '#7aa2f7', green: '#9ece6a', red: '#f7768e', yellow: '#e0af68', mode: 'dark',
};

export function readTheme() {
  try {
    const raw = readFileSync(`${homedir()}/.local/state/omarchy/current/theme/colors.toml`, 'utf8');
    const out = { ...FALLBACK };
    for (const m of raw.matchAll(/^\s*(\w+)\s*=\s*"([^"]*)"/gm)) out[m[1]] = m[2];
    return out;
  } catch {
    return FALLBACK;
  }
}
