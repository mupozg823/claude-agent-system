---
description: "레거시 코드 현대화 전략 및 실행"
---

# Legacy Modernize - 레거시 현대화

레거시 코드를 현대적 패턴/프레임워크로 점진적 마이그레이션하세요.

## 분석 단계

### 1. 현상 진단
- 코드 연령 (마지막 수정일 기준)
- 의존성 상태 (EOL, deprecated)
- 테스트 커버리지 현황
- 기술 부채 핫스팟 (가장 문제가 많은 파일)

### 2. 현대화 전략
- **Strangler Fig**: 새 코드로 점진 교체
- **Branch by Abstraction**: 추상화 레이어 → 교체
- **Parallel Run**: 신구 동시 실행 → 비교 → 전환

### 3. 우선순위 결정
- 변경 빈도 × 복잡도 매트릭스
- ROI 기반 우선순위 (효과/비용)

### 4. 실행 계획
- 단계별 마일스톤
- 호환성 보장 전략
- 롤백 포인트

## 도구 활용
- Serena: 심볼 의존성 분석
- t-tech-debt: 기술부채 정량화
- t-refactor: 리팩토링 실행
- s-dependency-upgrader: 의존성 업그레이드 패턴

$ARGUMENTS
