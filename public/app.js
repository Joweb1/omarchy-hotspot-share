'use strict';

const $ = (s) => document.querySelector(s);
const main = $('#main');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const cid = (() => {
  let v = store.get('hs-id');
  if (!v) {
    v = (crypto.randomUUID?.() ?? 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    store.set('hs-id', v);
  }
  return v;
})();

// ---------- state ----------
let S = null;                 // latest server snapshot
let conn = 'checking';        // checking | online | offline
let isHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
let mode = 'name';            // host QR mode: name | ip | setup
let fails = 0;
let es = null;
let installPrompt = null;
const outbox = new Map();     // offerId -> File[] waiting for accept (client)
const started = new Set();    // offerIds already uploading
const local = {};             // `${offerId}:${i}` -> bytes sent (client side, smoother than server)
const hostUp = [];            // in-flight uploads to the send folder (host)

// ---------- helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, cls = '') => `<svg class="ic ${cls}"><use href="#i-${n}"/></svg>`;

const size = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};

const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

const api = (path, method = 'POST', body) =>
  fetch(`${path}${path.includes('?') ? '&' : '?'}id=${cid}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });

const put = (url, body, onp) =>
  new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.upload.onprogress = (e) => onp?.(e.loaded, e.total);
    x.onload = () => (x.status < 300 ? resolve() : reject(new Error(String(x.status))));
    x.onerror = () => reject(new Error('network'));
    x.send(body);
  });

// ---------- theme ----------
function applyTheme(t) {
  if (!t) return;
  const r = document.documentElement.style;
  const map = {
    '--bg0': t.darker_background, '--bg': t.background, '--bg2': t.lighter_background, '--line': t.selection ?? t.muted,
    '--fg': t.foreground, '--dim': t.dark_foreground ?? t.muted, '--hi': t.bright_foreground ?? t.foreground,
    '--accent': t.accent, '--ok': t.green, '--err': t.red, '--warn': t.yellow,
  };
  for (const [k, v] of Object.entries(map)) if (v) r.setProperty(k, v);
  r.setProperty('color-scheme', t.mode === 'light' ? 'light' : 'dark');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t.darker_background ?? '#0e0e14');
}
try { applyTheme(JSON.parse(store.get('hs-theme'))); } catch {}

// ---------- views ----------
const qrSvg = (text) => {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><path d="${d}" fill="#0b0b10"/></svg>`;
};

const step = (n, icon, text, code) =>
  `<div class="step"><div class="badge">${ic(icon)}</div><div><div class="n">0${n}</div>${esc(text)}${code ? `<code>${esc(code)}</code>` : ''}</div></div>`;

const guide = (steps, waiting) =>
  `<div class="steps">${steps.join('')}</div>${waiting ? `<div class="retry">${ic('loader', 'spin')} ${esc(waiting)}</div>` : ''}`;

const guideClient = () =>
  guide([
    step(1, 'phone', 'Turn on phone hotspot'),
    step(2, 'laptop', 'Connect laptop to it'),
    step(3, 'wifi', 'Keep this open'),
  ], 'waiting for laptop');

const guideNoNetwork = () =>
  guide([
    step(1, 'phone', 'Turn on phone hotspot'),
    step(2, 'wifi', 'Join it from this laptop'),
  ], 'waiting for network');

const guideService = () =>
  guide([step(1, 'terminal', 'Start the service', 'systemctl --user start hotspot-share')], 'waiting for service');

const fileRows = (files, actions, empty) =>
  files.length
    ? `<div class="rows">${files.map((f) => `<div class="row">${ic('file')}<div class="body"><div class="name">${esc(f.name)}</div><div class="meta">${size(f.size)} · ${ago(f.mtime)}</div></div>${actions(f)}</div>`).join('')}</div>`
    : `<div class="empty">${ic('inbox')}<span>${empty}</span></div>`;

function offerProgress(o) {
  let got = 0, total = 0;
  o.files.forEach((f, i) => {
    total += f.size;
    got += f.status === 'done' ? f.size : Math.max(f.got, local[`${o.id}:${i}`] ?? 0);
  });
  return total ? Math.min(100, Math.round((got / total) * 100)) : 0;
}

const offerNames = (o) => (o.files.length === 1 ? esc(o.files[0].name) : `${o.files.length} files`);

