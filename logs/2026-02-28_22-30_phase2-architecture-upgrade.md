# Phase 2: 아키텍처 갭 해소 - 백엔드 훅 업그레이드

## 작업 요약
OpenClaw 비교분석에서 도출된 4가지 아키텍처 갭을 gateway.js, relay-supabase.js, agent-engine.js에 구현 완료.

## 수행한 작업 목록
- [x] #11 Steer 모드 강화 (gateway.js) - 3가지 모드(steer/followup/replace) + steerHistory + steer-applied 이벤트
- [x] #12 Worker Loop 이벤트 기반 전환 (relay-supabase.js) - 5초 폴링 → setImmediate 즉시 실행 + 30초 fallback + drain loop
- [x] #13 Webhook + Cron 입력 벡터 (gateway.js) - POST /webhook/:event (4타입) + CronScheduler (~/.claude/CRON.md)
- [x] #14 Global Lane 동시성 제어 (agent-engine.js) - maxConcurrent=3, globalLimited 반환, stale 자동 정리

## 변경된 파일 목록
| 파일 | 변경 전 | 변경 후 | 주요 변경 |
|------|---------|---------|-----------|
| `~/.claude/hooks/gateway.js` | 914줄 | 1154줄 | Steer 3모드, Webhook, CronScheduler |
| `~/.claude/hooks/relay-supabase.js` | 758줄 | 774줄 | Event-driven worker + triggerWorker() |
| `~/.claude/hooks/agent-engine.js` | 500줄 | 594줄 | Global concurrency + CLI 3개 |

## 실행한 주요 명령어
```bash
node -c ~/.claude/hooks/gateway.js        # 구문 검사 통과
node -c ~/.claude/hooks/relay-supabase.js  # 구문 검사 통과
node -c ~/.claude/hooks/agent-engine.js    # 구문 검사 통과
node ~/.claude/hooks/agent-engine.js global-stats   # 기능 테스트 통과
node ~/.claude/hooks/agent-engine.js global-set-max 3  # 기능 테스트 통과
```

## 발생한 이슈 및 해결 방법
- 없음. 3개 에이전트 병렬 실행으로 각 파일을 독립적으로 수정하여 충돌 없이 완료.

## 다음에 이어서 할 작업
- **Phase 3**: 대시보드 연동 강화
  - 대시보드에서 steer 모드 UI (replace/followup 버튼)
  - Webhook 상태 표시 + Cron 스케줄 뷰
  - Global Lane 동시성 모니터링 패널
  - Worker Loop 즉시 실행 시각적 피드백 (지연시간 표시)
- CRON.md 샘플 파일 생성 (heartbeat, cleanup 등 기본 작업)
- gateway.js + relay-supabase.js 동시 실행 통합 테스트
