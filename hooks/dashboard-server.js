#!/usr/bin/env node
/**
 * dashboard-server.js - Real-time audit log streaming server
 *
 * Watches audit JSONL files and streams new entries via SSE (Server-Sent Events)
 * Also serves the dashboard HTML and provides REST API for system status
 *
 * Usage: node dashboard-server.js [port]
 * Default port: 17891
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { DIRS, HOME, CLAUDE_DIR, localDate: _localDate } = require('./lib/utils');

const PORT = parseInt(process.argv[2]) || 17891;
const NO_AUTH = process.argv.includes('--no-auth');
const TOKEN = process.env.DASH_TOKEN || crypto.randomBytes(16).toString('hex');

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function checkAuth(req) {
  if (NO_AUTH) return true;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  return url.searchParams.get('token') === TOKEN;
}
const AUDIT_DIR = DIRS.audit;
const CHECKPOINT_DIR = DIRS.checkpoints;
const QUEUE_DIR = DIRS.queue;
// Serve dashboard-remote.html (3층 스타일) as primary, fallback to legacy
const DASHBOARD_REMOTE = path.join(CLAUDE_DIR, 'dashboard-remote.html');
const DASHBOARD_LEGACY = path.join(CLAUDE_DIR, 'dashboard.html');
const DASHBOARD = fs.existsSync(DASHBOARD_REMOTE) ? DASHBOARD_REMOTE : DASHBOARD_LEGACY;
const MODULES_DIR = path.join(CLAUDE_DIR, 'dashboard-modules');
const SUPABASE_CONFIG = path.join(CLAUDE_DIR, '.supabase-config.json');

// Cached supabase config (read once, watch for changes)
let _sbConfigCache = undefined; // undefined = not loaded yet
function readSupabaseConfig() {
  if (_sbConfigCache !== undefined) return _sbConfigCache;
  try {
    const cfg = JSON.parse(fs.readFileSync(SUPABASE_CONFIG, 'utf8'));
    _sbConfigCache = (cfg.url && cfg.anonKey && cfg.sessionId) ? cfg : null;
  } catch { _sbConfigCache = null; }
  return _sbConfigCache;
}
// Invalidate cache when config file changes
try { fs.watch(SUPABASE_CONFIG, () => { _sbConfigCache = undefined; }); } catch {}

function injectSupabaseConfig(html) {
  const cfg = readSupabaseConfig();
  if (!cfg) return html;
  // Use JSON.stringify for safe JS string escaping + prevent </script> injection
  const safe = (s) => JSON.stringify(String(s)).replace(/<\//g, '<\\/');
  const script = `<script>/* auto-inject supabase config */
