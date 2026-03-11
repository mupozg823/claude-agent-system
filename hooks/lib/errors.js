/**
 * errors.js - Shared error logging for Claude Agent System
 *
 * Replaces empty `catch {}` blocks with structured error logging.
 * Never throws — safe to use in all hooks without crashing parent process.
 */
const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE || '/root';
const ERROR_LOG = path.join(HOME, '.claude', 'logs', 'errors.jsonl');

/**
 * Log an error to errors.jsonl and stderr.
 * @param {string} module - Source module name (e.g., 'audit-log', 'telemetry')
 * @param {string} action - What was being done (e.g., 'write-failed', 'parse-error')
 * @param {Error|string} error - The error object or message
 */
function logError(module, action, error) {
  const msg = (error && error.message ? error.message : String(error)).slice(0, 500);
  const entry = {
    ts: new Date().toISOString(),
    module,
    action,
    msg,
  };

  // Write to JSONL (never throw)
  try {
    fs.mkdirSync(path.dirname(ERROR_LOG), { recursive: true });
    fs.appendFileSync(ERROR_LOG, JSON.stringify(entry) + '\n');
  } catch { /* last resort: truly silent */ }

  // Also stderr for hook debugging
  process.stderr.write(`[${module}] ${action}: ${msg}\n`);
}

module.exports = { logError, ERROR_LOG };
