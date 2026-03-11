#!/usr/bin/env node
/**
 * bootstrap.js - Cross-platform auto-setup for Claude Agent System
 *
 * Runs as SessionStart hook. Idempotent — safe to run every session.
 * Detects environment (mobile sandbox vs desktop) and deploys accordingly.
 *
 * What it does:
 *   1. Detects environment (mobile container / desktop)
 *   2. Deploys hooks to $HOME/.claude/hooks/ (symlink on desktop, copy on mobile)
 *   3. Creates required directories
 *   4. Installs npm dependencies if missing
 *   5. Syncs settings.json (merges hooks + permissions)
 *   6. Chains to session-init.js for context loading
 *
 * stdout: JSON for SessionStart hook protocol
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE || '/root';
const CLAUDE_DIR = path.join(HOME, '.claude');
const TARGET_HOOKS = path.join(CLAUDE_DIR, 'hooks');
const TARGET_SERVICES = path.join(CLAUDE_DIR, 'services');

// Find repo root — bootstrap.js lives in hooks/
const REPO_DIR = path.resolve(__dirname, '..');
const SOURCE_HOOKS = path.join(REPO_DIR, 'hooks');
const SOURCE_SERVICES = path.join(REPO_DIR, 'services');

function out(s) { process.stdout.write(s); }
function err(s) { process.stderr.write(`[bootstrap] ${s}\n`); }

// ── Environment Detection ──

function detectEnv() {
  // Mobile/web Claude Code: /home/user workdir, ephemeral container, /dev/vda
  const indicators = {
    ephemeralContainer: fs.existsSync('/opt/claude-code'),
    homeIsRoot: HOME === '/root',
    repoInHomeUser: REPO_DIR.startsWith('/home/user'),
  };
  const isMobile = indicators.ephemeralContainer && indicators.repoInHomeUser;
  return {
    platform: isMobile ? 'mobile' : 'desktop',
    os: process.platform,
    ...indicators,
  };
}

// ── Directory Setup ──

function ensureDirs() {
  const dirs = [
    CLAUDE_DIR,
    path.join(CLAUDE_DIR, 'logs'),
    path.join(CLAUDE_DIR, 'logs', 'audit'),
    path.join(CLAUDE_DIR, 'logs', 'checkpoints'),
    path.join(CLAUDE_DIR, 'contexts'),
    path.join(CLAUDE_DIR, 'queue'),
    path.join(CLAUDE_DIR, 'commands'),
    path.join(CLAUDE_DIR, 'orchestrator'),
    path.join(CLAUDE_DIR, '.tmp'),
  ];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// ── Hook Deployment ──

function deployHooks(env) {
  // Skip if already correctly deployed
  if (fs.existsSync(TARGET_HOOKS)) {
    const testFile = path.join(TARGET_HOOKS, 'session-init.js');
    if (fs.existsSync(testFile)) {
      // Verify lib/ is accessible
      const libPath = path.join(TARGET_HOOKS, 'lib', 'paths.js');
      if (fs.existsSync(libPath)) return 'skipped';
    }
  }

  if (env.platform === 'desktop') {
    // Desktop: symlink for live updates
    try {
      if (fs.existsSync(TARGET_HOOKS)) {
        const stat = fs.lstatSync(TARGET_HOOKS);
        if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(TARGET_HOOKS);
          if (target === SOURCE_HOOKS) return 'skipped';
          fs.unlinkSync(TARGET_HOOKS);
        } else {
          // Backup existing hooks dir
          const backup = TARGET_HOOKS + '.bak.' + Date.now();
          fs.renameSync(TARGET_HOOKS, backup);
          err(`backed up existing hooks to ${backup}`);
        }
      }
      fs.symlinkSync(SOURCE_HOOKS, TARGET_HOOKS, 'junction');
      return 'symlinked';
    } catch (e) {
      err(`symlink failed: ${e.message}, falling back to copy`);
      // Fall through to copy
    }
  }

  // Mobile or symlink fallback: copy files
  copyDir(SOURCE_HOOKS, TARGET_HOOKS);
  return 'copied';
}

function deployServices(env) {
  if (!fs.existsSync(SOURCE_SERVICES)) return 'no-source';

  if (env.platform === 'desktop') {
    try {
      if (fs.existsSync(TARGET_SERVICES)) {
        const stat = fs.lstatSync(TARGET_SERVICES);
        if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(TARGET_SERVICES);
          if (target === SOURCE_SERVICES) return 'skipped';
          fs.unlinkSync(TARGET_SERVICES);
        }
      }
      fs.symlinkSync(SOURCE_SERVICES, TARGET_SERVICES, 'junction');
      return 'symlinked';
    } catch {
      // Fall through to copy
    }
  }

  copyDir(SOURCE_SERVICES, TARGET_SERVICES);
  return 'copied';
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      // Skip if file unchanged (same size + mtime)
      try {
        const srcStat = fs.statSync(srcPath);
        const destStat = fs.statSync(destPath);
        if (srcStat.size === destStat.size && srcStat.mtimeMs <= destStat.mtimeMs) continue;
      } catch { /* dest doesn't exist, copy it */ }
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── Dependencies ──

