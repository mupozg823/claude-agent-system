#!/usr/bin/env node
/**
 * smart-approve.js v3.1 - PreToolUse hook (Bash + Write/Edit matcher)
 *
 * v3.1 fixes:
 *   - cd/export/pushd prefix stripping before SAFE matching
 *   - Unclassified commands now explicitly allow (not passthrough)
 *   - Added missing SAFE patterns: sleep, nohup, timeout, start, for,
 *     git ls-remote/credential/pull/init/worktree, comments, quoted paths
 *
 * v3 features:
 *   - Indirect execution detection (eval, exec, source, backtick, $())
 *   - Pipe chain right-side danger analysis
 *   - Sensitive file write protection (Write/Edit)
 *   - 500 char logging
 *   - Unclassified command warning-level log
 *
 * stdin: { tool_name, tool_input, session_id, ... }
 * stdout: { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } } | {}
 */

const fs = require('fs');
const path = require('path');
const { DIRS, auditFile } = require('./lib/utils');

const AUDIT_DIR = DIRS.audit;

// ── 차단 패턴 (파괴적 작업) ──
const BLOCK = [
  /\brm\s+(-\w*r\w*\s+)?(-\w*f\w*\s+)?\//,
  /\brm\s+-rf\s+[~$]/,
  /\bgit\s+push\s+(--force|-f)\s+origin\s+(main|master)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bformat\s+[A-Z]:/i,
  /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev\//,
  /\bdel\s+\/s\s+\/q\s+C:\\Windows/i,
  />\s*\/dev\/sd[a-z]/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bnpm\s+publish\b/,
  /\bcurl\s+[^|]*\|\s*(ba)?sh\b/,
  /\bwget\s+[^|]*\|\s*(ba)?sh\b/,
];

// ── 간접 실행 위험 패턴 ──
const INDIRECT_DANGER = [
  /\beval\s+["'].*\b(rm|dd|mkfs|format|shutdown|reboot|DROP)\b/i,
  /\bexec\s+.*\b(rm|dd|mkfs|format|shutdown|reboot)\b/i,
  /\bsource\s+.*\|\s*(ba)?sh/,
  /`[^`]*(rm\s+-rf|dd\s+if|mkfs|shutdown|reboot)[^`]*`/,
  /\$\([^)]*(rm\s+-rf|dd\s+if|mkfs|shutdown|reboot)[^)]*\)/,
  /\bxargs\s+.*\brm\s+-rf\b/,
  /\bfind\s+.*-exec\s+rm\s+-rf/,
  /\benv\s+.*\brm\s+-rf\b/,
];

