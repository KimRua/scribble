# Scribble

차트 주석 기반 트레이딩 코파일럿 프로토타입입니다. 현재는 **차트 주석 → 전략 구조화 → 검증 → 실행 프리뷰/실행 → DEX 체결(opportunistic) → audit/proof 기록** 흐름을 한 화면에서 다룰 수 있는 상태입니다.

이 문서는 휴가/인수인계 상황을 기준으로, 다른 개발자가 바로 이어받아 작업할 수 있도록 정리한 운영용 README입니다.

## 1. 프로젝트 요약

Scribble은 트레이더가 차트에 텍스트/라인/박스로 생각을 남기면, 이를 전략 형태로 구조화하고 AI·가드레일·실행·온체인 proof까지 이어주는 제품을 목표로 합니다.

현재 구현된 핵심은 아래와 같습니다.

- React 기반 단일 대시보드 UI
- Express 기반 API 서버
- 파일 기반 영속 저장소 (`data/app-state.json`)
- OpenAI 호환 LLM 분석 + fallback 분석 경로
- Binance REST + WebSocket + SSE 기반 시세 스트림
- 실행 프리뷰 / 주문 실행 / 자동화 / 알림 / 감사 로그
- 설정 기반 UniswapV2 계열 DEX 실주문 경로(BSC)
- opBNB `ExecutionRegistry` 기반 onchain proof 기록
- 새로고침 후에도 마지막 실행 proof 상태 복원

## 2. 기술 스택

- `frontend`: React 19, TypeScript, Vite
- `backend`: Express 5, Zod, TSX
- `market data`: Binance REST, Binance WebSocket, SSE 브리지
- `llm`: OpenAI-compatible Chat Completions
- `onchain`: Solidity, `ethers`, `solc`
- `testing`: Vitest
- `storage`: JSON file store

## 3. 현재 제품 상태

### 구현 완료 범위

- 차트 렌더링 및 주석 작성
- AI 분석을 통한 전략 초안 생성
- 전략 수동 수정 및 validation
- 실행 프리뷰와 실행 API
- 자동 실행(guardrail 기반) 설정 API
- 실시간 시장 데이터 수신
- execution proof를 opBNB에 기록하는 백엔드 경로
- 실행 결과/히스토리 UI와 explorer 링크 노출
- 설정 시 BSC에서 DEX swap 기반 실주문 실행

### 아직 mock 또는 미완성인 범위

- BSC 유동성 체결 엔진
- 사용자 인증 / 권한 / 멀티유저
- DB 영속화
- 운영용 관측성(로그 수집, metrics, tracing)

## 4. 로컬 실행 빠른 시작

### 4-1. 최초 세팅

```zsh
cp .env.example .env
npm install
```

### 4-2. 개발 서버 실행

서버는 **반드시 별도 터미널 2개**에서 실행하는 것을 권장합니다.

```zsh
npm run dev:api
```

```zsh
npm run dev:web -- --host 127.0.0.1 --port 5173
```

### 4-3. 접속 주소

- 웹: `http://127.0.0.1:5173`
- API: `http://localhost:8787`
- 헬스 체크: `http://localhost:8787/api/v1/health`

## 5. 자주 쓰는 명령어

### 개발

```zsh
npm run dev:api
npm run dev:web -- --host 127.0.0.1 --port 5173
```

### 검증

```zsh
npm test
npm run build
```

### 컨트랙트 배포

```zsh
npm run deploy:registry
```

## 6. 환경 변수 설명

민감값은 절대 커밋하지 마세요. `.env`는 로컬 전용입니다.

### 필수에 가까운 값

- `VITE_API_BASE_URL`: 프론트에서 호출할 API 주소
- `API_PORT`: Express 포트, 기본 `8787`
- `OPENAI_API_KEY`: 실제 LLM 사용 시 필요
- `OPENAI_MODEL`: 예: `gpt-5.4`, `gpt-4.1-mini`, `gpt-4o-mini`

### 시장 데이터 관련