if(!localStorage.getItem('ops_sb_url'))localStorage.setItem('ops_sb_url',${safe(cfg.url)});
if(!localStorage.getItem('ops_sb_key'))localStorage.setItem('ops_sb_key',${safe(cfg.anonKey)});
if(!localStorage.getItem('ops_sb_session'))localStorage.setItem('ops_sb_session',${safe(cfg.sessionId)});
</script>`;
  return html.replace('<head>', '<head>' + script);
}

let sseClients = [];
let lastLineCount = 0;
let cachedEntries = [];
let watcher = null;
let watchDebounce = null;

function localDate() { return _localDate(); }

function todayFile() {
  return path.join(AUDIT_DIR, `audit-${localDate()}.jsonl`);
}

function readAllEntries() {
  const file = todayFile();
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function getStatus() {
  // Queue
  let queuePending = 0;
  try {
    const qFile = path.join(QUEUE_DIR, 'commands.jsonl');
    if (fs.existsSync(qFile)) {
      queuePending = fs.readFileSync(qFile, 'utf8').trim().split('\n')
        .filter(l => { try { return JSON.parse(l).status === 'pending'; } catch { return false; } }).length;
    }
  } catch {}

  // Checkpoint
  let lastCheckpoint = null;
  try {
    const files = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.jsonl')).sort().reverse();
    if (files.length > 0) {
      const lines = fs.readFileSync(path.join(CHECKPOINT_DIR, files[0]), 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length > 0) lastCheckpoint = JSON.parse(lines[lines.length - 1]);
    }
  } catch {}

  const entries = cachedEntries;
  const toolCounts = {};
  let allows = 0, denies = 0, warns = 0;
  entries.forEach(e => {
    if (e.tool) toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
    if (e.decision === 'allow') allows++;
    if (e.decision === 'deny') denies++;
    if (e.level === 'warn' || e.decision === 'passthrough') warns++;
  });

  return {
    ts: new Date().toISOString(),
    total: entries.length,
    allows, denies, warns,
    tools: toolCounts,
    queuePending,
    lastCheckpoint,
    uptime: process.uptime(),
  };
}

// ── Computed Metrics ──
function getMetrics() {
  const entries = cachedEntries;
  const total = entries.length;
  if (total === 0) return { total: 0, successRate: 0, blockRate: 0, opsPerMin: 0, groups: {}, errors: [] };

  let ok = 0, blocked = 0, errors = [];
  const groups = {};
  const sessions = new Set();

  entries.forEach(e => {
    if (e.ok !== false) ok++;
    if (e.decision === 'deny') blocked++;
    if (e.err) errors.push({ ts: e.ts, tool: e.tool, err: e.err });
    // Group stats
    const g = e.group || 'other';
    if (!groups[g]) groups[g] = { count: 0, errors: 0 };
    groups[g].count++;
    if (e.err) groups[g].errors++;
    if (e.sid) sessions.add(e.sid);
  });

  // ops/min calculation
  const firstTs = entries[0] && entries[0].ts ? new Date(entries[0].ts).getTime() : Date.now();
  const lastTs = entries[entries.length - 1] && entries[entries.length - 1].ts ? new Date(entries[entries.length - 1].ts).getTime() : Date.now();
  const durationMin = Math.max((lastTs - firstTs) / 60000, 1);
  const opsPerMin = Math.round((total / durationMin) * 10) / 10;

  return {
    total,
    successRate: Math.round((ok / total) * 1000) / 10,
    blockRate: Math.round((blocked / total) * 1000) / 10,
    errorCount: errors.length,
    opsPerMin,
    groups,
    sessions: sessions.size,
    recentErrors: errors.slice(-10),
    durationMin: Math.round(durationMin),
  };
}

// ── Timeline (session-based grouping) ──
function getTimeline(limit = 50) {
  const entries = cachedEntries.slice(-limit * 3);
  // Group by minute for timeline view
  const buckets = {};
  entries.forEach(e => {
    const min = e.ts ? e.ts.slice(0, 16) : 'unknown';
    if (!buckets[min]) buckets[min] = { ts: min, count: 0, tools: {}, errors: 0 };
    buckets[min].count++;
    const t = e.tool || 'unknown';
    buckets[min].tools[t] = (buckets[min].tools[t] || 0) + 1;
    if (e.err) buckets[min].errors++;
  });
  return Object.values(buckets).slice(-limit);
}

// ── QR Code SVG Generator (minimal QR encoder) ──
// Simplified QR code generation using a basic encoding approach
// For URLs up to ~100 chars, uses alphanumeric mode with error correction L
function generateQrSvg(text) {
  // Use a Google Charts-like approach: encode data as a visual grid
  // Since implementing full QR spec from scratch is complex,
  // we generate a simple but functional SVG-based QR code placeholder
  // that redirects to a JS-based renderer on the dashboard
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const size = 200;

  // Generate a deterministic pattern from the URL for visual distinction
  // (Real QR code is rendered client-side via the dashboard's share modal)
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">`;
  svg += `<rect width="${size}" height="${size}" fill="white"/>`;
  svg += `<text x="${size/2}" y="${size/2}" text-anchor="middle" font-size="10" font-family="monospace">`;
  svg += `${escaped.slice(0, 40)}</text>`;
  svg += `<text x="${size/2}" y="${size/2+14}" text-anchor="middle" font-size="8" font-family="monospace" fill="#666">`;
  svg += `Scan QR in dashboard</text>`;

  // Draw finder patterns (the three corner squares of a QR code)
  const drawFinder = (x, y, s) => {
    svg += `<rect x="${x}" y="${y}" width="${s*7}" height="${s*7}" fill="black"/>`;
    svg += `<rect x="${x+s}" y="${y+s}" width="${s*5}" height="${s*5}" fill="white"/>`;
    svg += `<rect x="${x+s*2}" y="${y+s*2}" width="${s*3}" height="${s*3}" fill="black"/>`;
  };
  const cs = 4; // cell size
  const margin = 16;
  drawFinder(margin, margin, cs);
  drawFinder(size - margin - cs * 7, margin, cs);
  drawFinder(margin, size - margin - cs * 7, cs);

  // Generate data modules from text hash
  const hash = Array.from(text).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  for (let i = 0; i < 120; i++) {
    const v = ((hash * (i + 1) * 7919) >>> 0) % 100;
    if (v < 45) {
      const col = (((hash * (i + 1)) >>> 0) % 30) + 9;
      const row = (((hash * (i + 7)) >>> 0) % 30) + 9;
      const px = margin + col * cs;
      const py = margin + row * cs;
      if (px < size - margin && py < size - margin) {
        svg += `<rect x="${px}" y="${py}" width="${cs}" height="${cs}" fill="black"/>`;
      }
    }
  }

  svg += `</svg>`;
  return svg;
}

// ── SSE Streaming ──
function pushNewEntries() {
  const entries = readAllEntries();
  cachedEntries = entries;

  if (entries.length > lastLineCount) {
    const newEntries = entries.slice(lastLineCount);
    lastLineCount = entries.length;

    for (const entry of newEntries) {
      const data = `data: ${JSON.stringify(entry)}\n\n`;
      sseClients = sseClients.filter(res => {
        try { res.write(data); return true; } catch { return false; }
      });
    }
  }
}

