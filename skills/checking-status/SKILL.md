---
name: checking-status
description: "Checks system status including CPU, memory, disk, battery, network, and running processes. Use when user asks for system status, health check, or resource usage."
allowed_tools: [Read, Bash]
model: claude-sonnet-4-6
max_turns: 10
---

# System Status Check

Run these checks and present as a table:

1. **CPU/Memory/Disk**: `free -h`, `df -h /`, `uptime`
2. **Battery**: `cat /sys/class/power_supply/BAT*/capacity` or platform equivalent
3. **Top processes**: `ps aux --sort=-%mem | head -6`
4. **Network**: `ip addr show` or `hostname -I`
5. **GPU** (if available): `nvidia-smi` or equivalent

Present results in a clean markdown table. Skip unavailable metrics silently.