// ── 안전 패턴 (자동 승인) ──
// NOTE: These are tested against BOTH the original command AND the
// "effective command" (with cd/export/pushd prefixes stripped).
const SAFE = [
  // Shell builtins & file inspection
  /^\s*(ls|dir|cat|head|tail|wc|sort|uniq|diff|file|stat|which|where|type|readlink|realpath|basename|dirname)\b/,

  // Git - read-only
  /^\s*git\s+(status|log|diff|branch|show|blame|stash\s+list|tag|remote|fetch|version|config|rev-parse|ls-remote|ls-files|ls-tree|describe|shortlog|reflog|name-rev|worktree\s+list)\b/,
  /^\s*git\s+--version\b/,
  // Git - write (safe)
  /^\s*git\s+(add|commit|checkout|switch|merge|rebase|cherry-pick|stash|pull|init|worktree|clean|restore|rm|mv|submodule|credential)\b/,
  /^\s*git\s+push\b(?!\s+(--force|-f))/,
  /^\s*git\s+clone\b/,

  // Package managers
  /^\s*(npm|npx|pnpm|yarn|bun)\s+(test|run|start|ci|install|list|outdated|audit|exec|create|init|cache|config|info|view|search|ls|why|explain|prefix|root|bin|link|uninstall|remove|update|upgrade|dedupe|prune|pack|version|help)\b/,
  /^\s*(npm|npx|pnpm|yarn|bun)\s+(-y\s+|--yes\s+)/,

  // Runtimes & build tools
  /^\s*(node|python3?|pip|pip3|cargo|go\s+(run|test|build|mod)|ruby|java|javac|deno|bun)\b/,
  /^\s*(tsc|tsx|eslint|prettier|jest|vitest|pytest|mocha|playwright|cypress|webpack|vite|rollup|esbuild|swc|turbo)\b/,

  // Shell utilities
  /^\s*(echo|printf|date|whoami|hostname|uname|pwd|env|set|printenv|true|false|test|read)\b/,
  /^\s*(mkdir|cp|mv|touch|chmod|chown|find|grep|rg|ag|fd|sed|awk|xargs|tee|cut|tr|paste|comm|join)\b/,
  /^\s*(sleep|nohup|timeout|time|nice|yes)\b/,
  /^\s*(export|source|\.)\s/,

  // Editors / IDEs
  /^\s*(code|code-insiders|vim|vi|nano)\b/,

  // Network (without pipe-to-shell)
  /^\s*(curl|wget|http)\b(?!.*\|\s*(ba)?sh)/,

  // Containers
  /^\s*(docker|docker-compose|podman|kubectl|helm)\b/,

  // Windows-specific
  /^\s*(systeminfo|wmic|powershell|pwsh)\b/,
  /^\s*(winget|choco|scoop)\b/,
  /^\s*(start|explorer|cmd)\b/,
  /^\s*(tasklist|taskkill|ps|kill)\b/,
  /^\s*(schtasks|crontab)\b/,
  /^\s*(reg|setx|attrib|icacls|net)\b/,
  /^\s*cmdkey\b/,

  // GitHub CLI (also match quoted full paths)
  /^\s*gh\s/,
  /^\s*"[^"]*gh(\.exe)?"\s/,

  // Safe destructive (guarded by negative lookahead)
  /^\s*(rm|del)\s+(?!.*(-rf?\s+\/|\/s\s+\/q\s+C:\\Windows))/,

  // Archive
  /^\s*(tar|zip|unzip|7z|gzip|gunzip|bzip2|xz|zstd)\b/,

  // Databases (without DROP)
  /^\s*(sqlite3|psql|mysql|mongosh)\b(?!.*DROP)/i,

  // Claude CLI
  /^\s*(claude|anthropic)\b/,

  // Network diagnostics
  /^\s*(netstat|ss|lsof|nslookup|dig|ping|traceroute|ipconfig|ifconfig|arp|route)\b/,

  // Filesystem info
  /^\s*(tree|du|df|free|top|htop|watch)\b/,

  // Comments (lines starting with #)
  /^\s*#/,

  // for/while/if shell constructs
  /^\s*(for|while|if|case)\b/,

  // cat heredoc / multiline
  /^\s*cat\s*<</,
];

// ── 민감 파일 패턴 (Write/Edit 보호) ──
const SENSITIVE_PATHS = [
  /\.env($|\.)/,
  /credentials/i,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /id_rsa/,
  /id_ed25519/,
  /\.ssh\//,
  /\.aws\/(credentials|config)/,
  /secret/i,
  /password/i,
  /token\.json/i,
  /\.npmrc$/,
  /\.gitconfig$/,
  /\.netrc$/,
  /auth\.json/i,
  /api[_-]?key/i,
  /\.kube\/config/,
  /\.docker\/config\.json/,
  /keystore/i,
  /\.gnupg\//,
];

/**
 * Strip common safe command prefixes to get the "effective" command.
 * Handles patterns like:
 *   cd /some/path && actual_command
 *   cd /some/path; actual_command
 *   export FOO=bar && actual_command
 *   pushd /dir && actual_command
 *   # comment\nactual_command
 */
