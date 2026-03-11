#!/usr/bin/env node
/**
 * orchestrator.js - Autonomous Orchestration Engine (OpenClaw-grade)
 *
 * Architecture:
 *   EventEmitter-based event-driven core
 *   FSM lifecycle: IDLE → PLANNING → EXECUTING → RECOVERING → DONE/FAILED
 *   Middleware pipeline: collect → decompose → route → execute → report
 *   DAG checkpoint for crash-safe recovery
 *   Plugin-style skill loading from ~/.claude/commands/
 *
 * CLI:
 *   node orchestrator.js <goal> [projectPath]      Run orchestration
 *   node orchestrator.js --resume <runId>           Resume from checkpoint
 *   node orchestrator.js --status [runId]           Show run status
 *   node orchestrator.js --list                     List recent runs
 *   node orchestrator.js --abort <runId>            Abort a run
 *
 * Integration:
 *   - relay-supabase.js: /orchestrate command handler
 *   - heartbeat.js: scheduled orchestration
 *   - claude -p: headless execution engine
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execSync, spawn } = require('child_process');
const { HOOKS_DIR, COMMANDS_DIR, ORCH_DIR, LOGS_DIR } = require('../hooks/lib/paths');
const { localDate } = require('../hooks/lib/utils');

const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const ENGINE = path.join(HOOKS_DIR, 'agent-engine.js');
const SKILLS_DIR = COMMANDS_DIR;
const RUNS_DIR = ORCH_DIR;

fs.mkdirSync(RUNS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

// ── FSM States ──
const STATE = {
  IDLE: 'idle',
  COLLECTING: 'collecting',
  DECOMPOSING: 'decomposing',
  ROUTING: 'routing',
  EXECUTING: 'executing',
  RECOVERING: 'recovering',
  DONE: 'done',
  FAILED: 'failed',
  ABORTED: 'aborted',
};

// ── Skill Map (auto-loaded from commands/) ──
function loadSkillMap() {
  const map = {};
  const aliases = {
    'build': ['deploy', 'w-feature-dev'],
    'test': ['w-tdd-cycle'],
    'lint': ['fix-all'],
    'review': ['review', 'w-full-review'],
    'debug': ['t-smart-debug', 't-error-analysis'],
    'security': ['t-security-scan'],
    'refactor': ['t-refactor', 't-tech-debt'],
    'docs': ['t-doc-generate'],
    'deps': ['t-deps-audit', 't-deps-upgrade'],
    'deploy': ['deploy'],
    'perf': ['w-perf-optimize'],
    'migrate': ['code-migrate', 'legacy-modernize'],
    'scaffold': ['api-scaffold', 'new-project'],
    'git': ['w-git'],
    'docker': ['docker-optimize'],
    'incident': ['incident-response'],
  };

  try {
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const name = f.replace('.md', '');
      map[name] = { file: path.join(SKILLS_DIR, f), name };
    }
  } catch {}

  return { skills: map, aliases };
}

// ── Orchestrator Core (EventEmitter + FSM) ──
class Orchestrator extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.state = STATE.IDLE;
    this.runId = opts.runId || `run-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    this.goal = opts.goal || '';
    this.projectPath = opts.projectPath || process.cwd();
    this.dag = [];
    this.completed = new Set();
    this.results = {};
    this.errors = [];
    this.startTime = null;
    this.maxRetries = opts.maxRetries || 2;
    this.stepTimeout = opts.stepTimeout || 300_000;  // 5 min per step (claude -p needs headroom)
    this.maxSteps = opts.maxSteps || 20;
    this.skillMap = loadSkillMap();

    // Middleware pipeline
    this.pipeline = [
      this._collect.bind(this),
      this._decompose.bind(this),
      this._route.bind(this),
      this._execute.bind(this),
      this._report.bind(this),
    ];
  }

  // ── State Machine ──
  transition(newState) {
    const prev = this.state;
    this.state = newState;
    this.emit('state-change', { from: prev, to: newState, runId: this.runId });
    this._checkpoint();
  }

  // ── Main Entry Point ──
  async run(goal, projectPath) {
    this.goal = goal || this.goal;
    this.projectPath = projectPath || this.projectPath;
    this.startTime = Date.now();

    this.emit('run-start', { runId: this.runId, goal: this.goal, project: this.projectPath });
    log('info', `[${this.runId}] Starting: "${this.goal}"`);

    try {
      // Execute middleware pipeline sequentially
      for (const middleware of this.pipeline) {
        if (this.state === STATE.ABORTED || this.state === STATE.FAILED) break;
        await middleware();
      }
    } catch (e) {
      this.transition(STATE.FAILED);
      this.errors.push({ phase: this.state, error: e.message });
      this.emit('run-error', { runId: this.runId, error: e.message });
      log('error', `[${this.runId}] Fatal: ${e.message}`);
    }

    const result = this._buildResult();
    this.emit('run-end', result);
    log('info', `[${this.runId}] Finished: ${result.status} (${result.durationSec}s)`);
    return result;
  }

  // ── Phase 1: Collect (gather project context) ──
  async _collect() {
    this.transition(STATE.COLLECTING);

    const ctx = { goal: this.goal, project: this.projectPath };

    // Collect project info
    try {
      const pkgPath = path.join(this.projectPath, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        ctx.name = pkg.name;
        ctx.scripts = Object.keys(pkg.scripts || {});
        ctx.deps = Object.keys(pkg.dependencies || {}).length;
        ctx.devDeps = Object.keys(pkg.devDependencies || {}).length;
      }
    } catch {}

    // Collect directory structure (top-level only)
    try {
      ctx.files = fs.readdirSync(this.projectPath).filter(f => !f.startsWith('.')).slice(0, 30);
    } catch {}

    // Check git status
    try {
      ctx.gitBranch = execSync('git branch --show-current', {
        cwd: this.projectPath, encoding: 'utf8', timeout: 5000
      }).trim();
    } catch {}

    this.context = ctx;
    this.emit('context-collected', ctx);
    return ctx;
  }

  // ── Phase 2: Decompose (goal → DAG, rule-based + claude -p fallback) ──
  async _decompose() {
    this.transition(STATE.DECOMPOSING);

    // ── Rule-based decomposition (fast, no API call) ──
    const steps = this._ruleDecompose(this.goal);

    if (steps.length > 0) {
      this.dag = steps;
      this.emit('dag-created', { runId: this.runId, steps: this.dag.length, dag: this.dag });
      log('info', `[${this.runId}] DAG (rule-based): ${this.dag.length} steps`);
      return this.dag;
    }

    // ── Fallback: single claude -p step for complex goals ──
    log('info', `[${this.runId}] No rule match, using claude executor for: "${this.goal}"`);
    this.dag = [{
      id: 'step-1',
      name: this.goal,
      type: 'claude',
      command: null,
      dependsOn: [],
      parallel: false,
      context: '',
      status: 'pending',
      retries: 0,
    }];
    this.emit('dag-created', { runId: this.runId, steps: 1, dag: this.dag });
    return this.dag;
  }

  // ── Rule-based goal decomposer ──
  _ruleDecompose(goal) {
    const steps = [];
    let stepNum = 0;
    const mkStep = (name, type, command = null, deps = [], parallel = false) => {
      stepNum++;
      return {
        id: `step-${stepNum}`, name, type, command,
        dependsOn: deps, parallel, context: '', status: 'pending', retries: 0,
      };
    };

    // Keyword patterns → type mapping (no \b for Korean compatibility)
    const PATTERNS = [
      { re: /(npm\s+install|yarn\s+install|pnpm\s+install|의존성\s*설치)/i, type: 'shell', cmd: 'npm install', name: 'Install dependencies' },
      { re: /(npm\s+run\s+build|빌드|build)/i, type: 'build', name: 'Build project' },
      { re: /(npm\s+test|테스트|test)/i, type: 'test', name: 'Run tests' },
      { re: /(lint|린트|eslint)/i, type: 'lint', name: 'Lint & fix' },
      { re: /(리뷰|review|코드\s*리뷰)/i, type: 'review', name: 'Code review' },
      { re: /(디버그|debug|에러\s*분석)/i, type: 'debug', name: 'Debug' },
      { re: /(보안|security|취약점)/i, type: 'security', name: 'Security scan' },
      { re: /(리팩토링|refactor|기술\s*부채)/i, type: 'refactor', name: 'Refactor' },
      { re: /(문서|docs|doc\s*generate)/i, type: 'docs', name: 'Generate docs' },
      { re: /(의존성\s*감사|deps?\s*audit|의존성\s*업그레이드)/i, type: 'deps', name: 'Deps audit' },
      { re: /(배포|deploy)/i, type: 'deploy', name: 'Deploy' },
      { re: /(성능|perf|optimize|최적화)/i, type: 'perf', name: 'Performance optimize' },
      { re: /(마이그레이션|migrate|이전)/i, type: 'migrate', name: 'Migrate' },
      { re: /(docker|도커|컨테이너)/i, type: 'docker', name: 'Docker optimize' },
    ];

    // Match explicit shell commands (e.g. "npm install && npm test")
    const shellCmdMatch = goal.match(/^((?:(?:npm|node|npx|yarn|pnpm|git|python|pip)\s+\S+)(?:\s*&&\s*(?:npm|node|npx|yarn|pnpm|git|python|pip)\s+\S+)*)$/);
    if (shellCmdMatch) {
      const cmds = shellCmdMatch[1].split(/\s*&&\s*/);
      let prevId = null;
      for (const cmd of cmds) {
        const s = mkStep(cmd, 'shell', cmd.trim(), prevId ? [prevId] : []);
        steps.push(s);
        prevId = s.id;
      }
      return steps;
    }

    // Split goal by Korean connectors: 후, 하고, 그리고, +, &&
    const segments = goal.split(/\s*(?:후|하고|그리고|&{1,2}|\+|→|->)\s*/i).filter(Boolean);

    if (segments.length > 1) {
      // Multiple segments → sequential by default, parallel if independent
      let prevId = null;
      for (const seg of segments) {
        const matched = PATTERNS.find(p => p.re.test(seg));
        if (matched) {
          const s = mkStep(matched.name, matched.type, matched.cmd || null, prevId ? [prevId] : []);
          steps.push(s);
          prevId = s.id;
        } else {
          // Unknown segment → claude executor
          const s = mkStep(seg.trim(), 'claude', null, prevId ? [prevId] : []);
          steps.push(s);
          prevId = s.id;
        }
      }

      // Mark independent types as parallel (deps-free siblings)
      const parallelTypes = new Set(['test', 'lint', 'security', 'review', 'docs']);
      const groups = {};
      for (const s of steps) {
        const dep = s.dependsOn[0];
        if (!groups[dep]) groups[dep] = [];
        groups[dep].push(s);
      }
      for (const siblings of Object.values(groups)) {
        if (siblings.length > 1 && siblings.every(s => parallelTypes.has(s.type))) {
          for (const s of siblings) s.parallel = true;
        }
      }

      return steps;
    }

    // Single segment → check if it matches a pattern
    const matched = PATTERNS.find(p => p.re.test(goal));
    if (matched) {
      steps.push(mkStep(matched.name, matched.type, matched.cmd || null));
      return steps;
    }

    // No match → return empty (will use claude -p fallback)
    return [];
  }

  // ── Phase 3: Route (map steps to skills/commands) ──
  async _route() {
    this.transition(STATE.ROUTING);

    for (const step of this.dag) {
      if (step.type === 'shell' && step.command) {
        step.executor = 'shell';
        continue;
      }

      // Find matching skill via aliases
      const aliases = this.skillMap.aliases[step.type];
      if (aliases && aliases.length > 0) {
        const skillName = aliases[0]; // Primary skill
        if (this.skillMap.skills[skillName]) {
          step.executor = 'skill';
          step.skill = skillName;
          continue;
        }
      }

      // Fallback: use claude -p with context
      step.executor = 'claude';
    }

    this.emit('routes-assigned', { runId: this.runId, dag: this.dag });
    return this.dag;
  }

  // ── Phase 4: Execute (DAG topological execution) ──
  async _execute() {
    this.transition(STATE.EXECUTING);

    let iteration = 0;
    const maxIterations = this.dag.length * 3; // Safety limit

    while (this.completed.size < this.dag.length && iteration++ < maxIterations) {
      if (this.state === STATE.ABORTED) break;

      // Find ready steps (all dependencies met)
      const ready = this.dag.filter(s =>
        s.status === 'pending' &&
        s.dependsOn.every(d => this.completed.has(d))
      );

      if (ready.length === 0) {
        // Check for deadlock or all done
        const pending = this.dag.filter(s => s.status === 'pending');
        if (pending.length > 0) {
          log('warn', `[${this.runId}] Deadlock: ${pending.length} steps blocked`);
          this.errors.push({ phase: 'execute', error: 'DAG deadlock detected' });
          this.transition(STATE.FAILED);
          return;
        }
        break; // All done
      }

      // Split into parallel and serial groups
      const parallelBatch = ready.filter(s => s.parallel);
      const serialBatch = ready.filter(s => !s.parallel);

      // Execute parallel batch concurrently
      if (parallelBatch.length > 0) {
        const promises = parallelBatch.map(s => this._executeStep(s));
        const results = await Promise.allSettled(promises);

        for (let i = 0; i < parallelBatch.length; i++) {
          const step = parallelBatch[i];
          const result = results[i];
          if (result.status === 'fulfilled' && result.value.success) {
            step.status = 'completed';
            this.completed.add(step.id);
            this.results[step.id] = result.value;
          } else {
            const recovered = await this._recover(step, result.reason || result.value?.error);
            if (!recovered) {
              step.status = 'failed';
              this.results[step.id] = { success: false, error: result.reason?.message || 'unknown' };
            }
          }
        }
      }

      // Execute serial steps one by one
      for (const step of serialBatch) {
        if (this.state === STATE.ABORTED) break;
        const result = await this._executeStep(step);
        if (result.success) {
          step.status = 'completed';
          this.completed.add(step.id);
          this.results[step.id] = result;
        } else {
          const recovered = await this._recover(step, result.error);
          if (!recovered) {
            step.status = 'failed';
            this.results[step.id] = result;
            // Non-blocking: continue with other steps
          }
        }
      }

      // Checkpoint after each iteration
      this._checkpoint();
      this.emit('progress', {
        runId: this.runId,
        done: this.completed.size,
        total: this.dag.length,
        iteration,
      });
    }

    // Determine final state
    const failedSteps = this.dag.filter(s => s.status === 'failed');
    if (failedSteps.length === 0) {
      this.transition(STATE.DONE);
    } else if (this.completed.size > 0) {
      this.transition(STATE.DONE); // Partial success
    } else {
      this.transition(STATE.FAILED);
    }
  }

  // ── Execute Single Step ──
  async _executeStep(step) {
    step.status = 'running';
    step.startedAt = new Date().toISOString();
    this.emit('step-start', { runId: this.runId, step: step.id, name: step.name, executor: step.executor });
    log('info', `[${this.runId}] Step ${step.id}: ${step.name} (${step.executor})`);

    try {
      let output;

      switch (step.executor) {
        case 'shell':
          output = this._execShell(step.command);
          break;

        case 'skill':
          output = this._execSkill(step.skill, step);
          break;

        case 'claude':
        default:
          output = this._execClaude(step);
          break;
      }

      step.completedAt = new Date().toISOString();
      this.emit('step-done', { runId: this.runId, step: step.id, success: true });
      return { success: true, output: String(output).slice(0, 3000) };

    } catch (e) {
      step.completedAt = new Date().toISOString();
      const error = e.message || String(e);
      this.emit('step-done', { runId: this.runId, step: step.id, success: false, error });
      log('warn', `[${this.runId}] Step ${step.id} failed: ${error.slice(0, 200)}`);
      return { success: false, error };
    }
  }

  // ── Executors ──

  _execShell(command) {
    return execSync(command, {
      encoding: 'utf8',
      timeout: this.stepTimeout,
      cwd: this.projectPath,
      env: { ...process.env, ORCHESTRATOR: '1' },
      maxBuffer: 1024 * 1024 * 5, // 5MB
    });
  }

  _execSkill(skillName, step) {
    const prompt = `/${skillName} ${step.context || step.name}`;
    return this._claudeP(prompt, this.projectPath);
  }

  _execClaude(step) {
    const prompt = `${step.name}${step.context ? '\n\nContext: ' + step.context : ''}`;
    return this._claudeP(prompt, this.projectPath);
  }

  /**
   * Execute via claude -p.
   * @param {string} prompt
   * @param {string} [cwd]
   * @param {object} [opts] - { maxTurns, noTools }
   */
  _claudeP(prompt, cwd, opts = {}) {
    const env = { ...process.env, ORCHESTRATOR: '1' };
    delete env.CLAUDECODE;
    if (opts.decompose) env.ORCH_DECOMPOSE = '1';

    const tmpFile = path.join(RUNS_DIR, `prompt-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, prompt);
    const tmpPath = tmpFile.replace(/\\/g, '/');

    const maxTurns = opts.maxTurns || 10;
    let cmd = `claude -p "$(cat '${tmpPath}')" --max-turns ${maxTurns}`;

    // No-tools mode: force text-only response (for decompose/planning)
    if (opts.noTools) {
      cmd += ` --allowedTools '[]'`;
    }

    try {
      const result = execSync(cmd, {
        encoding: 'utf8',
        timeout: this.stepTimeout,
        cwd: cwd || this.projectPath,
        env,
        maxBuffer: 1024 * 1024 * 10,
      });
      return result || '';
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  // ── Phase 5: Recovery (2-tier: retry → escalate) ──
  async _recover(step, error) {
    if (step.retries >= this.maxRetries) {
      log('warn', `[${this.runId}] Step ${step.id}: max retries reached`);
      this.errors.push({ step: step.id, error: String(error), retries: step.retries });
      return false;
    }

    this.transition(STATE.RECOVERING);
    step.retries++;
    log('info', `[${this.runId}] Retry ${step.retries}/${this.maxRetries}: ${step.id}`);

    // Exponential backoff
    await delay(1000 * Math.pow(2, step.retries - 1));

    const result = await this._executeStep(step);
    if (result.success) {
      step.status = 'completed';
      this.completed.add(step.id);
      this.results[step.id] = result;
      this.transition(STATE.EXECUTING);
      return true;
    }

    this.errors.push({ step: step.id, error: String(error), retries: step.retries });
    this.transition(STATE.EXECUTING);
    return false;
  }

  // ── Phase 6: Report ──
  async _report() {
    const result = this._buildResult();

    // Save to agent-engine checkpoint
    try {
      execSync(`node "${ENGINE}" checkpoint "${result.status}: ${this.goal.slice(0, 60)}"`, {
        encoding: 'utf8', timeout: 5000,
      });
    } catch {}

    // Write run log
    const logFile = path.join(LOGS_DIR, `orch-${this.runId}.md`);
    const md = this._buildMarkdown(result);
    fs.writeFileSync(logFile, md);

    this.emit('report', result);
    return result;
  }

  // ── Checkpoint (crash-safe) ──
  _checkpoint() {
    const file = path.join(RUNS_DIR, `${this.runId}.json`);
    const data = {
      runId: this.runId,
      goal: this.goal,
      projectPath: this.projectPath,
      state: this.state,
      dag: this.dag,
      completed: [...this.completed],
      results: this.results,
      errors: this.errors,
      startTime: this.startTime,
      updatedAt: new Date().toISOString(),
      maxRetries: this.maxRetries,
      stepTimeout: this.stepTimeout,
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  // ── Resume from Checkpoint ──
  static resume(runId) {
    const file = path.join(RUNS_DIR, `${runId}.json`);
    if (!fs.existsSync(file)) throw new Error(`Run not found: ${runId}`);

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const orch = new Orchestrator({
      runId: data.runId,
      goal: data.goal,
      projectPath: data.projectPath,
      maxRetries: data.maxRetries,
      stepTimeout: data.stepTimeout,
    });

    orch.dag = data.dag;
    orch.completed = new Set(data.completed);
    orch.results = data.results || {};
    orch.errors = data.errors || [];
    orch.startTime = data.startTime;

    // Reset failed/running steps to pending for re-execution
    for (const step of orch.dag) {
      if (step.status === 'running' || step.status === 'failed') {
        step.status = 'pending';
        step.retries = 0;
      }
    }

    log('info', `[${runId}] Resuming: ${orch.completed.size}/${orch.dag.length} completed`);
    return orch;
  }

  // ── Abort ──
  abort() {
    this.transition(STATE.ABORTED);
    log('info', `[${this.runId}] Aborted`);
  }

  // ── Build Result Object ──
  _buildResult() {
    const elapsed = this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0;
    const total = this.dag.length;
    const done = this.completed.size;
    const failed = this.dag.filter(s => s.status === 'failed').length;

    return {
      runId: this.runId,
      goal: this.goal,
      project: this.projectPath,
      status: this.state,
      steps: { total, completed: done, failed, pending: total - done - failed },
      durationSec: elapsed,
      errors: this.errors,
      dag: this.dag.map(s => ({
        id: s.id, name: s.name, type: s.type, status: s.status,
        executor: s.executor, retries: s.retries,
      })),
    };
  }

  // ── Build Markdown Report ──
  _buildMarkdown(result) {
    const lines = [
      `# Orchestration Run: ${result.runId}`,
      `- **Goal:** ${result.goal}`,
      `- **Project:** ${result.project}`,
      `- **Status:** ${result.status}`,
      `- **Duration:** ${result.durationSec}s`,
      `- **Steps:** ${result.steps.completed}/${result.steps.total} completed, ${result.steps.failed} failed`,
      '',
      '## Steps',
    ];

    for (const s of result.dag) {
      const icon = s.status === 'completed' ? '[OK]' : s.status === 'failed' ? '[FAIL]' : '[--]';
      lines.push(`- ${icon} **${s.id}**: ${s.name} (${s.type}→${s.executor}) retries:${s.retries}`);
    }

    if (result.errors.length > 0) {
      lines.push('', '## Errors');
      for (const e of result.errors) {
        lines.push(`- ${e.step || e.phase}: ${String(e.error).slice(0, 200)}`);
      }
    }

    lines.push('', `Generated: ${new Date().toISOString()}`);
    return lines.join('\n');
  }
}

