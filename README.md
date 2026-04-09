# Scribble

차트 주석 기반 트레이딩 코파일럿의 실행 가능한 프로덕트 베이스입니다.

## 현재 구현 범위

- React 기반 차트/주석/전략 편집 UI
- Express 기반 실제 API 서버
- 파일 영속 저장소 (`data/app-state.json`)
- AI 분석/주석 파싱의 `LLM 우선 + fallback` 구조
- 실행 프리뷰 / 주문 실행 / 자동화 / 알림 / 감사 로그 API
- opBNB proof 레이어 샘플 `ExecutionRegistry` 컨트랙트

## 빠른 시작

1. `.env.example`을 참고해 `.env`를 만듭니다.
2. 의존성을 설치합니다.
3. API 서버와 웹 앱을 각각 실행합니다.

```zsh
cp .env.example .env
npm install
npm run dev:api
npm run dev:web
```

웹 앱 기본 주소: `http://localhost:5173`

API 기본 주소: `http://localhost:8787`

## 환경 변수

### 지금 바로 있으면 좋은 값

- `OPENAI_API_KEY`: 실제 AI 분석 사용 시 필요
- `OPENAI_MODEL`: 예: `gpt-4.1-mini`, `gpt-4o-mini` 등 JSON 응답 가능한 모델

### 다음 단계 실주문/온체인 연동 시 필요

- `OPBNB_RPC_URL`
- `BSC_RPC_URL`
- `EXECUTOR_PRIVATE_KEY`

키가 없으면 앱은 fallback 분석기로 계속 동작합니다.

## 테스트 및 빌드

```zsh
npm test
npm run build
```

## 주요 경로

- `src/components/TradingPage.tsx`: 메인 트레이딩 UX
- `src/services/apiClient.ts`: 프론트 API 클라이언트
- `server/index.ts`: 백엔드 API 엔트리포인트
- `server/services/llmService.ts`: 실제 LLM/fallback 분석 계층
- `contracts/ExecutionRegistry.sol`: opBNB proof 레이어 컨트랙트

## 현재 한계

- 가격 데이터는 아직 데모용 생성 데이터입니다.
- 주문 실행은 실거래소/DEX에 연결되지 않았습니다.
- 온체인 기록은 컨트랙트 샘플과 ABI 검증까지 구현되어 있고, 실제 체인 송신은 다음 단계입니다.

## 다음 완성 단계

1. 실마켓 데이터 provider 연결
2. 실제 LLM 키 주입
3. opBNB/BSC RPC 및 실행 지갑 연결
4. 주문 실행기와 온체인 proof 결합
