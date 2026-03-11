/**
 * paths.js - Shared path constants for Claude Agent System
 */
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_DIR = path.join(HOME, '.claude');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const LOGS_DIR = path.join(CLAUDE_DIR, 'logs');
const AUDIT_DIR = path.join(LOGS_DIR, 'audit');
const CHECKPOINT_DIR = path.join(LOGS_DIR, 'checkpoints');
const CONTEXTS_DIR = path.join(CLAUDE_DIR, 'contexts');
const QUEUE_DIR = path.join(CLAUDE_DIR, 'queue');
const COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands');
const ORCH_DIR = path.join(CLAUDE_DIR, 'orchestrator');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const TEMP_DIR = path.join(CLAUDE_DIR, '.tmp');

module.exports = {
  HOME,
  CLAUDE_DIR,
  HOOKS_DIR,
  LOGS_DIR,
  AUDIT_DIR,
  CHECKPOINT_DIR,
  CONTEXTS_DIR,
  QUEUE_DIR,
  COMMANDS_DIR,
  ORCH_DIR,
  SKILLS_DIR,
  TEMP_DIR,
};
