# Scribble

차트 주석 기반 트레이딩 코파일럿 프로토타입입니다. 현재 시스템은 **차트 주석 → 전략 구조화 → 검증 → 실행 프리뷰/실행 → BSC settlement 추적 → opBNB proof 기록 시도 → audit/notification/history 반영** 흐름을 한 화면과 한 API 서버에서 다루는 상태입니다.

이 문서는 현재 코드베이스의 **실제 동작 기준**으로 업데이트된 운영/인수인계 README입니다. 구현되지 않은 기능을 가정하지 않고, 현재 동작/제약/리스크를 그대로 문서화합니다.

## 1. System Overview

### 현재 아키텍처

- `frontend`: React 19 + TypeScript + Vite 단일 대시보드
- `backend`: Express 5 + TypeScript API 서버
- `execution flow`: 프론트가 `POST /api/v1/executions` 계열 API를 호출하고, 백엔드가 전략 검증/DEX 실행/proof 기록/receipt 추적 상태를 합쳐 응답
- `repository layer`: 실행/감사로그/알림/자동화/위임정책은 repository를 통해 접근
- `persistence`: SQLite + `data/app-state.json` 병행 사용

### 현재 저장 구조

- SQLite DB-backed:
  - executions
  - audit events
  - notifications
  - automations
  - delegated policies
- file-backed only:
  - annotations
  - seed/runtime annotation state
  - 전체 런타임 snapshot 역할의 `data/app-state.json`

### Dual-write / Read-merge 모델

현재 persistence 전환은 **부분 진행 상태**입니다.

- write:
  - repository가 우선 기존 file state를 갱신
  - 이어서 SQLite upsert를 시도
- read:
  - DB 결과를 먼저 읽음
  - 동일 id가 없는 file data를 뒤에 merge

즉, **DB만 단독 source of truth가 아닙니다**. 현재는 compatibility를 위해 file snapshot과 DB가 공존합니다.

## 2. Execution Model

### 실행 라이프사이클

현재 수동 실행 경로는 대략 아래 순서로 동작합니다.

1. 프론트가 `POST /api/v1/executions/preview`로 실행 프리뷰 요청
2. 프론트가 `POST /api/v1/executions`로 실행 승인
3. 백엔드가 `executeStrategy()`로 기본 실행 레코드 생성
4. DEX 설정이 충분하면 BSC DEX swap 시도
5. proof 설정이 충분하면 opBNB proof 기록 시도
6. execution/audit/notification/annotation 상태 갱신
7. 이후 `GET /api/v1/executions`에서 receipt follow-up이 추가 반영될 수 있음

### 핵심 실행 의미 필드

#### `settlement_mode`

- `mock`: DEX 실주문을 보내지 않았거나 fallback 경로를 탔음
- `dex`: DEX 실주문 경로를 시도했고 `dexExecuted`가 true인 케이스

#### `execution_tx_state`

- `not_submitted`
  - DEX settlement를 제출하지 않았음
  - 주로 mock fallback
- `receipt_observed`
  - liquidity tx hash가 보이고 receipt evidence가 있음
- `submitted_receipt_unavailable`
  - DEX 실행은 marked executed지만, usable receipt hash가 아직 없거나 숨겨짐

#### `liquidity_receipt_evidence`

- `mock_fallback`
  - mock 실행이므로 BSC liquidity receipt 없음
- `receipt_observed`
  - usable liquidity tx hash와 receipt evidence가 있음
- `receipt_observed_hash_hidden`
  - receipt evidence는 있었지만 tx hash가 invalid/sanitized 처리됨
- `receipt_not_observed`
  - DEX path는 탔지만 receipt evidence가 아직 없음

#### `liquidity_settlement_state`

- `mock_fallback`
- `pending_receipt`
- `settled_with_swap_event`
- `settled_with_transfer_events`
- `settled_without_decoded_events`
- `reverted`
- `receipt_unavailable`

#### `liquidity_settlement_result`

- `success`
  - receipt success이며 swap/transfer/no-decoded-events 중 하나로 해석 가능
- `failed`
  - receipt reverted
