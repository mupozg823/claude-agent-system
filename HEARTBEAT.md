# Heartbeat Checklist

이 파일은 Heartbeat 데몬이 주기적으로 확인하는 체크리스트입니다.
각 항목의 `enabled: true`인 것만 실행합니다.

## 자동 작업

### 1. 감사 로그 정리
- enabled: true
- schedule: daily
- action: cleanup old audit logs (30 days), checkpoints (14 days), markers (7 days)

### 2. 대기 큐 처리
- enabled: true
- schedule: on_wake
- action: check ~/.claude/queue/commands.jsonl for pending items

### 3. 시스템 상태 점검
- enabled: true
- schedule: daily
- action: disk space, node version, git status of active projects

### 4. Supabase 릴레이 상태 확인
- enabled: true
- schedule: on_wake
- action: check relay-supabase.js process alive, restart if crashed

### 5. 메모리 동기화
- enabled: false
- schedule: weekly
- action: sync MEMORY.md with MCP memory graph

## 사용자 트리거 작업

### 6. 프로젝트 빌드 체크
- enabled: false
- project: stream-admin
- action: npm run build && report errors

### 7. 의존성 업데이트 확인
- enabled: false
- action: npm outdated across all projects
