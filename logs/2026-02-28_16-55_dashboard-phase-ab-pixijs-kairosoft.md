# 대시보드 Phase A 버그수정 + Phase B 카이로소프트 디자인 오버홀

**날짜**: 2026-02-28 16:55
**작업 요약**: Phase A PixiJS 4대 버그 수정 완료 + Phase B 카이로소프트 디자인 오버홀 전체 구현 (팔레트/4스탯/시설콤보/게임캘린더/플로팅넘버) (+146줄)

---

## 수행한 작업

### Phase A 버그 수정 (이전 세션 이어서)
- [x] 중복 `cW()`/`cH()` 함수 제거 (529-530줄이 PixiJS-aware 436-437줄 덮어씀)
- [x] `drawHUD` 컨텍스트 오류 수정 (`hx=cx` → `pixiReady ? hudCx : cx`)
- [x] `connectWith()` 비동기 초기화 수정 (`async/await` + `startRenderLoop()`)
- [x] 터치 핸들러 캔버스 참조 수정 (`.scene` + `pixiApp.canvas`)
- [x] 구문 검사 + 중복 함수 검사 통과

### Phase B.1: 카이로소프트 팔레트 교체
- [x] CSS `:root`에 8개 카이로 변수 추가 (cream/warm-red/muted-teal/rust/warm-bg/accent-gold/kairo-border/kairo-panel)
- [x] 에이전트 카드 `.ac` 스타일을 카이로 팔레트로 전면 교체
- [x] 레벨 배지 `.lvbadge` CSS 추가

### Phase B.2: 에이전트 4스탯 시스템
- [x] `Ag` 클래스에 `stats:{code,research,network,speed}` 추가
- [x] `onE()`에서 도구별 스탯 자동 추적 (Write/Edit→code, Read/Grep→research, MCP/Web→network, ops/min→speed)
- [x] 에이전트 카드 `rAgHTML()`을 4스탯 바 (CD/RS/NW/SP) + 레벨 배지로 전면 재설계
- [x] `.stat-grid`, `.stat-bar` CSS 추가

### Phase B.3: 시설 콤보 시스템
- [x] `FACILITY_COMBOS` 6개 정의 (CI/CD, 코드 분석팀, 외부 연동, 자동화 부서, 코드 리뷰, 아키텍처 분석)
- [x] `checkFacilityCombos()` → 동시 작업 에이전트 조합 감지
- [x] 콤보 발동 시 토스트 + 파티클 + 플로팅 텍스트 + XP 보너스
- [x] `addCombo()`에 시설 콤보 체크 연동

### Phase B.4: 게임 캘린더
- [x] `getGameCalendar()` 함수 (세션 업타임 → 게임 연/월/일/계절 변환)
- [x] HUD에 캘린더 표시 (우상단, 계절별 색상)
- [x] 메트릭 패널 게임 통계 섹션에 캘린더 + 시설 콤보 표시

### Phase B.5: 플로팅 넘버 + 알림 버블
- [x] `spawnFloatingText()` / `updateFloatingTexts()` 시스템 (PixiJS Text + Canvas 2D 폴백)
- [x] XP 획득 시 "+N XP" 플로팅 텍스트 (3회마다 or 콤보5 이상)
- [x] 레벨업 시 "LEVEL UP!" + "Lv.N" 대형 플로팅 텍스트
- [x] 에이전트 레벨업 시 "LV UP!" 플로팅 텍스트
- [x] 시설 콤보 발동 시 콤보명 + 배율 플로팅 텍스트
- [x] `drawBub()` 카이로 스타일 개선 (cream 배경 + golden 테두리 + 악센트 라인)
- [x] `gameLoop()`과 `render()` 모두에 `updateFloatingTexts()` 호출 추가
- [x] 전체 구문 검사 + 신규 함수 존재 확인 통과

## 변경된 파일

| 파일 | 변화 | 줄수 |
|------|------|------|
| `~/.claude/dashboard-remote.html` | 수정 (Phase A 4건 버그 + Phase B 5개 서브태스크) | 2,329→2,475 (+146) |

## 실행한 주요 명령어

```bash
wc -l ~/.claude/dashboard-remote.html          # 줄 수 확인
node ~/.claude/tmp-check.js                     # 종합 검사 (구문/중복/신규함수)
```

## 이슈 및 해결

1. **Node v24 `-e` 플래그 이스케이프**: `!` 문자가 유니코드 이스케이프로 해석
   - 해결: 임시 JS 파일로 작성 후 실행, 이후 삭제

2. **HUD 크기 부족**: 캘린더 + 콤보 표시 공간 필요
   - 해결: `hudW2` 130→140 / 210→220 확장, `hudH2`에 `hasCombo` 조건 추가

## Phase A+B 전체 완료 현황

| Phase | 항목 | 상태 |
|-------|------|------|
| A | PixiJS v8 CDN + Application 초기화 | ✅ |
| A | 7레이어 Stage 계층 + 듀얼 렌더 | ✅ |
| A | 파티클/날씨 PixiJS 네이티브 | ✅ |
| A | 4대 버그 수정 (이번 세션) | ✅ |
| B.1 | 카이로 팔레트 (8변수) | ✅ |
| B.2 | 4스탯 시스템 (CD/RS/NW/SP) | ✅ |
| B.3 | 시설 콤보 (6종) | ✅ |
| B.4 | 게임 캘린더 | ✅ |
| B.5 | 플로팅 넘버 + 알림 버블 | ✅ |

## 다음에 이어서 할 작업

- [ ] Vercel 배포 후 전체 기능 동작 확인
  - PixiJS WebGL 렌더링
  - 4스탯 바 표시
  - 시설 콤보 발동
  - 게임 캘린더 HUD 표시
  - 플로팅 텍스트 XP/레벨업
- [ ] 모바일(ROG Ally X/폰)에서 PixiJS 성능 테스트
- [ ] HMAC/Rate Limiting 테스트 (Phase C 검증)
- [ ] Phase B 추가 개선 가능:
  - 에이전트 스프라이트를 PNG 스프라이트시트로 교체 (현재 프로시저럴)
  - 리서치 포인트(RP) 시스템 추가
  - 계절별 배경 변화 이펙트