function extractEffectiveCommand(cmd) {
  let effective = cmd;

  // Strip leading cd/pushd/export/set chains (both && and ; separators)
  // Repeat to handle multiple chained prefixes: cd ... && export ... && cmd
  let changed = true;
  while (changed) {
    changed = false;
    const m = effective.match(
      /^\s*(?:cd|pushd|popd|export|set|PATH=\S*|source\s+\S+|\.\/?\s+\S+)\s+[^;&|]*?\s*(?:&&|;)\s*([\s\S]*)$/
    );
    if (m) {
      effective = m[1];
      changed = true;
    }
  }

  return effective.trim();
}

function log(entry) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(auditFile(), JSON.stringify(entry) + '\n');
  } catch {}
}

function deny(cmd, reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[차단] ${reason}: ${(cmd || '').slice(0, 80)}`
    }
  });
}

function allow(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `[자동승인] ${reason || ''}`
    }
  });
}

async function main() {
  let raw = '';
  for await (const c of process.stdin) raw += c;

  let data;
  try { data = JSON.parse(raw); } catch { return out('{}'); }

  const tool = data.tool_name || '';
  const ts = new Date().toISOString();

  // ── Write/Edit 민감 파일 보호 ──
  if (tool === 'Write' || tool === 'Edit') {
    const filePath = (data.tool_input && data.tool_input.file_path) || '';
    for (const p of SENSITIVE_PATHS) {
      if (p.test(filePath)) {
        log({ ts, tool, path: filePath, decision: 'deny', reason: 'sensitive_file' });
        return out(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `[차단] 민감 파일 보호: ${path.basename(filePath)}`
          }
        }));
      }
    }
    // 민감하지 않은 파일 → 명시적 허용
    log({ ts, tool, path: filePath, decision: 'allow', reason: 'non_sensitive' });
    return out(allow('비민감 파일'));
  }

  // ── Bash 명령 분석 ──
  if (tool !== 'Bash') return out('{}');

  const cmd = (data.tool_input && data.tool_input.command) || '';

  // 1) 직접 차단 패턴
  for (const p of BLOCK) {
    if (p.test(cmd)) {
      log({ ts, tool: 'Bash', cmd: cmd.slice(0, 500), decision: 'deny', reason: 'destructive' });
      return out(deny(cmd, '위험 명령'));
    }
  }

  // 2) 간접 실행 위험
  for (const p of INDIRECT_DANGER) {
    if (p.test(cmd)) {
      log({ ts, tool: 'Bash', cmd: cmd.slice(0, 500), decision: 'deny', reason: 'indirect_danger' });
      return out(deny(cmd, '간접 위험 실행'));
    }
  }

  // 3) 파이프 체인 우측 분석
  if (cmd.includes('|')) {
    const parts = cmd.split('|').map(s => s.trim());
    for (let i = 1; i < parts.length; i++) {
      for (const p of BLOCK) {
        if (p.test(parts[i])) {
          log({ ts, tool: 'Bash', cmd: cmd.slice(0, 500), decision: 'deny', reason: 'pipe_danger' });
          return out(deny(cmd, '파이프 우측 위험'));
        }
      }
    }
  }

  // 4) 안전 패턴 → 자동 승인
  //    Test against both original command AND the effective command
  //    (with cd/export/pushd prefixes stripped)
  const effective = extractEffectiveCommand(cmd);
  for (const p of SAFE) {
    if (p.test(cmd) || p.test(effective)) {
      log({ ts, tool: 'Bash', cmd: cmd.slice(0, 500), decision: 'allow', reason: 'safe' });
      return out(allow());
    }
  }

  // 5) 미분류 → 경고 로그 + 명시적 허용 (settings.json에서 Bash 허용됨)
  log({ ts, tool: 'Bash', cmd: cmd.slice(0, 500), decision: 'allow', reason: 'unclassified', level: 'warn' });
  out(allow('미분류 (자동허용)'));
}

function out(s) { process.stdout.write(s); }

main().catch(() => out('{}'));
