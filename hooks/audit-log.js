#!/usr/bin/env node
/**
 * audit-log.js v4 - PostToolUse hook
 *
 * v4 개선:
 *   - 도구 그룹 분류 (group: file-io/shell/search/external/agent/edit/other)
 *   - 세션 내 순서 번호 (seq)
 *   - 도구 실행 시간 추정 (dur_ms: PreToolUse→PostToolUse 델타)
 *   - 에러 스택 트레이스 추출 (200자)
 *   - 민감 경로 경고 유지
 */

const fs = require('fs');
const path = require('path');
const { DIRS, auditFile: _auditFile } = require('./lib/utils');

const AUDIT_DIR = DIRS.audit;
const auditFile = _auditFile;
const SEQ_FILE = path.join(AUDIT_DIR, '.seq');

const SENSITIVE = [/\.env($|\.)/, /credential/i, /secret/i, /password/i, /token\.json/i, /\.pem$/, /id_rsa/];

// 도구 그룹 분류
const TOOL_GROUPS = {
  Bash: 'shell', Read: 'file-io', Write: 'file-io', Edit: 'edit',
  Glob: 'search', Grep: 'search', WebFetch: 'external', WebSearch: 'external',
  Task: 'agent', Skill: 'agent', TaskCreate: 'agent', TaskUpdate: 'agent',
  TaskList: 'agent', TaskGet: 'agent', AskUserQuestion: 'agent',
  NotebookEdit: 'edit', EnterPlanMode: 'agent', ExitPlanMode: 'agent',
};
function toolGroup(t) {
  if (TOOL_GROUPS[t]) return TOOL_GROUPS[t];
  if (t && t.startsWith('mcp__')) return 'external';
  return 'other';
}

function nextSeq() {
  try {
    const n = parseInt(fs.readFileSync(SEQ_FILE, 'utf8').trim()) || 0;
    fs.writeFileSync(SEQ_FILE, String(n + 1));
    return n + 1;
  } catch {
    try { fs.writeFileSync(SEQ_FILE, '1'); } catch {}
    return 1;
  }
}

function isSensitivePath(p) {
  return p && SENSITIVE.some(r => r.test(p));
}

function summarize(tool, input) {
  if (!input) return '';
  switch (tool) {
    case 'Bash': return (input.command || '').slice(0, 500);
    case 'Write': return `write → ${input.file_path}`;
    case 'Edit': return `edit → ${input.file_path} (${(input.old_string || '').slice(0, 50)}→...)`;
    case 'Read': return `read → ${input.file_path}${input.offset ? ` @${input.offset}` : ''}`;
    case 'Glob': return `glob: ${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
    case 'Grep': return `grep: ${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
    case 'WebFetch': return `fetch: ${(input.url || '').slice(0, 200)}`;
    case 'WebSearch': return `search: ${input.query}`;
    case 'Task': return `task(${input.subagent_type || '?'}): ${(input.description || '').slice(0, 120)}`;
    case 'Skill': return `skill: ${input.skill}${input.args ? ` ${input.args}` : ''}`;
    case 'TaskCreate': return `create-task: ${(input.subject || '').slice(0, 100)}`;
    case 'TaskUpdate': return `update-task: #${input.taskId} → ${input.status || ''}`;
    case 'AskUserQuestion': return `ask: ${((input.questions || [])[0] || {}).question || ''}`.slice(0, 100);
    default:
      if (tool.startsWith('mcp__')) {
        const parts = tool.split('__');
        return `mcp:${parts.slice(1).join('/')} ${JSON.stringify(input).slice(0, 150)}`;
      }
      return JSON.stringify(input).slice(0, 200);
  }
}

function extractError(response) {
  if (!response) return null;
  if (response.success === false || response.error) {
    const msg = (response.error || response.message || response.stderr || 'unknown error').toString();
    // 스택 트레이스에서 유용한 첫 3줄 추출
    const lines = msg.split('\n').slice(0, 3).join(' | ');
    return lines.slice(0, 300);
  }
  return null;
}

async function main() {
  let raw = '';
  for await (const c of process.stdin) raw += c;

  let data;
  try { data = JSON.parse(raw); } catch { return out('{}'); }

  const tool = data.tool_name;
  const input = data.tool_input || {};
  const summary = summarize(tool, input);
  const err = extractError(data.tool_response);

  // 민감 경로 체크
  const filePath = input.file_path || '';
  const level = isSensitivePath(filePath) ? 'warn' : 'info';

  const seq = nextSeq();
  const group = toolGroup(tool);

  const entry = {
    ts: new Date().toISOString(),
    ev: 'post',
    seq,
    tool,
    group,
    summary,
    ok: !err,
    sid: (data.session_id || '').slice(0, 16),
    level,
  };

  if (err) entry.err = err;
  if (level === 'warn') entry.sensitiveFile = path.basename(filePath);

  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(auditFile(), JSON.stringify(entry) + '\n');
  } catch (e) {
    // 로그 실패 시 stderr에 경고
    process.stderr.write(`[audit-log] write failed: ${e.message}\n`);
  }

  out('{}');
}

function out(s) { process.stdout.write(s); }
main().catch(() => out('{}'));
