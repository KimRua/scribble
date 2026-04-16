# Scribble

`Scribble`은 차트 위에 전략을 메모하고, 그 메모를 구조화된 전략으로 다듬은 뒤, 연결한 지갑으로 직접 Hyperliquid testnet 주문까지 보낼 수 있는 트레이딩 워크스페이스입니다.

현재 기준 핵심 흐름은 아래와 같습니다.

- 차트 주석 생성 및 편집
- AI 기반 전략 초안 생성
- 전략 검증 및 리스크 요약
- 브라우저 지갑 연결
- Hyperliquid testnet 선물 주문 직접 서명
- 실행 이력 / 대기 주문 / 포지션 / 알림 / 감사 로그 추적

## 기능 요약

### 지원 기능

- 차트 annotation 생성 및 수정
- 추세선, 수평선, 박스, 텍스트 메모 추가
- AI 분석 기반 전략 초안 생성
- 진입가 / 손절가 / 익절가 / 포지션 크기 / 레버리지 편집
- 리스크 검증 및 요약
- Hyperliquid testnet 직접 주문
  - 시장가 진입
  - 지정가 진입
  - 조건부(trigger) 진입
  - 롱 / 숏
  - 레버리지 설정
  - 시장가 reduce-only 청산
  - 지정가 reduce-only 청산
  - 대기 주문 취소
- 알림 등록
- 실행 히스토리 / 오픈 포지션 / 대기 주문 조회
- delegated automation 설정 UI
- 선택적으로 BSC DEX / opBNB proof 연동

### 현재 기본 실행 모델

- **기본 실주문 경로는 서버 비밀키가 아니라 연결한 브라우저 지갑입니다.**
- 프론트엔드가 Hyperliquid testnet API에 직접 접근합니다.
- 사용자가 브라우저 지갑에서 EIP-712 서명을 수행합니다.
- 백엔드는 execution / annotation / audit / notification 상태를 저장하고 갱신합니다.

## 기술 스택

### 프론트엔드

- React 19
- TypeScript
- Vite

### 백엔드

- Express 5
- TypeScript
- Zod

### 저장 방식

- SQLite 기반 repository
- `data/app-state.json` 파일 스냅샷 병행 유지

## 빠른 시작

### 요구 사항

- Node.js 20+
- npm
- 브라우저 지갑 확장 프로그램

### 설치

```bash
npm install
```

### 환경변수 준비

```bash
cp .env.example .env
```

최소 실행 기준으로는 아래만 먼저 보면 됩니다.

- `VITE_API_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

OpenAI를 비워두면 AI 분석은 fallback 동작을 사용합니다.

### 개발 서버 실행

터미널 1:

```bash
npm run dev:api
```

터미널 2:

```bash
npm run dev:web
```

기본 주소:

- 웹: `http://localhost:5173`
- API: `http://localhost:8787`
- 헬스체크: `http://localhost:8787/api/v1/health`

### 테스트 / 빌드

```bash
npm test
npm run build
```

## 앱 사용 순서

### 1. 지갑 연결

- 앱 상단에서 브라우저 지갑을 연결합니다.
- 연결된 주소 기준으로 annotation / execution 데이터가 구분됩니다.

### 2. 전략 만들기

- 직접 annotation 생성 또는 AI 분석 요청
- 우측 패널에서 전략 필드 수정
  - bias
  - entry type
  - entry / stop loss / take profit
  - position size ratio
  - leverage

### 3. 주문 실행

- `Execute order`: 현재 `entryType` 기준으로 실행
- `Conditional order`: trigger 주문으로 실행
- `Set alert`: 알림만 등록
- `Auto-execute`: 자동화 정책 설정

### 4. 포지션 관리

- 오픈 포지션 확인
- 시장가 또는 지정가 reduce-only 청산
- 대기 주문 / 대기 청산 주문 취소

## 화면 구성

### `ChartCanvas`

- 캔들 차트
- annotation 선택 / 생성
- AI 분석 진입점
- 드로잉 객체 추가

### `RightPanel`

- 전략 상세 편집
- 리스크 요약
- annotation 텍스트 수정
- 대기 주문 취소
- 포지션 청산

### `BottomActionBar`

- 빠른 실행 버튼
- 주문 / 조건부 주문 / 알림 / 자동화 진입

### `ExecutionModal`

- 실행 프리뷰
- 예상 슬리피지 / 수수료 / 리스크 확인
- 실제 주문 승인

### `ExecutionHistoryPanel`