- `ENABLE_REAL_MARKET_DATA`: `false`면 mock 시세만 사용
- `MARKET_DATA_PROVIDER`: 현재 `binance`만 지원
- `MARKET_DATA_BASE_URL`: 기본 `https://api.binance.com`
- `MARKET_DATA_WS_BASE_URL`: 기본 `wss://stream.binance.com:9443/ws`
- `MARKET_STREAM_INTERVAL_MS`: SSE push 주기(ms)

### 프론트 explorer 링크

- `VITE_OPBNB_EXPLORER_BASE_URL`: 기본 `https://opbnb-testnet.bscscan.com`

### onchain proof 관련

- `ENABLE_ONCHAIN_PROOF`: `true`면 proof 기록 시도
- `OPBNB_RPC_URL`: proof 레이어 RPC
- `BSC_RPC_URL`: 현재 future use 성격이 큼
- `EXECUTOR_PRIVATE_KEY`: proof 트랜잭션 서명용 키
- `EXECUTION_REGISTRY_ADDRESS`: 배포된 `ExecutionRegistry` 주소

### DEX 실주문 관련

- `ENABLE_DEX_EXECUTION`: `true`일 때 BSC DEX 실주문 시도
- `DEX_ROUTER_ADDRESS`: UniswapV2/PancakeSwap 호환 라우터 주소
- `DEX_SLIPPAGE_BPS`: 허용 슬리피지 (기본 `100` = 1%)
- `DEX_DEADLINE_SECONDS`: 스왑 deadline (기본 `300`)
- `DEX_MARKET_MAP_JSON`: 마켓 심볼과 토큰 주소/decimals/amount/path 설정

테스트넷에서 바로 시도할 수 있는 기본 예시는 아래 조합입니다.

- `DEX_ROUTER_ADDRESS`: PancakeSwap v2 BSC testnet router `0xD99D1c33F9fC3444f8101754aBC46c52416550D1`
- `BNBUSDT.baseTokenAddress`: WBNB testnet `0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd`
- `BNBUSDT.quoteTokenAddress`: BUSD testnet `0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee`

현재 저장소의 기본 마켓 중에서는 **`BNBUSDT`가 테스트넷 DEX 데모에 가장 현실적**입니다. `BTCUSDT`, `ETHUSDT`는 직접 사용할 토큰 주소를 별도로 검증해 넣는 것을 권장합니다.

### fallback 동작

- LLM 설정이 없으면 fallback 분석 사용
- Binance 데이터가 실패하면 mock 시세 사용
- onchain 설정이 부족하면 execution은 진행하되 proof는 로컬 로그만 남김
- DEX 설정이 부족하면 execution은 기존 mock 체결로 fallback

## 7. 저장 파일과 런타임 상태

### `data/app-state.json`

현재 런타임 저장소입니다.

포함되는 데이터:

- annotations
- notifications
- auditEvents
- automations
- executions

주의사항:

- 개발 중 API를 호출하면 계속 변경됩니다.
- 보통 커밋 대상이 아닙니다.
- 테스트 fixture가 아니라 실제 런타임 스냅샷입니다.

## 8. 프로젝트 구조

### 프론트 핵심

- `src/components/TradingPage.tsx`: 메인 화면 상태 오케스트레이션
- `src/components/ChartCanvas.tsx`: 캔들/주석 렌더링
- `src/components/RightPanel.tsx`: 전략 세부 편집
- `src/components/ExecutionModal.tsx`: 실행 프리뷰/승인
- `src/components/ExecutionHistoryPanel.tsx`: 최근 실행 이력 + proof 링크
- `src/components/HeaderBar.tsx`: 상단 요약/컨트롤
- `src/services/apiClient.ts`: 프론트 API 레이어

### 백엔드 핵심

- `server/index.ts`: 모든 API 엔트리포인트
- `server/services/fileStore.ts`: JSON 상태 저장소
- `server/services/llmService.ts`: LLM/fallback 분석
- `server/services/marketDataService.ts`: 시장 데이터 조회와 WS 캐시
- `server/services/dexExecutionService.ts`: BSC DEX 실주문 서비스
- `server/services/onchainExecutionService.ts`: onchain proof 기록