function hostOffers() {
  const list = S.offers.filter((o) => o.status === 'pending' || o.status === 'accepted');
  if (!list.length) return '';
  return `<div class="card"><div class="title">${ic('download')}<b>incoming</b></div>${list.map((o) => {
    const names = o.files.slice(0, 4).map((f) => `${esc(f.name)} <span class="dim">${size(f.size)}</span>`).join('<br>') + (o.files.length > 4 ? `<br>+${o.files.length - 4}` : '');
    const body = o.status === 'pending'
      ? `<div class="actions"><button class="btn primary" data-act="decide" data-oid="${o.id}" data-v="1">${ic('check')} accept</button><button class="btn danger" data-act="decide" data-oid="${o.id}" data-v="0">${ic('x')} decline</button></div>`
      : `<div class="state dim">${offerProgress(o)}%</div><div class="bar" style="margin-left:34px"><i style="width:${offerProgress(o)}%"></i></div>`;
    return `<div class="offer"><div class="head">${ic('phone')}<div><span class="dim">${esc(o.label)}</span> · ${offerNames(o)}</div></div><div class="files">${names}</div>${body}</div>`;
  }).join('')}</div>`;
}

function clientOffers() {
  const list = S.offers.filter((o) => Date.now() - o.ts < 3 * 60_000);
  if (!list.length) return '';
  return `<div class="card"><div class="title">${ic('upload')}<b>sending</b></div>${list.map((o) => {
    const failed = o.files.some((f) => f.status === 'failed');
    let state;
    if (o.status === 'pending') state = `<div class="state dim">${ic('loader', 'spin')} waiting for laptop <button class="ibtn" data-act="cancel" data-oid="${o.id}" title="cancel">${ic('x')}</button></div>`;
    else if (o.status === 'accepted') state = `<div class="state dim">${offerProgress(o)}%</div><div class="bar" style="margin-left:34px"><i style="width:${offerProgress(o)}%"></i></div>`;
    else if (o.status === 'done') state = failed ? `<div class="state err">${ic('x')} failed</div>` : `<div class="state ok">${ic('check')} sent</div>`;
    else state = `<div class="state err">${ic('x')} ${esc(o.status)}</div>`;
    return `<div class="offer"><div class="head">${ic('file')}<div>${offerNames(o)} <span class="dim">${size(o.files.reduce((a, f) => a + f.size, 0))}</span></div></div>${state}</div>`;
  }).join('')}</div>`;
}

function hostConnect() {
  const n = S.network;
  if (!n.up) return `<div class="card"><div class="title">${ic('wifi-off')}<b>no network</b></div>${guideNoNetwork()}</div>`;
  const url = mode === 'ip' ? n.urlIp : mode === 'setup' ? n.setupUrl : n.urlName;
  const seg = (m, label) => `<button class="btn ${mode === m ? 'on' : ''}" data-act="mode" data-v="${m}">${label}</button>`;
  return `<div class="card"><div class="title">${ic('qr')}<b>${mode === 'setup' ? 'setup' : 'connect'}</b></div>
    <div class="qr">${qrSvg(url)}</div>
    <div class="url"><span>${esc(url)}</span><button class="ibtn" data-act="copy" data-v="${esc(url)}" title="copy">${ic('copy')}</button></div>
    <div class="seg">${seg('name', 'name')}${seg('ip', 'ip')}${seg('setup', ic('shield'))}</div></div>`;
}

function hostSend() {
  const up = hostUp.map((u) => `<div class="row">${ic('loader', 'spin')}<div class="body"><div class="name">${esc(u.name)}</div><div class="bar"><i style="width:${u.size ? Math.round((u.loaded / u.size) * 100) : 0}%"></i></div></div></div>`).join('');
  return `<div class="card"><div class="title">${ic('upload')}<b>send</b><span class="grow"></span><button class="ibtn" data-act="open-folder" title="open folder">${ic('folder')}</button></div>
    <button class="drop" data-act="pick">${ic('plus')}</button>${up ? `<div class="rows">${up}</div>` : ''}
    ${fileRows(S.send, (f) => `<button class="ibtn" data-act="del-send" data-name="${esc(f.name)}" title="delete">${ic('trash')}</button>`, 'empty')}</div>`;
}

function hostReceived() {
  return `<div class="card"><div class="title">${ic('download')}<b>received</b></div>
    ${fileRows(S.received, (f) => `<a class="ibtn" href="/api/dl/received/${encodeURIComponent(f.name)}" download title="save">${ic('download')}</a><button class="ibtn" data-act="del-recv" data-name="${esc(f.name)}" title="delete">${ic('trash')}</button>`, 'empty')}</div>`;
}

function clientFiles() {
  return `<div class="card"><div class="title">${ic('laptop')}<b>from laptop</b></div>
    ${fileRows(S.send, (f) => `<a class="ibtn bordered" href="/api/dl/send/${encodeURIComponent(f.name)}" download title="download">${ic('download')}</a>`, 'empty')}</div>`;
}

// ---------- render ----------
let lastHtml = '';
let raf = 0;
const render = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };

function setPill(s, text) {
  $('#pill').dataset.s = s;
  $('#pill-text').textContent = text;
}

