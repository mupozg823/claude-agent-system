#!/usr/bin/env node
/**
 * skill-router.js - Skill-Aware Command Bridge
 *
 * Matches incoming commands against the 48 skill catalog and routes them
 * through `claude -p` with proper skill context injection.
 *
 * Usage:
 *   const { routeSkillCommand, matchSkill } = require('./skill-router');
 *   const cmd = routeSkillCommand("코드 리뷰 해줘 src/");
 *   // → 'claude -p "Use the /review skill. 코드 리뷰 해줘 src/" --max-turns 20'
 *
 * CLI test:
 *   node skill-router.js "코드 리뷰 해줘"
 *   node skill-router.js "/review src/"
 *   node skill-router.js --list
 */

const fs = require('fs');
const path = require('path');

const { CLAUDE_DIR, HOOKS_DIR } = require('./lib/utils');
const RULES_FILE = path.join(HOOKS_DIR, 'skill-rules.json');
const COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands');

// ── Load Skill Rules ──

let _skillRules = null;

function loadSkillRules() {
  if (_skillRules) return _skillRules;
  try {
    _skillRules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    return _skillRules;
  } catch (e) {
    console.error(`[skill-router] Failed to load rules: ${e.message}`);
    return { skills: [], categories: {} };
  }
}

// ── Match a command to a skill ──

