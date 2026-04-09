# Scribble MVP Architecture

## Frontend

- `TradingPage` 중심 단일 화면 UX
- 차트, 주석, 전략 패널, 실행/자동화 모달, 알림 드로어 포함
- React + TypeScript + Vite 기반

## Domain Flow

1. Annotation 생성 또는 AI 분석 요청
2. Strategy 구조화 / validation
3. Preview / Alert / Automation 연결
4. Status transition 시뮬레이션
5. Audit + Notification 이벤트 적재

## Services

- `aiService`: AI 주석/전략 초안 생성
- `parserService`: 자연어 → 전략 추론
- `executionService`: preview / execute / automation simulation
- `auditLogService`: 사용자 액션, 상태 전이 이벤트 기록

## Onchain

- `ExecutionRegistry`는 opBNB proof 레이어 역할
- 실제 execution은 off-chain service + BSC liquidity settlement 가정
