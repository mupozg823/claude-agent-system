#!/usr/bin/env node
/**
 * tunnel.js - External access tunnel for dashboard server
 *
 * Creates a public tunnel to the local dashboard server using:
 *   1. ngrok (if installed) - preferred
 *   2. localtunnel (npx, no install needed) - fallback
 *
 * Features:
 *   - Auto-starts dashboard server if not running
 *   - Outputs tunnel URL with auth token
 *   - Generates ASCII QR code for mobile access
 *   - Clean shutdown with Ctrl+C
 *
 * Usage: node tunnel.js [--no-auth]
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = 17891;
const NO_AUTH = process.argv.includes('--no-auth');
const { HOME } = require('./lib/utils');

let dashProcess = null;
let tunnelProcess = null;
let dashToken = null;

// ── ASCII QR Code Generator (simplified) ──
// Uses a compact encoding to generate a scannable QR-like pattern in terminal
function generateAsciiQr(text) {
  // Since implementing full QR encoder from scratch is very complex,
  // we'll output the URL in a visually prominent way with a box
  // and use npx qrcode-terminal for actual QR if available
  const lines = [];
  const w = Math.max(text.length + 4, 40);
  lines.push('┌' + '─'.repeat(w) + '┐');
  lines.push('│' + ' '.repeat(w) + '│');
  const pad = w - text.length;
  const lp = Math.floor(pad / 2);
  const rp = pad - lp;
  lines.push('│' + ' '.repeat(lp) + text + ' '.repeat(rp) + '│');
  lines.push('│' + ' '.repeat(w) + '│');
  lines.push('└' + '─'.repeat(w) + '┘');
  return lines.join('\n');
}

// Try to generate real QR code using qrcode-terminal
async function printQr(url) {
  try {
    // Try qrcode-terminal via npx (auto-install)
    const proc = spawn('npx', ['--yes', 'qrcode-terminal', url], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: true,
    });
    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    await new Promise((resolve) => {
      proc.on('close', () => {
        if (output.trim()) {
          console.log('\n📱 QR Code (scan with mobile):');
          console.log(output);
        } else {
          console.log('\n📱 Access URL:');
          console.log(generateAsciiQr(url));
        }
        resolve();
      });
      // Timeout after 15s
      setTimeout(() => {
        proc.kill();
        console.log('\n📱 Access URL:');
        console.log(generateAsciiQr(url));
        resolve();
      }, 15000);
    });
  } catch {
    console.log('\n📱 Access URL:');
    console.log(generateAsciiQr(url));
  }
}

// Check if dashboard server is running
function isDashboardRunning() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${PORT}/api/status`, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 401);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

// Start dashboard server
async function startDashboard() {
  const running = await isDashboardRunning();
  if (running) {
    console.log('✅ Dashboard server already running on port', PORT);
    // Try to get the token from env or generate matching one
    return null;
  }

  console.log('🚀 Starting dashboard server...');
  const serverPath = path.join(HOME, '.claude', 'hooks', 'dashboard-server.js');
  const args = [serverPath];
  if (NO_AUTH) args.push('--no-auth');

  // Set token via env so we know it
  dashToken = process.env.DASH_TOKEN || crypto.randomBytes(16).toString('hex');
  const env = { ...process.env, DASH_TOKEN: dashToken };

  dashProcess = spawn('node', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    detached: false,
  });

  dashProcess.stdout.on('data', d => process.stdout.write(d));
  dashProcess.stderr.on('data', d => process.stderr.write(d));

  // Wait for server to be ready
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isDashboardRunning()) {
      console.log('✅ Dashboard server started');
      return dashToken;
    }
  }
  console.error('❌ Dashboard server failed to start');
  process.exit(1);
}

// Check if ngrok is available
function hasNgrok() {
  try {
    execSync('ngrok version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Start ngrok tunnel
function startNgrok() {
  return new Promise((resolve, reject) => {
    console.log('🔗 Starting ngrok tunnel...');
    tunnelProcess = spawn('ngrok', ['http', String(PORT), '--log', 'stdout'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    let output = '';
    const timeout = setTimeout(() => {
      // Parse ngrok output for URL
      const match = output.match(/url=(https?:\/\/[^\s]+)/);
      if (match) {
        resolve(match[1]);
      } else {
        reject(new Error('Could not get ngrok URL'));
      }
    }, 5000);

    tunnelProcess.stdout.on('data', d => {
      output += d.toString();
      const match = output.match(/url=(https?:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });

    tunnelProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// Start localtunnel
function startLocaltunnel() {
  return new Promise((resolve, reject) => {
    console.log('🔗 Starting localtunnel (npx)...');
    tunnelProcess = spawn('npx', ['--yes', 'localtunnel', '--port', String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error('Localtunnel timed out'));
    }, 30000);

    tunnelProcess.stdout.on('data', d => {
      output += d.toString();
      const match = output.match(/(https?:\/\/[^\s]+\.loca\.lt)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });

    tunnelProcess.stderr.on('data', d => {
      const str = d.toString();
      const match = str.match(/(https?:\/\/[^\s]+\.loca\.lt)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });

    tunnelProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    tunnelProcess.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Localtunnel exited with code ${code}`));
    });
  });
}

// Clean shutdown
function cleanup() {
  console.log('\n🛑 Shutting down...');
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
  }
  if (dashProcess) {
    dashProcess.kill();
    dashProcess = null;
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// ── Main ──
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║      에이전트 개발국 ++ Tunnel Gateway           ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // 1. Start dashboard if needed
  const token = await startDashboard();
  const effectiveToken = token || dashToken || process.env.DASH_TOKEN;
  const tokenParam = (NO_AUTH || !effectiveToken) ? '' : `?token=${effectiveToken}`;

  // 2. Show local access info
  const lanIp = (() => {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
    return '127.0.0.1';
  })();

  console.log(`\n📍 Local:  http://localhost:${PORT}${tokenParam}`);
  console.log(`📍 LAN:    http://${lanIp}:${PORT}${tokenParam}`);

  // 3. Start tunnel (ngrok preferred, localtunnel fallback)
  let tunnelUrl = null;
  try {
    if (hasNgrok()) {
      tunnelUrl = await startNgrok();
    } else {
      console.log('ℹ️  ngrok not found, using localtunnel (free, no account needed)');
      tunnelUrl = await startLocaltunnel();
    }
  } catch (err) {
    console.error('❌ Tunnel failed:', err.message);
    console.log('ℹ️  You can still access via LAN. For external access, install ngrok.');
  }

  if (tunnelUrl) {
    const fullUrl = `${tunnelUrl}${tokenParam}`;
    console.log(`\n🌍 Tunnel: ${fullUrl}`);
    console.log('');

    // 4. Print QR code
    await printQr(fullUrl);
  }

  console.log('\n💡 Press Ctrl+C to stop tunnel and server');
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err);
  cleanup();
});
