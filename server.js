import http from 'node:http';
import https from 'node:https';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, normalize } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCerts, HOSTNAME } from './lib/certs.js';
import { createMdns, isLocalAddress, lanAddresses, readTheme } from './lib/net.js';
import { askNotification, notify } from './lib/notify.js';

const HTTP_PORT = Number(process.env.HOTSPOT_SHARE_HTTP_PORT ?? 8080);
const HTTPS_PORT = Number(process.env.HOTSPOT_SHARE_HTTPS_PORT ?? 8443);
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const BASE = process.env.HOTSPOT_SHARE_DIR ?? join(homedir(), 'Hotspot Share');
const DIRS = { send: join(BASE, 'send'), received: join(BASE, 'received') };
const STATE_DIR = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'hotspot-share');
const DISMISSED = join(STATE_DIR, 'dismissed.json');
const loadDismissed = () => {
  try {
    const list = JSON.parse(readFileSync(DISMISSED, 'utf8'));
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
};
let dismissed = loadDismissed();
const saveDismissed = () => {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(DISMISSED, JSON.stringify([...dismissed]));
  } catch {}
};

for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2',
};

// ---------- state ----------
const devices = new Map(); // id -> {id,label,ip,lastSeen}
const offers = new Map(); // id -> offer
const sse = new Set(); // {res,id,host}
let network = { ip: null, ifname: null };
let theme = readTheme();

const certs = createCerts(join(STATE_DIR, 'certs'));
const mdns = createMdns();

const label = (ua = '') => {
  const m = ua.match(/Android [^;]*; ([^)]*?)(?: Build|\))/);
  if (m) return m[1].trim();
  if (/iPhone|iPad/.test(ua)) return 'iOS device';
  return 'device';
};

const safeName = (raw) => {
  let n = basename(String(raw ?? '').replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').trim().replace(/^\.+/, '');
  if (n.length > 200) n = n.slice(0, 200);
  return n || 'file';
};

const uniquePath = (dir, name) => {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let p = join(dir, name);
  for (let i = 1; existsSync(p); i++) p = join(dir, `${stem} (${i})${ext}`);
  return p;
};

const listDir = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => {
        const s = statSync(join(dir, e.name));
        return { name: e.name, size: s.size, mtime: s.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
};

function snapshot(forId, isHost) {
  const urlName = `https://${HOSTNAME}:${HTTPS_PORT}`;
  return {
    host: isHost,
    network: {
      up: !!network.ip, ip: network.ip, ifname: network.ifname,
      urlName, urlIp: network.ip && `https://${network.ip}:${HTTPS_PORT}`,
      setupUrl: network.ip && `http://${network.ip}:${HTTP_PORT}`,
    },
    theme,
    devices: [...devices.values()].map(({ id, label, ip }) => ({ id, label, ip })),
    send: listDir(DIRS.send),
    received: isHost ? listDir(DIRS.received).filter((f) => !dismissed.has(f.name)).slice(0, 6) : [],
    offers: [...offers.values()]
      .filter((o) => isHost || o.from === forId)
      .map(({ cancel, ...o }) => o)
      .sort((a, b) => b.ts - a.ts),
  };
}

let pending = null;
function broadcast() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    for (const c of sse) c.res.write(`event: state\ndata: ${JSON.stringify(snapshot(c.id, c.host))}\n\n`);
  }, 120);
}

// ---------- helpers ----------
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

// Anything from the network can be malformed: percent-decoding and URL parsing throw on it.
// Treat that as a bad request for that one client, never as a reason to stop the server.
const decodePart = (s) => { try { return decodeURIComponent(s); } catch { return null; } };
const originHost = (o) => { try { return new URL(o).host; } catch { return null; } };
const badRequest = (res) => json(res, 400, { error: 'bad request' });

// A file that vanishes mid-request emits 'error' on the stream; without a listener that is fatal.
const pipeFile = (res, file) => createReadStream(file).on('error', () => res.destroy()).pipe(res);

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (d) => {
      buf += d;
      if (buf.length > 1_000_000) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

const touch = (id, req) => {
  if (!id) return;
  const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const known = devices.has(id);
  devices.set(id, { id, label: label(req.headers['user-agent']), ip, lastSeen: Date.now() });
  if (!known) {
    broadcast();
    notify('Device connected', devices.get(id).label);
  }
};

const versionHash = () => {
  const h = createHash('sha1');
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = statSync(p); h.update(`${p}:${s.size}:${s.mtimeMs}`); }
    }
  };
  walk(PUBLIC);
  return h.digest('hex').slice(0, 10);
};

function serveStatic(req, res, pathname) {
  const decoded = decodePart(pathname);
  if (decoded === null) return badRequest(res);
  let rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '.') rel = '/index.html';
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); return res.end('not found');
  }
  const headers = { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' };
  if (rel === '/sw.js') {
    headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    return res.end(readFileSync(file, 'utf8').replace('__VERSION__', versionHash()));
  }
  headers['Cache-Control'] = 'no-cache';
  res.writeHead(200, headers);
  pipeFile(res, file);
}