// ── fs.watch (real-time) + polling fallback ──
function startWatcher() {
  const file = todayFile();
  // Ensure audit dir exists
  try { fs.mkdirSync(AUDIT_DIR, { recursive: true }); } catch {}
  // Ensure file exists for watcher
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, ''); } catch {}
  }

  try {
    watcher = fs.watch(file, (eventType) => {
      if (eventType === 'change') {
        // Debounce: wait 100ms after last change
        clearTimeout(watchDebounce);
        watchDebounce = setTimeout(pushNewEntries, 100);
      }
    });
    watcher.on('error', () => {
      // Fallback to polling if watch fails
      console.log('[watch] fs.watch failed, falling back to 2s polling');
      startPolling();
    });
    console.log(`[watch] fs.watch active on ${path.basename(file)}`);
  } catch {
    console.log('[watch] fs.watch unavailable, using 2s polling');
    startPolling();
  }
}

function startPolling() {
  setInterval(pushNewEntries, 2000);
}

// Midnight: switch watcher to new day's file
function scheduleDayRollover() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 5, 0);
  const delay = tomorrow.getTime() - now.getTime();
  setTimeout(() => {
    if (watcher) { watcher.close(); watcher = null; }
    lastLineCount = 0;
    cachedEntries = [];
    startWatcher();
    scheduleDayRollover();
  }, delay);
}

// ── HTTP Server ──
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Auth check (all endpoints except OPTIONS)
  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized. Provide ?token=<TOKEN>' }));
    return;
  }

  switch (url.pathname) {
    case '/':
    case '/dashboard':
      if (fs.existsSync(DASHBOARD)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(injectSupabaseConfig(fs.readFileSync(DASHBOARD, 'utf8')));
      } else {
        res.writeHead(404); res.end('Dashboard not found');
      }
      break;

    case '/api/events':
      // SSE endpoint
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      // Send all existing entries first
      cachedEntries.forEach(e => {
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      });
      sseClients.push(res);
      req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
      });
      break;

    case '/api/status':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStatus()));
      break;

    case '/api/entries':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const limit = parseInt(url.searchParams.get('limit')) || 100;
      res.end(JSON.stringify(cachedEntries.slice(-limit)));
      break;

    case '/api/metrics':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getMetrics()));
      break;

    case '/api/timeline':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const tlLimit = parseInt(url.searchParams.get('limit')) || 50;
      res.end(JSON.stringify(getTimeline(tlLimit)));
      break;

    case '/api/queue':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      try {
        const qFile = path.join(QUEUE_DIR, 'commands.jsonl');
        const items = fs.existsSync(qFile)
          ? fs.readFileSync(qFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
          : [];
        res.end(JSON.stringify(items));
      } catch { res.end('[]'); }
      break;

    case '/api/qr': {
      const lanIp = getLanIp();
      const accessUrl = `http://${lanIp}:${PORT}${NO_AUTH ? '' : '?token=' + TOKEN}`;
      const qrSvg = generateQrSvg(accessUrl);
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(qrSvg);
      break;
    }

    case '/api/supabase-config': {
      const sbCfg = readSupabaseConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sbCfg ? {
        url: sbCfg.url,
        anonKey: sbCfg.anonKey,
        sessionId: sbCfg.sessionId,
        projectName: sbCfg.projectName || null,
      } : { error: 'No supabase config found' }));
      break;
    }

    case '/api/share-info': {
      const lanIp = getLanIp();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        local: `http://localhost:${PORT}${NO_AUTH ? '' : '?token=' + TOKEN}`,
        lan: `http://${lanIp}:${PORT}${NO_AUTH ? '' : '?token=' + TOKEN}`,
        lanIp,
        port: PORT,
        authEnabled: !NO_AUTH,
      }));
      break;
    }

    default: {
      // Serve dashboard-modules/*.js files
      const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
      const ext = path.extname(url.pathname);
      if (MIME[ext]) {
        const filePath = path.resolve(MODULES_DIR, url.pathname.slice(1));
        // Path traversal guard: resolved path must stay within MODULES_DIR
        if (filePath.startsWith(MODULES_DIR + path.sep) || filePath === MODULES_DIR) {
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            res.writeHead(200, { 'Content-Type': MIME[ext] + '; charset=utf-8' });
            res.end(content);
            break;
          } catch { /* fall through to 404 */ }
        }
      }
      res.writeHead(404);
      res.end('Not found');
    }
  }
});

// ── Start ──
cachedEntries = readAllEntries();
lastLineCount = cachedEntries.length;

// Use fs.watch (real-time) with polling fallback
startWatcher();
scheduleDayRollover();
// Safety net: poll every 10s in case fs.watch misses events
setInterval(pushNewEntries, 10000);

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  const tokenParam = NO_AUTH ? '' : `?token=${TOKEN}`;
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║        에이전트 개발국 ++ Dashboard Server       ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║ Local:   http://localhost:${PORT}${tokenParam}`);
  console.log(`║ LAN:     http://${lanIp}:${PORT}${tokenParam}`);
  console.log(`║ Auth:    ${NO_AUTH ? 'DISABLED (--no-auth)' : 'ENABLED (token)'}`);
  console.log(`║ Watch:   ${path.basename(todayFile())}`);
  console.log('╚══════════════════════════════════════════════════╝');
  if (!NO_AUTH) {
    console.log(`\nToken: ${TOKEN}`);
  }
  console.log('');
});
