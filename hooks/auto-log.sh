#!/bin/bash
# auto-log.sh - Stop hook
# 세션 종료 시 자동 타임스탬프 로깅 (간단 마커 파일)

LOGS_DIR="$HOME/.claude/logs"
mkdir -p "$LOGS_DIR"

TIMESTAMP=$(date +"%Y-%m-%d_%H-%M")
MARKER_FILE="${LOGS_DIR}/.last-session-${TIMESTAMP}"

# 마커 파일 생성 (세션 종료 시각 기록)
echo "Session ended at $(date '+%Y-%m-%d %H:%M:%S')" > "$MARKER_FILE"

# 7일 이상 된 마커 파일 정리
find "$LOGS_DIR" -name ".last-session-*" -mtime +7 -delete 2>/dev/null

echo '{}'
