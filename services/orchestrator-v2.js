#!/usr/bin/env node
/**
 * orchestrator-v2.js - Agent Teams Orchestrator
 *
 * Extends the DAG orchestrator with Agent Teams support:
 *   - Team Lead distributes tasks and merges results
 *   - Teammates have restricted tool sets per role
 *   - Independent contexts prevent cross-contamination
 *   - --use-teams flag activates team mode
 *
 * Architecture:
 *   Team Lead (orchestrator) → spawns Teammates (subagents)
 *   Each Teammate gets: role, tools, prompt, isolated cwd
 *
 * Usage:
 *   node orchestrator-v2.js <goal> [--use-teams] [--max-parallel N]
 *   node orchestrator-v2.js --status
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { EventEmitter } = require('events');

const HOOKS_DIR = path.join(process.env.HOME, '.claude', 'hooks');
const SERVICES_DIR = path.join(process.env.HOME, '.claude', 'services');
const RUNS_DIR = path.join(process.env.HOME, '.claude', 'orchestration');
const LOGS_DIR = path.join(process.env.HOME, '.claude', 'logs');

fs.mkdirSync(RUNS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

// ── Role Definitions ──

const ROLES = {
  architect: {
    name: 'Architect',
    tools: ['Read', 'Grep', 'Glob'],
    systemPrompt: 'You are a software architect. Analyze code structure, identify patterns, and propose designs. Do NOT modify files.',
    model: 'claude-sonnet-4-6',
  },
  implementer: {
    name: 'Implementer',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
    systemPrompt: 'You are a code implementer. Write clean, tested code following existing patterns. Make minimal changes.',
    model: 'claude-sonnet-4-6',
  },
  tester: {
    name: 'Tester',
    tools: ['Read', 'Write', 'Bash', 'Glob'],
    systemPrompt: 'You are a test engineer. Write comprehensive tests, run them, and report results. Focus on edge cases.',
    model: 'claude-sonnet-4-6',
  },
  reviewer: {
    name: 'Reviewer',
    tools: ['Read', 'Grep', 'Glob'],
    systemPrompt: 'You are a code reviewer. Check for bugs, security issues (OWASP Top 10), and performance problems. Do NOT modify files.',
    model: 'claude-sonnet-4-6',
  },
  security: {
    name: 'Security Analyst',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    systemPrompt: 'You are a security analyst. Scan for vulnerabilities, check dependencies, and identify misconfigurations.',
    model: 'claude-sonnet-4-6',
  },
  docs: {
    name: 'Technical Writer',
    tools: ['Read', 'Write', 'Glob'],
    systemPrompt: 'You are a technical writer. Generate clear, concise documentation from code analysis.',
    model: 'claude-sonnet-4-6',
  },
};

// ── Goal → Team mapping ──

const TEAM_TEMPLATES = {
  'full-feature': {
    description: 'End-to-end feature development',
    members: [
      { role: 'architect', task: 'Analyze codebase and design the implementation plan' },
      { role: 'implementer', task: 'Implement the feature based on the plan', dependsOn: ['architect'] },
      { role: 'tester', task: 'Write and run tests for the implementation', dependsOn: ['implementer'] },
      { role: 'reviewer', task: 'Review all changes for bugs and style', dependsOn: ['implementer'] },
    ],
  },
  'code-review': {
    description: 'Comprehensive multi-perspective review',
    members: [
      { role: 'reviewer', task: 'Review for bugs and logic errors' },
      { role: 'security', task: 'Security vulnerability analysis' },
      { role: 'architect', task: 'Architecture and design review' },
    ],
    parallel: true,
  },
  'refactor': {
    description: 'Safe refactoring with test coverage',
    members: [
      { role: 'tester', task: 'Write tests for existing behavior (baseline)' },
      { role: 'architect', task: 'Design refactoring plan', dependsOn: ['tester'] },
      { role: 'implementer', task: 'Execute refactoring', dependsOn: ['architect'] },
      { role: 'tester', task: 'Run all tests and verify no regressions', dependsOn: ['implementer'] },
    ],
  },
  'security-audit': {
    description: 'Deep security analysis',
    members: [
      { role: 'security', task: 'SAST scan and dependency audit' },
      { role: 'reviewer', task: 'Review authentication and authorization code' },
      { role: 'architect', task: 'Review security architecture and data flow' },
    ],
    parallel: true,
  },
};

// ── Teammate (subprocess wrapper) ──

class Teammate {
  constructor(id, role, task, cwd) {
    this.id = id;
    this.role = ROLES[role] || ROLES.implementer;
    this.roleName = role;
    this.task = task;
    this.cwd = cwd;
    this.status = 'pending';
    this.result = null;
    this.error = null;
    this.startTime = null;
    this.endTime = null;
  }

  async execute(context) {
    this.status = 'running';
    this.startTime = Date.now();

    const toolList = this.role.tools.join(', ');
    const prompt = [
      `[Role: ${this.role.name}]`,
      `CRITICAL: You may ONLY use these tools: ${toolList}. Do NOT use any other tools.`,
      context ? `[Context from previous steps]:\n${context}` : '',
      '',
      `Task: ${this.task}`,
      '',
      'Be concise. Output actionable results only.',
    ].filter(Boolean).join('\n');

    try {
      const args = ['-p', prompt, '--output-format', 'text'];
      // Enforce tool restrictions via --allowedTools if CLI supports it
      if (this.role.tools && this.role.tools.length > 0) {
        args.push('--allowedTools', JSON.stringify(this.role.tools));
      }
      const result = execFileSync('claude', args, {
        encoding: 'utf8',
        timeout: 300_000, // 5 min
        cwd: this.cwd,
        env: { ...process.env, CLAUDE_AGENT_SDK_FALLBACK: '1' },
      });

      this.result = result.trim();
      this.status = 'completed';
      this.endTime = Date.now();
      return this.result;
    } catch (e) {
      this.error = (e.stderr || e.message || 'unknown error').slice(0, 1000);
      this.status = 'failed';
      this.endTime = Date.now();
      throw new Error(`Teammate ${this.id} (${this.role.name}) failed: ${this.error}`);
    }
  }

  get duration() {
    if (!this.startTime) return 0;
    return ((this.endTime || Date.now()) - this.startTime) / 1000;
  }

  toJSON() {
    return {
      id: this.id, role: this.roleName, task: this.task,
      status: this.status, duration: this.duration,
      result: this.result ? this.result.slice(0, 500) : null,
      error: this.error,
    };
  }
}

// ── Team Lead ──

class TeamLead extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.runId = `team-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    this.goal = opts.goal || '';
    this.cwd = opts.cwd || process.cwd();
    this.maxParallel = opts.maxParallel || 3;
    this.teammates = [];
    this.status = 'idle';
    this.startTime = null;
    this.endTime = null;
  }

  // Select team template from goal keywords
  selectTemplate(goal) {
    const g = goal.toLowerCase();
    if (/security|보안|취약점|audit/.test(g)) return 'security-audit';
    if (/review|리뷰|검토/.test(g)) return 'code-review';
    if (/refactor|리팩토링|기술\s*부채/.test(g)) return 'refactor';
    return 'full-feature'; // default
  }

  // Build team from template
  buildTeam(templateName, goalContext) {
    const template = TEAM_TEMPLATES[templateName];
    if (!template) throw new Error(`Unknown template: ${templateName}`);

    this.teammates = template.members.map((m, i) => {
      const task = `${m.task}. Goal: ${goalContext}`;
      return {
        teammate: new Teammate(`${this.runId}-${i}`, m.role, task, this.cwd),
        dependsOn: (m.dependsOn || []).map(dep => {
          const depIdx = template.members.findIndex(tm => tm.role === dep);
          return depIdx >= 0 ? `${this.runId}-${depIdx}` : null;
        }).filter(Boolean),
        parallel: template.parallel || false,
      };
    });

    this.emit('team-built', {
      runId: this.runId,
      template: templateName,
      members: this.teammates.map(t => t.teammate.toJSON()),
    });
  }

  // Execute team with DAG ordering
  async execute() {
    this.status = 'running';
    this.startTime = Date.now();
    const results = new Map();
    const completed = new Set();

    this.emit('execution-start', { runId: this.runId });

    let iteration = 0;
    const maxIterations = this.teammates.length * 3;

    while (completed.size < this.teammates.length && iteration++ < maxIterations) {
      // Find ready teammates (dependencies satisfied)
      const ready = this.teammates.filter(t =>
        t.teammate.status === 'pending' &&
        t.dependsOn.every(dep => completed.has(dep))
      );

      if (ready.length === 0 && completed.size < this.teammates.length) {
        // Deadlock detection
        const pending = this.teammates.filter(t => t.teammate.status === 'pending');
        if (pending.length > 0) {
          log('error', `[${this.runId}] Deadlock: ${pending.length} teammates waiting`);
          break;
        }
        break;
      }

      // Execute ready teammates (parallel up to maxParallel)
      const batch = ready.slice(0, this.maxParallel);

      // Build context from completed dependencies
      const promises = batch.map(t => {
        const depContext = t.dependsOn
          .map(dep => results.get(dep))
          .filter(Boolean)
          .join('\n---\n');

        log('info', `[${this.runId}] Starting ${t.teammate.role.name}: ${t.teammate.task.slice(0, 80)}`);
        this.emit('teammate-start', t.teammate.toJSON());

        return t.teammate.execute(depContext)
          .then(result => {
            results.set(t.teammate.id, result);
            completed.add(t.teammate.id);
            log('info', `[${this.runId}] Completed ${t.teammate.role.name} (${t.teammate.duration.toFixed(1)}s)`);
            this.emit('teammate-done', t.teammate.toJSON());
          })
          .catch(err => {
            completed.add(t.teammate.id); // Mark done even on failure
            log('error', `[${this.runId}] Failed ${t.teammate.role.name}: ${err.message}`);
            this.emit('teammate-failed', { ...t.teammate.toJSON(), error: err.message });
          });
      });

      // If template says parallel, run all at once; else sequential
      if (batch.length > 1 && batch[0].parallel) {
        await Promise.all(promises);
      } else {
        for (const p of promises) await p;
      }
    }

    this.endTime = Date.now();
    this.status = this.teammates.every(t => t.teammate.status === 'completed') ? 'completed' : 'partial';

    return this.buildReport(results);
  }

  buildReport(results) {
    const report = {
      runId: this.runId,
      goal: this.goal,
      status: this.status,
      durationSec: ((this.endTime - this.startTime) / 1000).toFixed(1),
      teammates: this.teammates.map(t => t.teammate.toJSON()),
      summary: null,
    };

    // Merge results into summary
    const summaryParts = [];
    for (const t of this.teammates) {
      if (t.teammate.result) {
        summaryParts.push(`## ${t.teammate.role.name}\n${t.teammate.result.slice(0, 1000)}`);
      }
    }
    report.summary = summaryParts.join('\n\n---\n\n');

    // Save to disk
    try {
      const runFile = path.join(RUNS_DIR, `${this.runId}.json`);
      fs.writeFileSync(runFile, JSON.stringify(report, null, 2));
    } catch {}

    this.emit('execution-done', report);
    return report;
  }
}

// ── CLI ──

function log(level, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = { info: '[INFO]', warn: '[WARN]', error: '[ERR]' }[level] || '[???]';
  console.error(`${ts} ${prefix} ${msg}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    try {
      const runs = fs.readdirSync(RUNS_DIR)
        .filter(f => f.startsWith('team-') && f.endsWith('.json'))
        .sort().reverse().slice(0, 5);
      for (const f of runs) {
        const run = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
        console.log(`${run.runId} | ${run.status} | ${run.durationSec}s | ${run.goal.slice(0, 60)}`);
      }
      if (runs.length === 0) console.log('No team runs found.');
    } catch (e) {
      console.log(`Error: ${e.message}`);
    }
    return;
  }

  if (args.includes('--list-templates')) {
    for (const [name, tmpl] of Object.entries(TEAM_TEMPLATES)) {
      console.log(`${name}: ${tmpl.description} (${tmpl.members.length} members)`);
    }
    return;
  }

  const goal = args.filter(a => !a.startsWith('--')).join(' ');
  if (!goal) {
    console.log('Usage: node orchestrator-v2.js <goal> [--use-teams] [--max-parallel N]');
    console.log('       node orchestrator-v2.js --status');
    console.log('       node orchestrator-v2.js --list-templates');
    process.exit(1);
  }

  const maxParallelIdx = args.indexOf('--max-parallel');
  const maxParallel = maxParallelIdx >= 0 ? parseInt(args[maxParallelIdx + 1]) || 3 : 3;

  const lead = new TeamLead({ goal, cwd: process.cwd(), maxParallel });

  // Event logging
  lead.on('team-built', d => log('info', `Team: ${d.members.length} members`));
  lead.on('teammate-start', d => log('info', `→ ${d.role}: ${d.task.slice(0, 60)}`));
  lead.on('teammate-done', d => log('info', `✓ ${d.role} (${d.duration.toFixed(1)}s)`));
  lead.on('teammate-failed', d => log('error', `✗ ${d.role}: ${d.error}`));

  // Select and build team
  const templateName = lead.selectTemplate(goal);
  log('info', `Template: ${templateName}`);
  lead.buildTeam(templateName, goal);

  // Execute
  const report = await lead.execute();

  console.log('\n' + '═'.repeat(60));
  console.log(`Team Run: ${report.runId}`);
  console.log(`Status: ${report.status} | Duration: ${report.durationSec}s`);
  console.log('═'.repeat(60));

  for (const t of report.teammates) {
    const icon = t.status === 'completed' ? '✓' : '✗';
    console.log(`  ${icon} ${t.role} (${t.duration.toFixed(1)}s) — ${t.task.slice(0, 50)}`);
  }

  if (report.summary) {
    console.log('\n' + '─'.repeat(60));
    console.log(report.summary.slice(0, 2000));
  }

  process.exit(report.status === 'completed' ? 0 : 1);
}

// ── Exports ──

module.exports = { TeamLead, Teammate, ROLES, TEAM_TEMPLATES };

if (require.main === module) {
  main().catch(e => {
    console.error(`Fatal: ${e.message}`);
    process.exit(1);
  });
}
