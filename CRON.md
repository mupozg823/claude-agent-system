# Gateway Cron Jobs

## Active Jobs

- `*/30 * * * *` node ~/.claude/hooks/heartbeat.js
- `0 */6 * * *` node ~/.claude/hooks/agent-engine.js cleanup
- `0 9 * * 1` node ~/.claude/hooks/agent-engine.js global-stats

## Disabled

- `*/5 * * * *` node ~/.claude/hooks/agent-engine.js status [disabled]
