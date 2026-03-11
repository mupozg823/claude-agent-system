#!/bin/bash
# statusline.sh - StatusLine hook for real-time context window monitoring
# Reads JSON from stdin, outputs single-line status to stdout
# Triggers proactive checkpoints at threshold crossings (30%, 15%, 5%)

set -euo pipefail

AUDIT_DIR="$HOME/.claude/logs/audit"
TEMP_DIR="$HOME/.claude/.tmp"
STATE_FILE="$TEMP_DIR/statusline-state"
SESSION_START_FILE="$TEMP_DIR/session-start"
ENGINE="$HOME/.claude/hooks/agent-engine.js"

mkdir -p "$TEMP_DIR"

# Record session start time on first run
if [[ ! -f "$SESSION_START_FILE" ]]; then
  date +%s > "$SESSION_START_FILE"
fi

# Read stdin JSON
input=$(cat)

# Parse remaining percentage (jq with fallback)
remaining="?"
if command -v jq &>/dev/null; then
  remaining=$(echo "$input" | jq -r '.context_window.remaining_percentage // "?"' 2>/dev/null || echo "?")
fi

# Calculate tool count from today's audit log (fast: wc -l)
today=$(date +%Y-%m-%d)
audit_file="$AUDIT_DIR/audit-${today}.jsonl"
tool_count=0
if [[ -f "$audit_file" ]]; then
  tool_count=$(wc -l < "$audit_file" 2>/dev/null || echo 0)
fi

# Session elapsed time in minutes
elapsed="?"
if [[ -f "$SESSION_START_FILE" ]]; then
  start_ts=$(cat "$SESSION_START_FILE")
  now_ts=$(date +%s)
  elapsed_sec=$(( now_ts - start_ts ))
  elapsed=$(( elapsed_sec / 60 ))
fi

# Checkpoint status
cp_status="OK"

# Threshold checkpoint actions
if [[ "$remaining" != "?" ]]; then
  remaining_int=${remaining%.*}  # strip decimal

  if [[ "$remaining_int" -le 5 ]] && ! grep -q "5" "$STATE_FILE" 2>/dev/null; then
    node "$ENGINE" checkpoint "context-critical-5pct" 2>/dev/null || true
    echo "5" >> "$STATE_FILE"
    cp_status="CRITICAL"
  elif [[ "$remaining_int" -le 15 ]] && ! grep -q "15" "$STATE_FILE" 2>/dev/null; then
    node "$ENGINE" checkpoint "context-warning-15pct" 2>/dev/null || true
    echo "15" >> "$STATE_FILE"
    cp_status="WARN"
  elif [[ "$remaining_int" -le 30 ]] && ! grep -q "30" "$STATE_FILE" 2>/dev/null; then
    node "$ENGINE" checkpoint "context-warning-30pct" 2>/dev/null || true
    echo "30" >> "$STATE_FILE"
    cp_status="LOW"
  fi
fi

# Output single-line status
echo "[CTX ${remaining}%] Tools:${tool_count} | ${elapsed}min | CP:${cp_status}"
