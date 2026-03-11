#!/usr/bin/env node
/**
 * quality-gate.js - Pre-commit Quality Gate
 *
 * Counters the 1.7x issue rate of AI-generated code by running
 * automated checks before allowing session completion.
 *
 * Checks:
 *   1. Lint errors (ESLint/TSC/Ruff based on file type)
 *   2. Diff size warning (>500 lines → recommend split)
 *   3. Sensitive file detection (.env, credentials)
 *   4. Uncommitted changes warning
 *
 * Integration: Called by stop-check.js at session end.
 * Expected: Issue rate 1.7x → ~1.0x
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { AUDIT_DIR, TEMP_DIR } = require('./lib/paths');
const { localDate, appendJsonl, auditFilePath } = require('./lib/utils');

const SENSITIVE_PATTERNS = [
  /\.env($|\.)/,
  /credential/i,
  /secret/i,
  /password/i,
  /\.pem$/,
  /id_rsa/,
  /token\.json/i,
  /\.key$/,
];

// ── File detection ──

function getChangedFiles() {
  try {
    const staged = execSync('git diff --cached --name-only', {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    const unstaged = execSync('git diff --name-only', {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const files = new Set();
    if (staged) staged.split('\n').forEach(f => files.add(f));
    if (unstaged) unstaged.split('\n').forEach(f => files.add(f));
    return [...files].filter(Boolean);
  } catch {
    return [];
  }
}

function getDiffStat() {
  try {
    const stat = execSync('git diff --stat HEAD 2>/dev/null || git diff --stat', {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    // Parse last line: " X files changed, Y insertions(+), Z deletions(-)"
    const match = stat.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (match) {
      return {
        files: parseInt(match[1]) || 0,
        additions: parseInt(match[2]) || 0,
        deletions: parseInt(match[3]) || 0,
        raw: stat,
      };
    }
    return { files: 0, additions: 0, deletions: 0, raw: stat };
  } catch {
    return { files: 0, additions: 0, deletions: 0, raw: '' };
  }
}

// ── Linter runners ──

function hasCommand(cmd) {
  try {
    execSync(`which ${cmd} 2>/dev/null || command -v ${cmd} 2>/dev/null`, {
      encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe']
    });
    return true;
  } catch {
    return false;
  }
}

function runLinter(cmd, files) {
  try {
    execSync(`${cmd} ${files.join(' ')}`, {
      encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe']
    });
    return { ok: true, errors: 0, output: '' };
  } catch (e) {
    const output = (e.stdout || '') + (e.stderr || '');
    // Count error lines (rough estimate)
    const errorLines = output.split('\n').filter(l =>
      /error|Error|ERROR/.test(l) && !/warning|Warning/.test(l)
    ).length;
    return { ok: false, errors: Math.max(1, errorLines), output: output.slice(0, 500) };
  }
}

// ── Main quality checks ──

function runQualityChecks() {
  const changedFiles = getChangedFiles();
  const diffStat = getDiffStat();
  const issues = [];
  const warnings = [];
  const suggestions = [];

  if (changedFiles.length === 0) {
    return { issues, warnings, suggestions, verdict: 'clean', changedFiles: 0 };
  }

  // 1. Categorize changed files by type
  const jsFiles = changedFiles.filter(f => /\.(js|jsx|mjs|cjs)$/.test(f));
  const tsFiles = changedFiles.filter(f => /\.(ts|tsx)$/.test(f));
  const pyFiles = changedFiles.filter(f => /\.py$/.test(f));

  // 2. Run available linters
  if (jsFiles.length > 0 || tsFiles.length > 0) {
    const allJsTs = [...jsFiles, ...tsFiles];
    if (hasCommand('npx')) {
      // Try ESLint if available
      const eslintResult = runLinter('npx eslint --no-eslintrc --no-error-on-unmatched-pattern --quiet 2>/dev/null', allJsTs);
      if (!eslintResult.ok && eslintResult.errors > 0) {
        issues.push(`ESLint: ${eslintResult.errors}개 에러`);
      }
    }
    if (tsFiles.length > 0 && hasCommand('npx')) {
      const tscResult = runLinter('npx tsc --noEmit --pretty false 2>/dev/null', []);
      if (!tscResult.ok) {
        warnings.push(`TypeScript: 타입 에러 발견`);
      }
    }
  }

  if (pyFiles.length > 0) {
    if (hasCommand('ruff')) {
      const ruffResult = runLinter('ruff check', pyFiles);
      if (!ruffResult.ok) {
        issues.push(`Ruff: ${ruffResult.errors}개 에러`);
      }
    } else if (hasCommand('flake8')) {
      const flake8Result = runLinter('flake8 --count --select=E,F --max-line-length=120', pyFiles);
      if (!flake8Result.ok) {
        issues.push(`Flake8: ${flake8Result.errors}개 에러`);
      }
    }
  }

  // 3. Diff size check
  const totalChanges = diffStat.additions + diffStat.deletions;
  if (totalChanges > 500) {
    warnings.push(`변경 ${totalChanges}줄 (${diffStat.additions}+ / ${diffStat.deletions}-). PR 분할을 권장합니다.`);
  } else if (totalChanges > 300) {
    suggestions.push(`변경 ${totalChanges}줄. 적절한 크기이지만 리뷰어를 위해 설명 추가를 권장합니다.`);
  }

  // 4. Sensitive file check
  const sensitiveFiles = changedFiles.filter(f =>
    SENSITIVE_PATTERNS.some(p => p.test(f))
  );
  if (sensitiveFiles.length > 0) {
    issues.push(`민감 파일 변경 감지: ${sensitiveFiles.join(', ')}`);
  }

  // 5. Uncommitted changes check
  try {
    const status = execSync('git status --porcelain', {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    if (status) {
      const untracked = status.split('\n').filter(l => l.startsWith('??')).length;
      const modified = status.split('\n').filter(l => l.startsWith(' M') || l.startsWith('M ')).length;
      if (modified > 0 || untracked > 0) {
        suggestions.push(`미커밋: 수정 ${modified}개, 미추적 ${untracked}개`);
      }
    }
  } catch {}

  // Determine verdict
  let verdict = 'pass';
  if (issues.length > 0) verdict = 'fail';
  else if (warnings.length > 0) verdict = 'pass_with_warnings';

  return {
    issues,
    warnings,
    suggestions,
    verdict,
    changedFiles: changedFiles.length,
    diffStat,
  };
}

/**
 * Run quality checks and record results to audit log
 */
