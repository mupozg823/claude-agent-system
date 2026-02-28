# 대시보드 Phase A+B 완성 + 캐릭터 수정 + 아키텍처 매핑 + Vercel 배포

**날짜**: 2026-02-28 17:02
**작업 요약**: Phase A 버그4건 수정, Phase B 카이로소프트 오버홀 5항목 구현, 캐릭터 뒤돌기/앉기 수정, Claude Code 아키텍처-캐릭터 매핑 정밀화, Vercel 3회 배포

---

## 수행한 작업

### Phase A: PixiJS v8 버그 수정
- [x] 중복 `cW()`/`cH()` 제거 (529-530줄이 PixiJS-aware 버전 덮어씀)
- [x] `drawHUD` 컨텍스트 오류 수정 (`hx=cx` → `pixiReady ? hudCx : cx`)
- [x] `connectWith()` 비동기 초기화 (`async/await` + `startRenderLoop()`)
- [x] 터치 핸들러 캔버스 참조 (`.scene` + `pixiApp.canvas`)

### Phase B: 카이로소프트 디자인 오버홀
- [x] B.1: 카이로 팔레트 8 CSS 변수 (cream/warm-red/muted-teal/rust/warm-bg/accent-gold/kairo-border/kairo-panel)
- [x] B.2: 에이전트 4스탯 시스템 (code/research/network/speed) + 에이전트 카드 UI
- [x] B.3: 시설 콤보 6종 (CI/CD, 코드 분석팀, 외부 연동, 자동화 부서, 코드 리뷰, 아키텍처 분석)
- [x] B.4: 게임 캘린더 (세션→게임시간, HUD+메트릭 패널 표시)
- [x] B.5: 플로팅 넘버 시스템 + 카이로 스타일 말풍선

### 캐릭터 수정
- [x] 뒤돌기: `drawCh()`에 `cx.save()/cx.scale(-1,1)/cx.restore()` 좌우 반전 추가
- [x] 앉기: `up()` 메서드에서 work 전환 시 `this.d=1` 강제 리셋 제거 (마지막 방향 유지)
- [x] idle 상태 랜덤 방향 전환 추가 (`Math.random()<.005`)

### Claude Code 아키텍처-캐릭터 매핑 정밀화
- [x] `t2a()` MCP 세분화: grep-app→finder, context7→web, filesystem→reader, memory→agent, sequential-thinking→agent, Notion→web
- [x] `t2a()` 도구 추가: Task/Skill/TaskCreate/TaskUpdate/AskUserQuestion/EnterPlanMode/ExitPlanMode→agent, ToolSearch→finder
- [x] `desc()` 개선: Bash 세분화(git/npm/docker/test), Write/Edit 파일명 표시, MCP 서버별 한글 설명

### Vercel 배포 (3회)
- [x] 1차: Phase A+B 구현 완료 후
- [x] 2차: 캐릭터 뒤돌기/앉기 수정 후
- [x] 3차: 아키텍처 매핑 정밀화 후

## 변경된 파일

| 파일 | 변화 | 최종 줄수 |
|------|------|-----------|
| `~/.claude/dashboard-remote.html` | 수정 (Phase A+B+캐릭터+매핑) | 2,509 |

## 실행한 주요 명령어

```bash
node ~/.claude/tmp-check.js                     # 구문/중복/신규함수 검사 (4회)
cp ~/.claude/dashboard-remote.html /tmp/vercel-deploy/index.html  # 배포 준비
npx vercel link --yes --scope mopzgzs-projects --project remote-dash  # 프로젝트 링크
npx vercel --prod --yes                         # 프로덕션 배포 (3회)
```

## 이슈 및 해결

1. **Node v24 `-e` 이스케이프**: `!` 문자 유니코드 해석 → 임시 JS 파일로 우회
2. **Vercel scope 누락**: `--scope mopzgzs-projects` 명시 필요
3. **Vercel 프로젝트 미링크**: 신규 `vercel-deploy` 생성됨 → `--project remote-dash`로 재링크
4. **캐릭터 방향 리셋**: `up()` 에서 `this.d=1` 강제 → 제거하여 마지막 방향 유지

## 전체 Phase 완료 현황

| Phase | 내용 | 상태 |
|-------|------|------|
| C | OpenClaw 아키텍처 (바인딩/HMAC/Rate Limit/백오프) | ✅ (이전 세션) |
| D | 스킬 브릿지 (skill-router/gateway 통합/MCP 패널) | ✅ (이전 세션) |
| A | PixiJS v8 마이그레이션 + 버그 수정 | ✅ |
| B | 카이로소프트 디자인 오버홀 | ✅ |

## 다음에 이어서 할 작업

- [ ] 카이로소프트 형식 추가 디벨롭 (사용자 요청)
  - 에이전트 PNG 스프라이트시트 교체 (현재 프로시저럴)
  - 리서치 포인트(RP) 시스템
  - 계절별 배경 변화
  - 에이전트 승진/특성 시스템
- [ ] 모바일 PixiJS 성능 테스트
- [ ] HMAC/Rate Limiting 실사용 테스트
