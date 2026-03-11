---
name: responding-incidents
description: "프로덕션 장애 대응 워크플로우"
---

# Incident Response - 장애 대응

프로덕션 장애를 체계적으로 진단하고 해결하세요.

## 대응 단계

### 🔴 Phase 1: 상황 파악 (2분 이내)
- 에러 로그/메시지 수집
- 영향 범위 파악 (어떤 서비스, 몇 명의 사용자)
- 최근 배포/변경사항 확인 (`git log --since="24 hours ago"`)

### 🟡 Phase 2: 긴급 조치 (5분 이내)
- 롤백 가능 여부 판단
- 핫픽스 vs 롤백 결정
- 임시 우회책 적용 (feature flag, 캐시 등)

### 🟢 Phase 3: 근본 원인 분석
- 스택 트레이스 분석
- 관련 코드 리뷰
- 재현 조건 식별
- 영구 수정 적용

### 📋 Phase 4: 사후 처리
- 인시던트 리포트 작성
- 재발 방지 조치 도출
- 모니터링/알림 개선안

## 도구 활용
- t-error-analysis: 에러 패턴 분석
- t-smart-debug: 근본 원인 추적
- w-git: 핫픽스 브랜치 → 커밋 → PR

## 출력
타임라인 형식의 인시던트 리포트

$ARGUMENTS