- executions
- positions
- orders

## 환경변수 설명

`.env`는 로컬 전용입니다. private key, RPC URL, API key는 절대 커밋하지 마세요.

### 프론트엔드

- `VITE_API_BASE_URL`: 프론트엔드가 호출할 API 주소
- `VITE_OPBNB_EXPLORER_BASE_URL`: opBNB explorer 링크 베이스 URL

### 서버 기본 설정

- `API_PORT`: API 서버 포트
- `MARKET_STREAM_INTERVAL_MS`: SSE market stream 주기

### 시세 / AI

- `ENABLE_REAL_MARKET_DATA`
- `MARKET_DATA_PROVIDER`
- `MARKET_DATA_BASE_URL`
- `MARKET_DATA_WS_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_BASE_URL`

### 선택 기능

#### Hyperliquid server-side fallback / legacy 경로

- `ENABLE_HYPERLIQUID_TESTNET_EXECUTION`
- `HYPERLIQUID_TESTNET_PRIVATE_KEY`
- `HYPERLIQUID_TESTNET_WALLET_ADDRESS`
- `HYPERLIQUID_TESTNET_AUTO_TRANSFER`

현재 UX의 기본 경로는 지갑 직접 서명이지만, 서버 측 Hyperliquid 경로 코드는 여전히 남아 있습니다.

#### opBNB proof

- `ENABLE_ONCHAIN_PROOF`
- `OPBNB_RPC_URL`
- `EXECUTION_REGISTRY_ADDRESS`
- `EXECUTOR_PRIVATE_KEY`

#### BSC DEX 실행

- `ENABLE_DEX_EXECUTION`
- `BSC_RPC_URL`
- `DEX_ROUTER_ADDRESS`
- `DEX_SLIPPAGE_BPS`
- `DEX_DEADLINE_SECONDS`
- `DEX_MARKET_MAP_JSON`

#### delegated automation

- `DELEGATED_EXECUTOR_ADDRESS`
- `DELEGATION_VAULT_ADDRESS`

## 상태값 해석

### Annotation 상태

- `Draft`: 초안
- `Active`: 활성 전략 또는 지정가 대기 전략
- `Triggered`: 조건부 전략이 주문 상태로 진입함
- `Executed`: 포지션 오픈됨
- `Closed`: 포지션 종료됨
- `Invalidated`: 전략 또는 대기 주문이 취소/무효화됨

### Execution 상태

- `Pending`: 거래소에 대기 주문 등록됨
- `Executing`: 실행 중
- `Filled`: 체결 완료
- `PartiallyFilled`: 부분 체결
- `Cancelled`: 취소됨
- `Failed`: 실패

### Settlement mode

- `perp_dex`: Hyperliquid testnet 선물 주문
- `dex`: BSC DEX 실행 경로
- `mock`: 로컬 / 모의 실행 경로

## 주요 스크립트

```bash
npm run dev
npm run dev:web
npm run dev:api
npm run build
npm run test
npm run preview
```

## 프로젝트 구조

```text
src/
  components/        UI 컴포넌트
  services/          프론트 API / 지갑 / 직실행 서비스
  utils/             전략 계산 및 보조 함수
  data/              기본 mock 데이터
server/
  services/          실행 / 저장소 / 마켓데이터 / proof 서비스
  utils/             서버 유틸리티
data/
  app-state.json     파일 기반 런타임 스냅샷
  app-state.sqlite   SQLite 저장소
```

## 주의사항

- 기본 실주문은 **연결한 브라우저 지갑**으로 수행됩니다.
- proof recording과 DEX execution은 선택 기능입니다.
- SQLite와 `data/app-state.json`이 공존하므로 완전한 DB-only 구조는 아닙니다.
- 일부 기능은 테스트넷 전제입니다.
- 별도 인증 시스템이 있는 서비스가 아니라, 현재는 연결 지갑 / 세션 중심의 워크스페이스 모델입니다.

## 추천 시작 시나리오

1. `npm install`
2. `cp .env.example .env`
3. 필요하면 `OPENAI_API_KEY`, `OPENAI_MODEL` 입력
4. `npm run dev:api`
5. `npm run dev:web`
6. 브라우저에서 지갑 연결
7. annotation 생성 또는 AI 분석 요청
8. Hyperliquid testnet에서 시장가 / 지정가 / 조건부 주문 테스트

## 라이선스

별도 라이선스가 지정되지 않은 내부 / 실험용 프로젝트 기준으로 관리 중입니다.