### 컨트랙트/스크립트

- `contracts/ExecutionRegistry.sol`: proof registry 샘플 컨트랙트
- `scripts/deployExecutionRegistry.ts`: 배포 스크립트

### 문서

- `docs/architecture.md`: 아키텍처 개요
- `docs/onchain.md`: onchain proof 설명

## 9. 데이터 흐름 요약

### 9-1. 차트/전략 흐름

1. 사용자가 차트에 주석 생성
2. 백엔드가 자연어를 strategy 구조로 파싱
3. 프론트에서 strategy를 수정/검증
4. preview 또는 execution 실행
5. audit / notification / execution history 반영

### 9-2. 시장 데이터 흐름

1. 초기 캔들은 REST로 로드
2. 백엔드는 Binance WebSocket으로 실시간 kline 캐시 유지
3. 프론트는 `/api/v1/market-data/stream` SSE 구독
4. 프론트 차트는 SSE payload로 갱신

### 9-3. onchain proof 흐름

1. `/api/v1/executions` 호출
2. DEX 설정이 충분하면 BSC 라우터에 실제 swap 트랜잭션 전송
3. DEX 설정이 없으면 mock execution으로 fallback
4. 이후 설정이 충분하면 `onchainExecutionService`가 `ExecutionRegistry` 호출
5. 결과 tx hash / registry id / contract address 저장
6. 프론트에서 proof badge, explorer 링크, execution history 표시

## 10. 주요 API 엔드포인트

### 상태/시장

- `GET /api/v1/health`
- `GET /api/v1/markets`
- `GET /api/v1/market-data/candles`
- `GET /api/v1/market-data/stream`

### 주석/전략/AI

- `GET /api/v1/annotations`
- `POST /api/v1/annotations`
- `PATCH /api/v1/annotations/:annotationId`
- `POST /api/v1/ai/analyze`
- `POST /api/v1/ai/parse-annotation`
- `POST /api/v1/strategies/:strategyId/validate`

### 실행/자동화

- `POST /api/v1/executions/preview`
- `GET /api/v1/executions`
- `POST /api/v1/executions`
- `POST /api/v1/automations`

### 알림/감사 로그

- `POST /api/v1/alerts`
- `GET /api/v1/notifications`
- `GET /api/v1/audit-logs`

## 11. 지금 확인하면 좋은 화면 포인트

브라우저에서 다음 항목을 확인하면 현재 상태를 빠르게 파악할 수 있습니다.

- 상단 overview 카드: market / AI / onchain / selection
- 상태 스트립: lifecycle / execution / automation
- execution history 패널: 최근 proof 기록과 링크
- execution history 패널: 최근 proof 기록과 DEX/mock 체결 결과
- 우측 패널: 선택된 전략의 validation과 audit trail
- 차트 주석 버블: 길이가 긴 텍스트도 이전보다 덜 잘리도록 수정됨

## 12. 트러블슈팅

### 새로고침하면 안 뜨는 경우

대부분 `vite` dev 서버가 내려간 경우입니다.

```zsh
npm run dev:web -- --host 127.0.0.1 --port 5173
```

### API는 뜨는데 웹이 안 뜨는 경우

포트 확인:

```zsh
lsof -nP -iTCP:5173 -sTCP:LISTEN
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

### health 응답은 오는데 `onchainConfigured=false`

아래 값 중 하나 이상이 비어 있을 가능성이 큽니다.

- `ENABLE_ONCHAIN_PROOF=true`
- `OPBNB_RPC_URL`
- `EXECUTOR_PRIVATE_KEY`
- `EXECUTION_REGISTRY_ADDRESS`

### DEX 실주문이 동작하지 않는 경우

- `ENABLE_DEX_EXECUTION=true`인지 확인
- `DEX_ROUTER_ADDRESS`, `DEX_MARKET_MAP_JSON`, `BSC_RPC_URL`, `EXECUTOR_PRIVATE_KEY` 확인
- 실행 지갑이 `inputToken` 잔고와 allowance를 충분히 가지고 있는지 확인
- `DEX_MARKET_MAP_JSON`의 symbol 키가 현재 UI의 마켓 심볼(`BTCUSDT` 등)과 정확히 일치하는지 확인
- BSC testnet에서는 **실제 풀이 없거나 유동성이 매우 얕을 수 있으므로** 주소가 맞아도 스왑이 실패할 수 있음

### 테스트넷 예시 설정

아래 예시는 `BNBUSDT` 전략을 선택했을 때, BUSD → WBNB 매수 또는 WBNB → BUSD 매도 스왑을 시도하는 샘플입니다.

```zsh
ENABLE_DEX_EXECUTION=true
DEX_ROUTER_ADDRESS=0xD99D1c33F9fC3444f8101754aBC46c52416550D1
DEX_SLIPPAGE_BPS=100
DEX_DEADLINE_SECONDS=300
DEX_MARKET_MAP_JSON={"BNBUSDT":{"baseTokenAddress":"0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd","quoteTokenAddress":"0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee","baseTokenDecimals":18,"quoteTokenDecimals":18,"buyAmount":"10","sellAmount":"0.02"}}
```

이 예시는 실행 지갑이 아래 중 하나를 보유하고 있다는 가정입니다.

- bullish 전략: `BUSD` 잔고 필요
- bearish 전략: `WBNB` 잔고 필요

### 시장 데이터가 안 들어오는 경우

- Binance API/WS 차단 여부 확인
- `.env`의 `ENABLE_REAL_MARKET_DATA` 확인
- 실패 시 mock 데이터로 fallback 되는 것이 정상 동작일 수 있음

### LLM이 동작하지 않는 경우

- `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` 확인
- 응답 실패 시 fallback 분석으로 동작하는 것이 정상

## 13. 개발 시 주의사항

- `npm run build`와 dev 서버 실행은 별도 터미널에서 관리하는 것이 안전합니다.
- `.env`, 개인키, API 키는 절대 커밋하지 마세요.
- `data/app-state.json`은 런타임 상태 파일이라 변경이 잦습니다.
- 현재 브랜치의 원격 upstream 설정이 깨져 있을 수 있으니 push 전에 확인하세요.
- DEX 실주문은 **설정이 켜져 있으면 실제 자금 이동**이 발생하므로 테스트넷/소액 지갑으로만 먼저 확인하세요.

## 14. 보안 메모

이 프로젝트는 대화/개발 과정에서 민감정보가 노출된 이력이 있으므로, 실제 운영 전 아래를 권장합니다.

- OpenAI API 키 교체
- 실행 지갑 private key 교체
- RPC key 교체 또는 재발급
- `.env` 재정비 후 최소 권한 키만 사용
- DEX 실주문용 지갑은 운영 자금과 분리된 전용 지갑 사용 권장

## 15. 다음 작업 우선순위 제안

### 제품 측면

1. DEX 실주문 결과 receipt/이벤트 추적 강화
2. DB 영속화 전환
3. 사용자/세션 분리
4. 운영 로그 및 에러 추적 추가

### UI 측면

1. 주석 버블 hover 확장
2. 반응형 레이아웃 보강
3. 실행 히스토리 필터/정렬 추가
4. 전략 상세 편집 UX 개선

### infra/onchain 측면

1. proof 실패 재시도 정책
2. tx 상태 polling 또는 receipt 추적
3. BSC settlement 단계 실제 구현
4. 컨트랙트 이벤트 기반 인덱싱

## 16. 인수인계 체크리스트

다른 개발자가 작업 시작 전에 아래만 확인하면 됩니다.

- `.env`를 로컬에서 새로 구성했는가
- `npm install`이 끝났는가
- `npm run dev:api` / `npm run dev:web -- --host 127.0.0.1 --port 5173`가 뜨는가
- `GET /api/v1/health`가 성공하는가
- 차트 로드 / AI 분석 / execution preview / execution history가 보이는가
- `npm test`, `npm run build`가 통과하는가