- `unknown`
  - mock fallback, pending receipt, receipt unavailable

### Receipt follow-up 동작

현재 background worker는 없습니다. 대신 두 가지 bounded follow-up이 있습니다.

- on-read refresh:
  - `GET /api/v1/executions` 호출 시 pending/unchecked tx에 대해 bounded refresh 시도
- explicit refresh:
  - `POST /api/v1/executions/:executionId/refresh-receipts`

이 메커니즘이 실행 후 뒤늦게 확인된 receipt 상태를 execution row에 다시 반영합니다.

## 3. Proof Handling

### 현재 proof 처리

- proof는 `onchainExecutionService`를 통해 opBNB `ExecutionRegistry`에 기록 시도
- `recordOnchainExecution()`은 strategy register/trigger/result recording까지 포함
- result recording은 내부적으로 짧은 retry를 사용
- proof 실패는 **non-fatal**
  - 실행 전체를 무조건 실패로 만들지 않음
  - proof 실패 정보는 execution row에 남김

### `proof_state`

- `not_attempted`
  - proof context 자체가 없음
- `attempted_not_recorded`
  - proof 시도는 했지만 usable recorded proof result가 없음
- `recorded`
  - proof result tx hash까지 확인된 상태

### proof 관련 필드

- `proof_attempted`
- `proof_retry_count`
- `proof_error_message`
- `proof_recorded`
- `proof_state`
- `proof_registry_id`
- `proof_contract_address`

### Proof retry

명시적 수동 retry endpoint가 있습니다.

- `POST /api/v1/executions/:executionId/retry-proof`

이 endpoint는:

- proof recording만 다시 시도
- `proof_retry_count` 갱신
- `proof_state` 갱신
- `proof_error_message` 갱신
- execution tx metadata 갱신

제한:

- background retry 없음
- 자동 scheduler 없음
- 사용자가 명시적으로 호출해야 함

## 4. Persistence Layer

### Repository 역할

현재 주요 runtime entity는 repository를 통해 접근합니다.

- `ExecutionRepository`
- `AuditRepository`
- `NotificationRepository`
- `AutomationRepository`
- `DelegatedPolicyRepository`

repository의 목적:

- route code가 file store 구현에 직접 묶이지 않게 분리
- SQLite 도입을 점진적으로 할 수 있게 seam 제공
- read/write merge 정책을 한 곳에서 관리

### DB-backed / File-backed 범위

#### DB-backed

- executions
- audit events
- notifications
- automations
- delegated policies
- tx receipt summary index

#### File-backed only

- annotations
- runtime seed annotations
- 최종 fallback snapshot 역할의 `data/app-state.json`

### Read priority

현재 repository 기본 패턴:

1. DB list/get 시도
2. 실패 또는 누락 시 file fallback
3. id 기준 merge

### Migration 상태

- partial migration only
- destructive migration 없음
- historical file data를 강제로 DB로 옮기지 않음
- runtime compatibility를 위해 file snapshot 유지

## 5. Session / Ownership Model

### 현재 모델

백엔드는 lightweight partitioning 용도로 `X-Session-Id`를 사용합니다.

- 프론트는 client session id를 생성해서 요청 헤더에 자동 첨부
- backend는 request context middleware에서 sanitization 후 저장
- execution/notification/audit 일부 read path는 session id 기준 필터링

### execution ownership

- 새 execution 생성 시 `sessionId`가 execution row에 저장됨
- `GET /api/v1/executions`는 session id가 있으면 해당 세션 execution만 반환
- session id가 없으면 backward-compatible shared view를 유지

### 중요한 주의

이 모델은 **인증(authentication)이 아닙니다**.

- 권한 시스템 아님
- 보안 boundary 아님
- 단순한 lightweight partitioning 용도

## 6. API Endpoints

### `POST /api/v1/executions`

목적:

- 전략 수동 실행
- mock 또는 dex settlement 수행
- proof 시도
- execution/audit/notification 반영

주요 응답 필드:

