#!/bin/bash
# session-init.sh - SessionStart hook
# 세션 시작 시 최근 로그에서 컨텍스트를 hookSpecificOutput.additionalContext로 주입

LOGS_DIR="$HOME/.claude/logs"

# 로그 디렉토리 없으면 빈 응답
if [ ! -d "$LOGS_DIR" ]; then
  echo '{}'
  exit 0
fi

# 최근 로그 파일 찾기 (수정 시간 기준)
LATEST=$(ls -t "$LOGS_DIR"/*.md 2>/dev/null | head -1)

if [ -z "$LATEST" ]; then
  echo '{}'
  exit 0
fi

# 파일 이름에서 날짜 추출
FILENAME=$(basename "$LATEST")

# "다음에 이어서 할 작업" 섹션 추출 (있으면)
NEXT_TASKS=$(sed -n '/다음에 이어서 할 작업/,/^## /p' "$LATEST" 2>/dev/null | head -10)

if [ -z "$NEXT_TASKS" ]; then
  SUMMARY=$(head -5 "$LATEST" 2>/dev/null)
  if [ -z "$SUMMARY" ]; then
    echo '{}'
    exit 0
  fi
  CONTEXT="[이전 세션] ${FILENAME} | $(echo "$SUMMARY" | tr '\n' ' ')"
else
  CONTEXT="[이전 세션] ${FILENAME} | 미완료 작업 있음. /continue 로 이어서 작업 가능"
fi

# JSON escape via python
ESCAPED=$(python3 -c "import sys,json; print(json.dumps(sys.argv[1]))" "$CONTEXT" 2>/dev/null)

if [ -z "$ESCAPED" ]; then
  echo '{}'
  exit 0
fi

echo "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":${ESCAPED}}}"