function installDeps(env) {
  // Mobile: hooks use only Node.js built-ins, skip npm install (saves 10-30s)
  // Services (ws, supabase, sqlite) are desktop-only daemons
  if (env.platform === 'mobile') return 'skipped-mobile';

  const nodeModules = path.join(REPO_DIR, 'node_modules');
  const pkgJson = path.join(REPO_DIR, 'package.json');

  if (fs.existsSync(nodeModules) && fs.existsSync(path.join(nodeModules, '.package-lock.json'))) {
    return 'skipped';
  }

  if (!fs.existsSync(pkgJson)) return 'no-package-json';

  try {
    execSync('npm install --production --no-audit --no-fund 2>&1', {
      cwd: REPO_DIR,
      timeout: 60000,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return 'installed';
  } catch (e) {
    err(`npm install failed: ${e.message}`);
    return 'failed';
  }
}

// ── Settings Sync ──

function syncSettings() {
  const activeSettings = path.join(CLAUDE_DIR, 'settings.json');
  const repoSettings = path.join(REPO_DIR, 'settings.json');

  if (!fs.existsSync(repoSettings)) return 'no-repo-settings';

  let active = {};
  try { active = JSON.parse(fs.readFileSync(activeSettings, 'utf8')); } catch {}
  let repo = {};
  try { repo = JSON.parse(fs.readFileSync(repoSettings, 'utf8')); } catch { return 'parse-error'; }

  // Replace bootstrap hook command to point to deployed bootstrap
  const bootstrapCmd = `node "${TARGET_HOOKS}/bootstrap.js"`;

  // Build merged settings
  const merged = {
    $schema: repo.$schema || active.$schema,
    env: { ...repo.env },
    alwaysThinkingEnabled: repo.alwaysThinkingEnabled ?? true,
    enableAllProjectMcpServers: repo.enableAllProjectMcpServers ?? false,
    cleanupPeriodDays: repo.cleanupPeriodDays ?? 365,
    permissions: repo.permissions || active.permissions || {},
    hooks: {
      SessionStart: [
        {
          matcher: '',
          hooks: [{
            type: 'command',
            command: bootstrapCmd,
            timeout: 15,
          }],
        },
      ],
      UserPromptSubmit: repo.hooks?.UserPromptSubmit || [],
      PostToolUse: repo.hooks?.PostToolUse || [],
      Stop: repo.hooks?.Stop || [],
    },
  };

  const mergedStr = JSON.stringify(merged, null, 2) + '\n';
  const activeStr = fs.existsSync(activeSettings) ? fs.readFileSync(activeSettings, 'utf8') : '';

  if (mergedStr === activeStr) return 'skipped';

  fs.writeFileSync(activeSettings, mergedStr);
  return 'synced';
}

// ── Chain to session-init.js ──

function chainSessionInit() {
  try {
    const sessionInit = path.join(TARGET_HOOKS, 'session-init.js');
    if (!fs.existsSync(sessionInit)) return null;

    const result = execSync(`node "${sessionInit}"`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

// ── Main ──

function main() {
  const startMs = Date.now();
  const env = detectEnv();
  const report = { env: env.platform };

  try {
    ensureDirs();
    report.hooks = deployHooks(env);
    report.services = deployServices(env);
    report.deps = installDeps(env);
    report.settings = syncSettings();
    report.elapsed = Date.now() - startMs;

    // Log bootstrap result
    try {
      const logFile = path.join(CLAUDE_DIR, 'logs', 'bootstrap.jsonl');
      fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), ...report }) + '\n');
    } catch {}

    // Chain to session-init for context loading
    const sessionOutput = chainSessionInit();
    if (sessionOutput && sessionOutput !== '{}') {
      // Pass through session-init output
      out(sessionOutput);
      return;
    }

    // If no session context, provide bootstrap status
    const actions = Object.entries(report)
      .filter(([k, v]) => v !== 'skipped' && k !== 'env' && k !== 'elapsed')
      .map(([k, v]) => `${k}:${v}`);

    if (actions.length > 0) {
      out(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `[bootstrap] ${env.platform} | ${actions.join(', ')} (${report.elapsed}ms)`,
        },
      }));
    } else {
      out('{}');
    }
  } catch (e) {
    err(`fatal: ${e.message}`);
    out('{}');
  }
}

// Allow stdin to close (SessionStart hook protocol)
if (process.stdin.isTTY === undefined) {
  process.stdin.resume();
  process.stdin.on('end', main);
} else {
  main();
}