- `execution_id`
- `action_type`
- `status`
- `settlement_mode`
- `execution_tx_state`
- `liquidity_receipt_evidence`
- `liquidity_settlement_state`
- `liquidity_settlement_result`
- `proof_state`
- `proof_attempted`
- `proof_retry_count`
- `proof_error_message`

### `GET /api/v1/executions`

목적:

- 실행 이력 조회
- session-aware filtering
- on-read receipt refresh 반영

주요 응답 필드:

- `settlement_mode`
- `execution_tx_state`
- `liquidity_receipt_evidence`
- `liquidity_settlement_state`
- `liquidity_settlement_result`
- `proof_state`
- `action_type`
- `close_mode`
- receipt block/log metadata

### `POST /api/v1/executions/:executionId/refresh-receipts`

목적:

- 특정 execution에 대해 BSC/opBNB receipt를 명시적으로 다시 조회
- execution row를 최신 receipt 정보로 보정

주요 응답 필드:

- `execution_tx_state`
- `liquidity_receipt_evidence`
- `liquidity_settlement_state`
- `liquidity_settlement_result`
- `execution_chain_tx_status`
- `liquidity_chain_tx_status`

### `POST /api/v1/executions/:executionId/retry-proof`

목적:

- proof recording을 수동 재시도

주요 응답 필드:

- `proof_attempted`
- `proof_retry_count`
- `proof_error_message`
- `proof_recorded`
- `proof_state`
- `execution_chain_tx_status`

### 추가로 현재 존재하는 관련 endpoint

- `POST /api/v1/annotations/:annotationId/cancel-order`
- `POST /api/v1/annotations/:annotationId/close-position`
- `GET /api/v1/tx-receipts/:txHash?chain=bsc|opbnb`

## 7. Settlement Interpretation

현재 settlement 해석은 full event decoding이 아닙니다. 아래 신호를 조합합니다.

- tx receipt status
- tx block number / log count
- ERC20 `Transfer` topic count
- UniswapV2-style `Swap` topic count

이 정보를 기반으로 compact meaning을 만듭니다.

- `success`
- `failed`
- `unknown`

중요:

- full decoded output amount parsing은 하지 않음
- router/pair/token별 도메인 의미를 전부 파싱하지 않음
- topic-based detection이므로 incomplete할 수 있음

## 8. Logging and Observability

현재는 lightweight structured logging만 있습니다.

### 포함되는 것

- request-completion log
- execution success/failure log
- API error response log

### 주요 필드

- `requestId`
- `sessionId` when available
- `executionId` when available
- method/path/status/duration

### 현재 한계

- metrics 없음
- tracing 없음
- centralized log pipeline 없음
- persistent ops event store 없음

## 9. Safety and Risk Notes

이 섹션은 중요합니다.

- DEX execution은 실제 자금을 움직일 수 있습니다.
- RPC availability가 receipt/proof correctness에 직접 영향 줍니다.
- receipt tracking은 bounded refresh 기반이라 incomplete할 수 있습니다.
- proof retry는 manual endpoint 호출이 필요합니다.
- fallback behavior는 UX를 살리지만, 실패를 `mock` 또는 `unknown` 상태로 감출 수 있습니다.
- `data/app-state.json`은 fixture가 아니라 실제 runtime snapshot입니다.
- `.env`는 로컬 전용입니다. private key / RPC key / API key는 절대 커밋하지 마세요.
- 테스트넷, 소액, 격리된 지갑 기준으로 검증하는 것을 강하게 권장합니다.

## 10. Known Limitations

- background polling 없음
- full contract-event indexing 없음
- full DB migration 아님
- authentication system 없음
- full settlement decoding 없음
- annotations는 아직 DB-backed가 아님
- onchain verification은 환경(solc/RPC/testnet) 의존적
- explicit price-based close는 현재 “수동 close 기록”이지, future trigger 엔진이 아님
- UI의 자산/포지션 표시는 실제 거래소 계정 ledger가 아니라 앱 내부 execution/annotation 해석 기준임

## 11. Development Guidelines

작업 시 아래 원칙을 유지하세요.

