# 대시보드 Phase C+D: OpenClaw 아키텍처 + 스킬 브릿지 구현

**날짜**: 2026-02-28 16:31
**작업 요약**: Gateway에 바인딩 규칙 엔진/HMAC/Rate Limiting 추가, 스킬 라우터 신규 작성, 대시보드에 MCP/스킬 패널 추가 (+921줄)

---

## 수행한 작업

- [x] Phase C: OpenClaw 아키텍처 완성
  - [x] `binding-rules.json` 신규 작성 (8개 라우팅 규칙)
  - [x] `gateway.js`에 BindingRuleEngine 클래스 추가 (소스→핸들러 매칭, 60초 핫리로드)
  - [x] `gateway.js`에 RateLimiter 클래스 추가 (토큰 버킷: orchestrate 300s, status 5s, steer 2s, default 30s)
  - [x] `gateway.js`에 Webhook HMAC-SHA256 검증 추가 (X-Signature/X-Hub-Signature-256, timingSafeEqual)
  - [x] `relay-supabase.js`에 BackoffReconnect 클래스 추가 (base 1s → max 60s, jitter)
  - [x] 채널 에러/타임아웃 시 지수 백오프 자동 재연결 통합
- [x] Phase D: 스킬 인식 커맨드 브릿지
  - [x] `skill-router.js` 신규 작성 (48개 스킬 3단계 매칭: 슬래시/패턴/키워드)
  - [x] `routeSkillCommand()` → `claude -p` + 스킬 컨텍스트 주입
  - [x] `getMcpStats()` → 감사 로그에서 mcp__ 도구 사용량 추출
  - [x] `getSkillStats()` → 스킬 라우팅 기록 추출
  - [x] Gateway에 5개 API 추가 (skill-execute, skill-match, skill-list, mcp-stats, skill-stats)
  - [x] Gateway CommandExecutor에 스킬 라우터 자동 감지 통합
  - [x] Webhook `/webhook/skill` 엔드포인트 추가
  - [x] 대시보드에 MCP/스킬 탭 추가 (Bottom Nav + Panel Tab)
  - [x] MCP 서버 상태 바 (7개 서버, 호출수/도구/마지막 시각)
  - [x] 스킬 라우팅 카운트 + 빠른 스킬 실행 버튼
  - [x] `trackMcp()` 함수로 실시간 MCP 이벤트 추적
- [x] 전체 구문 검사 통과 (4파일 node -c + JSON 파싱 + 대시보드 JS)
- [x] 기존 기능 유지 확인 (agent-engine status 정상)
- [x] skill-router CLI 테스트 통과

## 변경된 파일

| 파일 | 변화 | 줄수 |
|------|------|------|
| `~/.claude/hooks/gateway.js` | 수정 (+331) | 1,155→1,486 |
| `~/.claude/hooks/relay-supabase.js` | 수정 (+66) | 775→841 |
| `~/.claude/hooks/skill-router.js` | **신규** | 324 |
| `~/.claude/hooks/binding-rules.json` | **신규** | 68 |
| `~/.claude/dashboard-remote.html` | 수정 (+132) | 1,910→2,042 |
| **합계** | | **+921줄** |

## 주요 명령어

```bash
node -c gateway.js                          # 구문 검사
node -c relay-supabase.js                   # 구문 검사
node -c skill-router.js                     # 구문 검사
node skill-router.js "코드 리뷰 해줘 src/"  # CLI 테스트 → review (0.77)
node skill-router.js --mcp-stats            # MCP 통계 (총 46회)
node skill-router.js --list                 # 48개 스킬 카탈로그
node agent-engine.js status                 # 기존 기능 확인
```

## 이슈 및 해결

1. **Git Bash 슬래시 확장**: `/review` 입력 시 `C:/Program Files/Git/review`로 확장됨
   - 원인: Git Bash가 `/`로 시작하는 인자를 Windows 경로로 변환
   - 해결: 실제 사용은 WebSocket/Supabase 경유이므로 영향 없음. CLI 테스트 시 따옴표 사용
2. **`$HOME` 경로 문제**: `node -e` 명령에서 `$HOME`이 이중 해석
   - 해결: `process.env.HOME || process.env.USERPROFILE`로 직접 참조

## 다음 작업 (Phase A+B)

- [ ] Phase A: PixiJS v8 마이그레이션
  - pixi.js@^8 설치 + Application 초기화
  - 층 배경 → TilingSprite
  - 파티클 → ParticleContainer
  - 캐릭터 → AnimatedSprite (drawCh 분리)
- [ ] Phase B: 카이로소프트 디자인 오버홀
  - 팔레트 교체 (cream/warm-red/teal/rust)
  - 에이전트 4스탯 시스템 (code/research/network/speed)
  - 시설 콤보 시스템
  - 게임 캘린더
- [ ] Vercel 배포 후 MCP 상태/스킬 카탈로그 표시 확인
- [ ] HMAC 테스트: `curl -X POST -H "X-Signature: <hmac>" http://localhost:18790/webhook/command`
- [ ] Rate Limiting 테스트: 연속 요청 → 429 반환 확인