function draw() {
  document.body.dataset.role = isHost ? 'host' : 'client';
  document.body.dataset.conn = conn;
  const data = S ?? { network: { up: false }, devices: [], send: [], received: [], offers: [] };
  const S0 = S; S = data;
  let html;

  if (isHost) {
    if (conn !== 'online') {
      setPill('off', conn === 'checking' ? '…' : 'service offline');
      html = guideService();
    } else {
      const d = data.devices;
      if (!data.network.up) setPill('off', 'no network');
      else if (!d.length) setPill('wait', 'waiting');
      else setPill('on', d.length === 1 ? `connected · ${d[0].label}` : `connected · ${d.length} devices`);
      html = `<div class="grid"><div class="stack">${hostConnect()}</div><div class="stack">${hostOffers()}${hostSend()}${hostReceived()}</div></div>`;
    }
  } else if (conn === 'online') {
    setPill('on', 'connected');
    html = `<div class="stack"><button class="act" data-act="pick"><span class="badge">${ic('upload')}</span><span>send to laptop<small>choose files</small></span></button>${clientOffers()}${clientFiles()}</div>`;
  } else {
    setPill(conn === 'checking' ? 'wait' : 'off', conn === 'checking' ? 'connecting' : 'not connected');
    html = guideClient();
  }

  S = S0;
  if (html !== lastHtml) { lastHtml = html; main.innerHTML = html; }
}

// ---------- connection ----------
function openEvents() {
  es?.close();
  es = new EventSource(`/api/events?id=${cid}`);
  es.addEventListener('state', (e) => {
    S = JSON.parse(e.data);
    if (typeof S.host === 'boolean') isHost = S.host;
    store.set('hs-theme', JSON.stringify(S.theme));
    applyTheme(S.theme);
    startPendingUploads();
    render();
  });
}

async function ping() {
  let ok = false;
  try {
    const r = await fetch(`/api/ping?id=${cid}`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    ok = r.status === 204;
  } catch {}
  fails = ok ? 0 : fails + 1;
  const next = ok ? 'online' : fails >= 2 || conn === 'checking' && fails >= 1 ? 'offline' : conn;
  if (next !== conn) {
    conn = next;
    if (conn === 'online') openEvents();
    else { es?.close(); es = null; }
    render();
  }
}
ping();
setInterval(ping, 3000);
addEventListener('online', ping);
addEventListener('offline', () => { fails = 2; ping(); });

// ---------- transfers ----------
function startPendingUploads() {
  for (const o of S.offers) {
    const files = outbox.get(o.id);
    if (!files || o.status !== 'accepted' || started.has(o.id)) continue;
    started.add(o.id);
    (async () => {
      for (let i = 0; i < files.length; i++) {
        try {
          await put(`/api/upload/${o.id}/${i}?id=${cid}`, files[i], (n) => { local[`${o.id}:${i}`] = n; render(); });
        } catch { toast('upload failed'); }
      }
      outbox.delete(o.id);
    })();
  }
}

async function offerFiles(files) {
  if (!files.length) return;
  try {
    const r = await api('/api/offer', 'POST', { files: files.map((f) => ({ name: f.name, size: f.size })) });
    const { id } = await r.json();
    outbox.set(id, files);
  } catch { toast('not connected'); }
}

async function sendToFolder(files) {
  for (const f of files) {
    const u = { name: f.name, size: f.size, loaded: 0 };
    hostUp.push(u);
    render();
    try { await put(`/api/send/${encodeURIComponent(f.name)}?id=${cid}`, f, (n) => { u.loaded = n; render(); }); }
    catch { toast('failed'); }
    hostUp.splice(hostUp.indexOf(u), 1);
    render();
  }
}

const handleFiles = (list) => {
  const files = [...list];
  if (isHost) sendToFolder(files); else offerFiles(files);
};

$('#pick').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });

// drag & drop (laptop)
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (isHost && e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (isHost && e.dataTransfer?.files.length) handleFiles(e.dataTransfer.files);
});

// ---------- actions ----------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const d = b.dataset;
  switch (d.act) {
    case 'pick': $('#pick').click(); break;
    case 'copy': navigator.clipboard?.writeText(d.v).then(() => toast('copied')); break;
    case 'mode': mode = d.v; render(); break;
    case 'decide': api(`/api/offer/${d.oid}/decision`, 'POST', { accept: d.v === '1' }); break;
    case 'cancel': api(`/api/offer/${d.oid}/cancel`); break;
    case 'del-send': api(`/api/send/${encodeURIComponent(d.name)}`, 'DELETE'); break;
    case 'del-recv': api(`/api/received/${encodeURIComponent(d.name)}`, 'DELETE'); break;
    case 'open-folder': api('/api/open-folder'); break;
    case 'install': installPrompt?.prompt(); break;
  }
});

// ---------- PWA ----------
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#install').hidden = false;
});
addEventListener('appinstalled', () => { $('#install').hidden = true; installPrompt = null; });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

render();
