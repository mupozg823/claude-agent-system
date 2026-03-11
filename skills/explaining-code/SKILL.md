---
name: explaining-code
description: "코드 상세 설명 (구조/흐름/다이어그램)"
---

# Code Explain - 코드 상세 설명

지정된 코드(파일, 함수, 모듈)를 **3단계 깊이**로 설명하세요.

## 설명 단계

### Level 1: 개요 (What)
- 이 코드가 **무엇을 하는지** 한 문장 요약
- 입력/출력이 무엇인지
- 어떤 모듈/클래스에 속하는지

### Level 2: 구조 (How)
- 주요 함수/메서드 목록과 역할
- 데이터 흐름 (ASCII 다이어그램)
- 의존성 관계

### Level 3: 상세 (Why)
- 핵심 알고리즘/로직의 동작 원리
- 왜 이런 설계를 선택했는지 (추론)
- 잠재적 문제점/개선점

## 다이어그램 규칙
- 데이터 흐름: ASCII 화살표로 표현
- 클래스 관계: 간단한 텍스트 다이어그램
- 호출 체인: `A → B → C` 형식

## 도구 활용
- Serena `get_symbols_overview`, `find_symbol` 으로 심볼 탐색
- `find_referencing_symbols` 로 의존성 파악

$ARGUMENTS
