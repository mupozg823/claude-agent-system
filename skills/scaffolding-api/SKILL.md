---
name: scaffolding-api
description: "API 엔드포인트 스캐폴딩 (REST/GraphQL)"
---

# API Scaffold - API 스캐폴딩

REST 또는 GraphQL API의 보일러플레이트를 생성하세요.

## 프로세스

### 1단계: 요구사항 파악
- API 타입: REST / GraphQL / tRPC
- 리소스/엔티티 정의
- 인증 방식: JWT / OAuth / API Key / None
- 데이터 검증 규칙

### 2단계: 생성 항목
- **라우트/엔드포인트** 정의
- **컨트롤러/리졸버** 로직
- **서비스 레이어** (비즈니스 로직)
- **DTO/스키마** (입출력 타입)
- **미들웨어** (인증, 검증, 에러 핸들링)
- **테스트 파일** (기본 CRUD 테스트)

### 3단계: 프레임워크 감지
프로젝트의 package.json, requirements.txt 등을 분석하여:
- Express / Fastify / Hono / NestJS
- FastAPI / Django / Flask
- Gin / Echo / Fiber
자동 감지 후 해당 패턴으로 생성

## 규칙
- 기존 프로젝트 패턴/스타일 따르기
- 에러 핸들링 포함
- TypeScript 타입 안전성 보장 (해당 시)

$ARGUMENTS