function download(res, dir, name) {
  const file = join(dir, safeName(name));
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': statSync(file).size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(file))}`,
  });
  pipeFile(res, file);
}

function decide(offer, accept) {
  if (offer.status !== 'pending') return false;
  offer.status = accept ? 'accepted' : 'declined';
  offer.cancel?.();
  if (accept) offer.files.forEach((f) => (f.status = 'accepted'));
  broadcast();
  return true;
}

function newOffer(from, files) {
  const offer = {
    id: randomUUID(), from, label: devices.get(from)?.label ?? 'device', ts: Date.now(), status: 'pending',
    files: files.slice(0, 200).map((f) => ({ name: safeName(f.name), size: Number(f.size) || 0, got: 0, status: 'pending' })),
  };
  const total = offer.files.length;
  const q = askNotification(`${offer.label} wants to send`, total === 1 ? offer.files[0].name : `${total} files`);
  offer.cancel = q.cancel;
  q.result.then((r) => { if (r) decide(offer, r === 'accept'); });
  offers.set(offer.id, offer);
  broadcast();
  return offer;
}

// ---------- routes ----------
// Whatever goes wrong while routing one request (malformed URL, bad percent-encoding, odd
// headers) is answered on that request. It must never escape as an unhandled rejection,
// which Node turns into process exit and takes both listeners and every transfer with it.
async function handle(req, res, secure) {
  try {
    await route(req, res, secure);
  } catch (e) {
    const bad = e instanceof URIError || e?.code === 'ERR_INVALID_URL';
    if (res.headersSent) return res.destroy();
    try { json(res, bad ? 400 : 500, { error: bad ? 'bad request' : 'server error' }); } catch { res.destroy(); }
  }
}

async function route(req, res, secure) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const host = isLocalAddress(req.socket.remoteAddress);
  const method = req.method;

  // Plain HTTP is only the app for this machine; others get the CA setup page.
  if (!secure && !host) {
    if (path === '/ca.crt') {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="hotspot-share-ca.crt"' });
      return pipeFile(res, certs.caPath);
    }
    if (path.startsWith('/vendor/') || path === '/style.css' || path === '/icon.svg') return serveStatic(req, res, path);
    return serveStatic(req, res, '/setup.html');
  }

  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && originHost(origin) !== req.headers.host) return json(res, 403, { error: 'origin' });
  }

  if (!path.startsWith('/api/')) return serveStatic(req, res, path);

  const hostOnly = () => { if (!host) { json(res, 403, { error: 'host only' }); return false; } return true; };
  const id = url.searchParams.get('id');

  try {
    if (path === '/api/ping') {
      if (!host) touch(id, req);
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (path === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const client = { res, id, host };
      sse.add(client);
      if (!host) touch(id, req);
      res.write(`event: state\ndata: ${JSON.stringify(snapshot(id, host))}\n\n`);
      req.on('close', () => sse.delete(client));
      return;
    }

    if (path === '/api/ca.crt') {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert' });
      return pipeFile(res, certs.caPath);
    }

    // Snapshot for the native Omarchy bar popup (host only).
    if (path === '/api/state') {
      if (!hostOnly()) return;
      return json(res, 200, snapshot(id, true));
    }

    if (path === '/api/open-folder' && method === 'POST') {
      if (!hostOnly()) return;
      spawn('xdg-open', [BASE], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      return json(res, 200, { ok: true });
    }

    let m;
    if ((m = path.match(/^\/api\/dl\/(send|received)\/(.+)$/))) {
      if (m[1] === 'received' && !hostOnly()) return;
      const name = decodePart(m[2]);
      if (name === null) return badRequest(res);
      return download(res, DIRS[m[1]], name);
    }

    if ((m = path.match(/^\/api\/send\/(.+)$/))) {
      if (!hostOnly()) return;
      const decoded = decodePart(m[1]);
      if (decoded === null) return badRequest(res);
      const name = safeName(decoded);
      if (method === 'DELETE') { rmSync(join(DIRS.send, name), { force: true }); broadcast(); return json(res, 200, { ok: true }); }
      if (method === 'PUT') {
        const tmp = join(DIRS.send, `.${randomUUID()}.part`);
        const out = createWriteStream(tmp);
        req.pipe(out);
        req.on('aborted', () => { out.destroy(); rmSync(tmp, { force: true }); });
        out.on('finish', () => { renameSync(tmp, uniquePath(DIRS.send, name)); broadcast(); json(res, 200, { ok: true }); });
        return;
      }
    }

    if ((m = path.match(/^\/api\/received\/(.+)\/dismiss$/)) && method === 'POST') {
      if (!hostOnly()) return;
      const decoded = decodePart(m[1]);
      if (decoded === null) return badRequest(res);
      dismissed.add(safeName(decoded));
      saveDismissed();
      broadcast();
      return json(res, 200, { ok: true });
    }

    // Received files are never deleted from the widget. The only host action
    // is dismissing a row from the popup; the file stays on disk.

    if (path === '/api/offer' && method === 'POST') {
      const body = await readJson(req);
      if (!id || !Array.isArray(body.files) || !body.files.length) return json(res, 400, { error: 'bad offer' });
      touch(id, req);
      const o = newOffer(id, body.files);
      return json(res, 200, { id: o.id });
    }

    if ((m = path.match(/^\/api\/offer\/([\w-]+)\/decision$/)) && method === 'POST') {
      if (!hostOnly()) return;
      const o = offers.get(m[1]);
      const { accept } = await readJson(req);
      return json(res, o && decide(o, !!accept) ? 200 : 409, { ok: !!o });
    }

    if ((m = path.match(/^\/api\/offer\/([\w-]+)\/cancel$/)) && method === 'POST') {
      const o = offers.get(m[1]);
      if (o && (host || o.from === id)) {
        o.cancel?.();
        if (o.status === 'pending' || o.status === 'accepted') o.status = 'cancelled';
        broadcast();
      }
      return json(res, 200, { ok: true });
    }

    if ((m = path.match(/^\/api\/upload\/([\w-]+)\/(\d+)$/)) && method === 'PUT') {
      const o = offers.get(m[1]);
      const f = o?.files[Number(m[2])];
      if (!o || !f || (o.from !== id && !host) || o.status !== 'accepted' || f.status !== 'accepted') return json(res, 409, { error: 'not accepted' });
      f.status = 'receiving';
      const tmp = join(DIRS.received, `.${randomUUID()}.part`);
      const out = createWriteStream(tmp);
      let last = 0;
      req.on('data', (d) => {
        f.got += d.length;
        if (Date.now() - last > 250) { last = Date.now(); broadcast(); }
      });
      const fail = () => { out.destroy(); rmSync(tmp, { force: true }); if (f.status === 'receiving') f.status = 'failed'; broadcast(); };
      req.on('aborted', fail);
      req.on('error', fail);
      req.pipe(out);
      out.on('finish', () => {
        if (f.status !== 'receiving') return;
        renameSync(tmp, uniquePath(DIRS.received, f.name));
        f.status = 'done';
        if (o.files.every((x) => ['done', 'failed'].includes(x.status))) {
          o.status = 'done';
          notify('Received', o.files.length === 1 ? f.name : `${o.files.length} files from ${o.label}`);
        }
        broadcast();
        json(res, 200, { ok: true });
      });
      return;
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e.message ?? e) });
  }
}

