# Claude Agent System v5

## 운영 원칙
- **한국어 대화**, 코드/로그는 영어
- 자율 진행 (파괴적 작업만 확인)
- 막히면 3가지 대안 먼저 시도
- 작업 끝날 때까지 멈추지 않기 (Stop 훅이 미완료 감지)

## 비용 최적화 (env)
- 서브에이전트: Haiku 모델 사용 (80% 절감)
- 사고 토큰: 10K 제한 (70% 절감)
- 자동 압축: 85% 트리거
- 불필요한 모델 호출 비활성화

## 훅 파이프라인
```
SessionStart  → session-init.js     체크포인트/컨텍스트 복원
UserPrompt    → skill-suggest.js    스킬 자동 추천
PreCompact    → pre-compact.js      압축 전 상태 백업
PostToolUse   → audit-log.js        JSONL 감사 로그
Stop          → stop-check.js       미완료 감지 (하이브리드)
              → prompt hook          AI 판단 (애매한 경우)
              → git-check.sh        미커밋 변경 확인
StatusLine    → statusline.sh       컨텍스트 모니터링
```

## 코어 엔진
```bash
node ~/.claude/hooks/agent-engine.js <command>
# checkpoint, status, metrics, cleanup
# lane-add/next/complete/fail/stats <session>
# queue-add/list/complete
```

## 도구 우선순위
1. **MCP 서버** → Serena(코드 심볼), context7(문서), memory(지식), sequential-thinking(추론)
2. **Grep/Glob** → 파일/패턴 검색
3. **Read** → offset/limit으로 필요한 줄만
4. **Agent** → 독립 작업은 병렬 에이전트로

## 인프라 데몬
| 데몬 | 명령 | 용도 |
|------|------|------|
| Gateway | `node hooks/gateway.js --daemon` | WebSocket :18790 제어 평면 |
| Relay | `node hooks/relay-supabase.js` | Supabase 원격 모니터링 |
| Telegram | `node hooks/telegram-adapter.js --daemon` | Telegram 원격 제어 (SDK+SQLite) |
| Heartbeat | `node hooks/heartbeat.js --install` | 30분 스케줄러 |
| Orchestrator | `node hooks/orchestrator.js "목표" /path` | DAG 기반 자율 실행 |

## 스킬 (Skills 2.0 + Legacy Commands)

Skills 2.0 (`skills/`): reviewing-code, logging-session, checking-status, developing-features, debugging-errors

Legacy (`commands/`): /log, /continue, /status, /optimize, /review, /fix-all, /deploy, /orchestrate 등 48개

## 권한 (settings.json)
- **허용**: Bash, Edit, Write, Read, Grep, Glob, WebSearch, WebFetch, NotebookEdit, TodoWrite, Agent, Skill, mcp__*
- **차단**: rm -rf /, force push main/master, git reset --hard, npm publish, shutdown, reboot, format, del /s /q C:\Windows

## Git
- defaultBranch=main, 커밋 메시지 한글/영어 (사용자 지시 따름)
- force push 전 반드시 확인

## 디렉토리
```
~/.claude/
├── hooks/           17 JS/SH 모듈 + lib/paths.js + lib/utils.js
├── skills/          Skills 2.0 (SKILL.md + 번들 파일)
├── commands/        Legacy 48개 스킬
├── logs/audit/      JSONL 감사 로그 (30일)
├── logs/checkpoints/ 세션/컴팩트 체크포인트 (14일)
├── .tmp/            StatusLine 상태 캐시
├── orchestrator/    DAG + outbox
├── queue/           명령 큐
└── settings.json    권한/훅/프라이버시
```