// ── Static: List Runs ──
function listRuns(limit = 10) {
  try {
    const files = fs.readdirSync(RUNS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort().reverse()
      .slice(0, limit);

    return files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
        return {
          runId: data.runId,
          goal: data.goal?.slice(0, 60),
          state: data.state,
          steps: data.dag?.length || 0,
          completed: data.completed?.length || 0,
          updatedAt: data.updatedAt,
        };
      } catch { return { file: f, error: 'parse failed' }; }
    });
  } catch { return []; }
}

function getRunStatus(runId) {
  const file = path.join(RUNS_DIR, `${runId}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// ── Utilities ──
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(level, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = level === 'error' ? '[ERR]' : level === 'warn' ? '[WRN]' : '[INF]';
  console.error(`${ts} ${prefix} ${msg}`);

  // Append to orchestrator log
  try {
    const logFile = path.join(LOGS_DIR, 'orchestrator.jsonl');
    fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), level, msg }) + '\n');
  } catch {}
}

// ── Broadcast Helper (when relay is available) ──
function broadcastToRelay(event, payload) {
  // Write to a shared file that relay-supabase.js can pick up
  try {
    const outbox = path.join(RUNS_DIR, 'outbox.jsonl');
    fs.appendFileSync(outbox, JSON.stringify({ event, payload, ts: new Date().toISOString() }) + '\n');
  } catch {}
}

// ── CLI ──
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`Usage:
  node orchestrator.js <goal> [projectPath]       Run orchestration
  node orchestrator.js --resume <runId>            Resume from checkpoint
  node orchestrator.js --status [runId]            Show run status
  node orchestrator.js --list                      List recent runs
  node orchestrator.js --abort <runId>             Abort a run`);
    return;
  }

  if (args[0] === '--list') {
    console.log(JSON.stringify(listRuns(), null, 2));
    return;
  }

  if (args[0] === '--status') {
    const runId = args[1];
    if (runId) {
      const status = getRunStatus(runId);
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(JSON.stringify(listRuns(5), null, 2));
    }
    return;
  }

  if (args[0] === '--abort') {
    const runId = args[1];
    if (!runId) { console.error('Usage: --abort <runId>'); return; }
    const file = path.join(RUNS_DIR, `${runId}.json`);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      data.state = STATE.ABORTED;
      data.updatedAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      console.log(`Aborted: ${runId}`);
    } else {
      console.error(`Run not found: ${runId}`);
    }
    return;
  }

  let orch;

  if (args[0] === '--resume') {
    const runId = args[1];
    if (!runId) { console.error('Usage: --resume <runId>'); return; }
    orch = Orchestrator.resume(runId);
  } else {
    const goal = args[0];
    const projectPath = args[1] || process.cwd();
    orch = new Orchestrator({ goal, projectPath });
  }

  // Wire up event broadcasting
  orch.on('state-change', (d) => broadcastToRelay('orch-state', d));
  orch.on('dag-created', (d) => broadcastToRelay('orch-dag', d));
  orch.on('step-start', (d) => broadcastToRelay('orch-step-start', d));
  orch.on('step-done', (d) => broadcastToRelay('orch-step-done', d));
  orch.on('progress', (d) => broadcastToRelay('orch-progress', d));
  orch.on('run-end', (d) => broadcastToRelay('orch-complete', d));

  // Console output for progress
  orch.on('step-start', (d) => console.log(`  >> ${d.step}: ${d.name}`));
  orch.on('step-done', (d) => console.log(`  ${d.success ? 'OK' : 'FAIL'} ${d.step}`));
  orch.on('progress', (d) => console.log(`  -- Progress: ${d.done}/${d.total}`));

  const result = await orch.run();
  console.log(JSON.stringify(result, null, 2));

  process.exit(result.status === STATE.DONE ? 0 : 1);
}

// ── Exports for programmatic use ──
module.exports = { Orchestrator, listRuns, getRunStatus, STATE, loadSkillMap };

// Run CLI if invoked directly
if (require.main === module) {
  main().catch(e => {
    console.error('Fatal:', e.message);
    process.exit(1);
  });
}