// ---------- servers ----------
const ips = () => lanAddresses().map((a) => a.ip);
let tls = certs.ensure(ips());

const httpsServer = https.createServer(tls, (req, res) => { handle(req, res, true).catch(() => res.destroy()); });
const httpServer = http.createServer((req, res) => { handle(req, res, false).catch(() => res.destroy()); });
// Last resort: a stray rejection is logged, not fatal. Request errors are handled in handle().
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e?.message ?? e));
for (const s of [httpServer, httpsServer]) { s.requestTimeout = 0; s.headersTimeout = 60_000; }

httpsServer.listen(HTTPS_PORT, '0.0.0.0');
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`hotspot-share  http://localhost:${HTTP_PORT}  https://${HOSTNAME}:${HTTPS_PORT}  → ${BASE}`);
});

// ---------- background loops ----------
function refreshNetwork() {
  const [first] = lanAddresses();
  const next = { ip: first?.ip ?? null, ifname: first?.name ?? null };
  const nextTheme = readTheme();
  let changed = false;

  if (next.ip !== network.ip) {
    network = next;
    mdns.set(network.ip);
    try {
      tls = certs.ensure(ips());
      httpsServer.setSecureContext(tls);
    } catch (e) { console.error('cert error', e.message); }
    changed = true;
  }
  if (JSON.stringify(nextTheme) !== JSON.stringify(theme)) { theme = nextTheme; changed = true; }
  if (changed) broadcast();
}
refreshNetwork();
setInterval(refreshNetwork, 3000);

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, d] of devices) if (now - d.lastSeen > 9000) { devices.delete(id); changed = true; }
  for (const [id, o] of offers) {
    if (o.status === 'accepted' && o.files.every((f) => ['done', 'failed'].includes(f.status))) { o.status = 'done'; changed = true; }
    if (o.status === 'pending' && now - o.ts > 10 * 60_000) { o.cancel?.(); o.status = 'declined'; changed = true; }
    if (o.status !== 'pending' && o.status !== 'accepted' && now - o.ts > 60 * 60_000) { offers.delete(id); changed = true; }
  }
  if (changed) broadcast();
  for (const c of sse) c.res.write(': hb\n\n');
}, 3000);

for (const d of Object.values(DIRS)) { try { watch(d, () => broadcast()); } catch {} }

process.on('SIGTERM', () => { mdns.stop(); process.exit(0); });
process.on('SIGINT', () => { mdns.stop(); process.exit(0); });