function matchSkill(command) {
  if (!command || typeof command !== 'string') return null;
  const trimmed = command.trim();
  const rules = loadSkillRules();

  // 1. Exact slash-command match: "/review ..." → review skill
  const slashMatch = trimmed.match(/^\/([a-z][\w-]*)/i);
  if (slashMatch) {
    const slashName = slashMatch[1].toLowerCase();
    const skill = rules.skills.find(s => s.name === slashName);
    if (skill) {
      const args = trimmed.slice(slashMatch[0].length).trim();
      return { skill, args, matchType: 'slash', confidence: 1.0 };
    }
  }

  // 2. Pattern matching against skill rules (Korean + English keywords)
  const candidates = [];

  for (const skill of rules.skills) {
    // Check patterns (regex)
    if (skill.patterns) {
      for (const pattern of skill.patterns) {
        try {
          if (new RegExp(pattern, 'i').test(trimmed)) {
            const categoryBoost = (rules.categories[skill.category]?.priority_boost || 0);
            candidates.push({
              skill,
              args: trimmed,
              matchType: 'pattern',
              confidence: 0.7 + (skill.priority / 1000) + (categoryBoost / 1000),
              pattern,
            });
            break; // One match per skill is enough
          }
        } catch {}
      }
    }

    // Check keywords (substring match)
    if (skill.keywords) {
      for (const kw of skill.keywords) {
        if (trimmed.toLowerCase().includes(kw.toLowerCase())) {
          const categoryBoost = (rules.categories[skill.category]?.priority_boost || 0);
          candidates.push({
            skill,
            args: trimmed,
            matchType: 'keyword',
            confidence: 0.5 + (skill.priority / 1000) + (categoryBoost / 1000),
          });
          break;
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  // Deduplicate: keep highest confidence per skill
  const deduped = new Map();
  for (const c of candidates) {
    const existing = deduped.get(c.skill.name);
    if (!existing || c.confidence > existing.confidence) {
      deduped.set(c.skill.name, c);
    }
  }

  // Sort by confidence descending
  const sorted = [...deduped.values()].sort((a, b) => b.confidence - a.confidence);
  return sorted[0];
}

// ── Load skill prompt content (if available) ──

function getSkillContext(skillName) {
  const promptFile = path.join(COMMANDS_DIR, `${skillName}.md`);
  try {
    if (fs.existsSync(promptFile)) {
      const content = fs.readFileSync(promptFile, 'utf8');
      // Return first 500 chars as context hint
      return content.slice(0, 500).trim();
    }
  } catch {}
  return null;
}

// ── Route command to claude -p with skill context ──

function routeSkillCommand(command, opts = {}) {
  const match = matchSkill(command);
  const maxTurns = opts.maxTurns || 20;

  if (match && match.confidence >= 0.5) {
    const { skill, args } = match;
    const skillContext = getSkillContext(skill.name);

    // Build claude -p command with skill context
    let prompt;
    if (match.matchType === 'slash') {
      // Direct slash command - pass args directly
      prompt = args
        ? `Use the /${skill.name} skill. ${args}`
        : `Use the /${skill.name} skill.`;
    } else {
      // Natural language - include original command
      prompt = `Use the /${skill.name} skill to handle this request: ${args}`;
    }

    // Add skill context hint if available
    if (skillContext && opts.includeContext !== false) {
      prompt += `\n\nSkill context: ${skillContext.slice(0, 200)}`;
    }

    // Escape for shell
    const escapedPrompt = prompt.replace(/"/g, '\\"').replace(/\$/g, '\\$');

    return {
      command: `claude -p "${escapedPrompt}" --max-turns ${maxTurns}`,
      skill: skill.name,
      category: skill.category,
      confidence: match.confidence,
      matchType: match.matchType,
      original: command,
    };
  }

  // No skill match - fallback to generic claude -p
  const escapedCommand = command.replace(/"/g, '\\"').replace(/\$/g, '\\$');
  return {
    command: `claude -p "${escapedCommand}" --max-turns ${Math.min(maxTurns, 10)}`,
    skill: null,
    category: null,
    confidence: 0,
    matchType: 'none',
    original: command,
  };
}

// ── Get MCP tool stats from audit log ──

function getMcpStats(auditDir) {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const auditFile = path.join(auditDir || path.join(CLAUDE_DIR, 'logs', 'audit'), `audit-${dateStr}.jsonl`);

  const stats = { servers: {}, totalCalls: 0, lastSeen: {} };

  try {
    if (!fs.existsSync(auditFile)) return stats;
    const content = fs.readFileSync(auditFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const tool = entry.tool || entry.tool_name || '';
        if (tool.startsWith('mcp__')) {
          // Parse: mcp__serverName__toolName
          const parts = tool.split('__');
          if (parts.length >= 3) {
            const server = parts[1];
            if (!stats.servers[server]) {
              stats.servers[server] = { calls: 0, tools: {}, lastSeen: null };
            }
            stats.servers[server].calls++;
            stats.servers[server].tools[parts.slice(2).join('__')] =
              (stats.servers[server].tools[parts.slice(2).join('__')] || 0) + 1;
            stats.servers[server].lastSeen = entry.ts || entry.timestamp;
            stats.totalCalls++;
            stats.lastSeen[server] = entry.ts || entry.timestamp;
          }
        }
      } catch {}
    }
  } catch {}

  return stats;
}

// ── Get skill usage stats from audit log ──

function getSkillStats(auditDir) {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const auditFile = path.join(auditDir || path.join(CLAUDE_DIR, 'logs', 'audit'), `audit-${dateStr}.jsonl`);

  const stats = { skills: {}, totalRouted: 0 };

  try {
    if (!fs.existsSync(auditFile)) return stats;
    const content = fs.readFileSync(auditFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.skill_routed) {
          const skill = entry.skill_routed;
          stats.skills[skill] = (stats.skills[skill] || 0) + 1;
          stats.totalRouted++;
        }
      } catch {}
    }
  } catch {}

  return stats;
}

// ── List all available skills ──

function listSkills() {
  const rules = loadSkillRules();
  const byCategory = {};

  for (const skill of rules.skills) {
    const cat = skill.category || 'other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(skill);
  }

  return { skills: rules.skills, byCategory, categories: rules.categories };
}

// ── Exports ──

module.exports = {
  matchSkill,
  routeSkillCommand,
  getSkillContext,
  getMcpStats,
  getSkillStats,
  listSkills,
  loadSkillRules,
};

// ── CLI Mode ──

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    const { byCategory, categories } = listSkills();
    console.log('\n=== Skill Catalog ===\n');
    for (const [cat, skills] of Object.entries(byCategory)) {
      const label = categories[cat]?.label || cat;
      console.log(`\n[${label}] (${skills.length})`);
      for (const s of skills) {
        console.log(`  /${s.name.padEnd(25)} pri:${s.priority}  ${(s.keywords || []).slice(0, 3).join(', ')}`);
      }
    }
    console.log();
    process.exit(0);
  }

  if (args[0] === '--mcp-stats') {
    const stats = getMcpStats();
    console.log('\n=== MCP Server Stats ===\n');
    console.log(JSON.stringify(stats, null, 2));
    process.exit(0);
  }

  if (args.length === 0) {
    console.log('Usage:');
    console.log('  node skill-router.js "command to route"');
    console.log('  node skill-router.js --list');
    console.log('  node skill-router.js --mcp-stats');
    process.exit(0);
  }

  const command = args.join(' ');
  const result = routeSkillCommand(command);

  console.log('\n=== Skill Router Result ===\n');
  console.log(`  Input:      ${result.original}`);
  console.log(`  Skill:      ${result.skill || '(none - generic)'}`);
  console.log(`  Category:   ${result.category || '-'}`);
  console.log(`  Confidence: ${result.confidence.toFixed(2)}`);
  console.log(`  Match:      ${result.matchType}`);
  console.log(`  Command:    ${result.command}`);
  console.log();
}