- fallback behavior를 가볍게 제거하지 말 것
- DB만 source of truth라고 가정하지 말 것
- heavy infra(queue/scheduler/indexer)를 필요 이상으로 도입하지 말 것
- execution semantics를 일관되게 유지할 것
- `settlement_mode`, `execution_tx_state`, `proof_state` 같은 read-model 의미를 깨지 말 것
- API backward compatibility를 가능한 한 유지할 것
- runtime JSON state를 fixture처럼 다루지 말 것
- DEX/onchain 변경은 항상 real-funds-risk 관점에서 review할 것

## 12. Next Steps

### Must-have

- annotations persistence를 어떻게 DB로 옮길지 안전한 단계 설계
- receipt/event decoding을 더 정확하게 확장
- receipt follow-up의 bounded explicit refresh 정책 정리
- onchain integration 검증 환경 안정화

### Nice-to-have

- background receipt tracking
- richer decoded settlement summaries
- full contract-event query/index layer
- optional UI polish

## 13. Local Development Quick Start

### 최초 세팅

```zsh
cp .env.example .env
npm install
```

### 개발 서버 실행

백엔드:

```zsh
npm run dev:api
```

프론트:

```zsh
npm run dev:web
```

### 접속 주소

- 웹: `http://127.0.0.1:5173` 또는 Vite가 표시하는 로컬 주소
- API: `http://localhost:8787`
- health: `http://localhost:8787/api/v1/health`

## 14. Useful Commands

### 개발

```zsh
npm run dev:api
npm run dev:web
```

### 타입체크

```zsh
node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit
```

### 테스트

```zsh
node node_modules/vitest/vitest.mjs run test/dexExecutionService.test.ts test/strategy.test.ts test/llmService.test.ts test/marketDataService.test.ts
```

### 컨트랙트 배포

```zsh
npm run deploy:registry
```

## 15. Current README Priority Backlog

현재 구현 상태를 반영한 남은 우선순위입니다.

### Product

1. DEX execution result receipt/event tracking
   - mostly complete
2. DB persistence transition
   - partial migration complete, annotations remain
3. User/session separation
   - lightweight partitioning complete enough for prototype
4. Operational logging and error tracking
   - lightweight structured logs complete enough for prototype

### UI

1. Annotation bubble hover expansion
   - implemented enough
2. Responsive layout improvements
   - implemented enough
3. Execution history filter/sort
   - implemented
4. Strategy detail editing UX improvements
   - partially implemented

### Infra / Onchain

1. Proof failure retry policy
   - basic manual retry implemented
2. Tx status polling / receipt tracking
   - on-read + explicit refresh implemented, no worker
3. BSC settlement step real implementation
   - partial; summary-level only
4. Contract-event-based indexing
   - minimal receipt summary index only

## 16. Environment Variables

민감값은 절대 커밋하지 마세요. `.env`는 로컬 전용입니다.

### 시장 데이터

- `ENABLE_REAL_MARKET_DATA`
- `MARKET_DATA_PROVIDER`
- `MARKET_DATA_BASE_URL`
- `MARKET_DATA_WS_BASE_URL`
- `MARKET_STREAM_INTERVAL_MS`

### 프론트 explorer 링크

- `VITE_API_BASE_URL`
- `VITE_OPBNB_EXPLORER_BASE_URL`

### onchain proof

- `ENABLE_ONCHAIN_PROOF`
- `OPBNB_RPC_URL`
- `EXECUTOR_PRIVATE_KEY`
- `EXECUTION_REGISTRY_ADDRESS`

### DEX execution

- `ENABLE_DEX_EXECUTION`
- `BSC_RPC_URL`
- `DEX_ROUTER_ADDRESS`
- `DEX_SLIPPAGE_BPS`
- `DEX_DEADLINE_SECONDS`
- `DEX_MARKET_MAP_JSON`

### fallback

- LLM 설정이 없으면 fallback 분석 사용
- Binance 데이터가 실패하면 mock 시세 사용
- onchain 설정이 부족하면 proof는 스킵하고 execution은 계속 진행
- DEX 설정이 부족하면 mock execution fallback 사용
