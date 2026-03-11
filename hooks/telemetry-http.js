#!/usr/bin/env node
/**
 * telemetry-http.js - HTTP telemetry hook for Notification events
 *
 * Sends telemetry data to configured HTTP endpoint (Supabase Functions or custom).
 * Falls back to local JSONL on failure. Runs async so session is never blocked.
 *
 * Config: TELEMETRY_HTTP_URL env var or ~/.claude/telemetry-config.json
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const AUDIT_DIR = path.join(process.env.HOME, '.claude', 'audit');
const CONFIG_PATH = path.join(process.env.HOME, '.claude', 'telemetry-config.json');
const FALLBACK_FILE = path.join(AUDIT_DIR, 'telemetry-pending.jsonl');

function loadConfig() {
  const url = process.env.TELEMETRY_HTTP_URL;
  if (url) return { url, token: process.env.TELEMETRY_HTTP_TOKEN || '' };
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { /* silent */
    return null;
  }
}

function appendFallback(entry) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(FALLBACK_FILE, JSON.stringify(entry) + '\n');
  } catch { /* silent */ }
}

function sendHttp(url, token, payload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function flushPending(config) {
  if (!fs.existsSync(FALLBACK_FILE)) return;
  try {
    const lines = fs.readFileSync(FALLBACK_FILE, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return;

    const entries = lines.map(l => { try { return JSON.parse(l); } catch { /* silent */ return null; } }).filter(Boolean);
    if (entries.length === 0) return;

    await sendHttp(config.url, config.token, { events: entries, batch: true });
    fs.unlinkSync(FALLBACK_FILE);
  } catch { /* silent */
    // Keep pending file for next attempt
  }
}

async function main() {
  let raw = '';
  for await (const c of process.stdin) raw += c;

  let data;
  try { data = JSON.parse(raw); } catch { /* silent */ data = {}; }

  const config = loadConfig();
  const entry = {
    ts: new Date().toISOString(),
    ev: 'notification',
    session_id: data.session_id || 'unknown',
    message: (data.message || '').slice(0, 500),
    tool: data.tool_name || null,
  };

  if (!config || !config.url) {
    // No HTTP endpoint configured — local fallback only
    appendFallback(entry);
    return;
  }

  try {
    await sendHttp(config.url, config.token, entry);
    // Also try flushing any pending entries
    await flushPending(config);
  } catch { /* silent */
    appendFallback(entry);
  }
}

main().catch(() => {});