function runAndRecord() {
  const result = runQualityChecks();

  // Record to audit log
  try {
    appendJsonl(auditFilePath(), {
      ts: new Date().toISOString(),
      ev: 'quality-gate',
      verdict: result.verdict,
      files_changed: result.changedFiles,
      issues: result.issues.length,
      warnings: result.warnings.length,
      diff_lines: result.diffStat ? (result.diffStat.additions + result.diffStat.deletions) : 0,
    });
  } catch {}

  return result;
}

/**
 * Format quality gate results for display
 */
function formatResults(result) {
  const lines = [];

  if (result.verdict === 'clean') {
    return null; // No changes, nothing to report
  }

  const icon = result.verdict === 'pass' ? '✅' :
               result.verdict === 'pass_with_warnings' ? '⚠️' : '❌';
  lines.push(`${icon} 품질 게이트: ${result.verdict.toUpperCase()}`);

  for (const issue of result.issues) {
    lines.push(`  ❌ ${issue}`);
  }
  for (const warning of result.warnings) {
    lines.push(`  ⚠️ ${warning}`);
  }
  for (const suggestion of result.suggestions) {
    lines.push(`  💡 ${suggestion}`);
  }

  return lines.join('\n');
}

// ── CLI mode ──

if (require.main === module) {
  const result = runAndRecord();
  const formatted = formatResults(result);
  if (formatted) {
    console.log(formatted);
  } else {
    console.log('변경 사항 없음.');
  }
  process.exit(result.verdict === 'fail' ? 1 : 0);
}

module.exports = {
  runQualityChecks,
  runAndRecord,
  formatResults,
  getChangedFiles,
  getDiffStat,
};
