# Scribble

차트 주석 기반 트레이딩 코파일럿 MVP 프로토타입입니다.

## 포함 범위

- 차트 캔버스 기반 AI/수동 주석 생성
- 주석 → 전략 구조화 및 유효성 검증
- 실행 프리뷰, 조건 주문, 알림, 승인형 자동 실행
- 상태 전이 시뮬레이션 및 이벤트 센터
- opBNB proof 레이어용 `ExecutionRegistry` 샘플 컨트랙트

## 실행

```zsh
npm install
npm run dev
```

## 테스트 및 빌드

```zsh
npm test
npm run build
```

## 구현 메모

- 현재는 mock market data / mock execution service 기반 데모입니다.
- API 계약은 제품 설계서를 따르며, UI와 서비스 계층에서 해당 shape를 반영했습니다.
- 온체인 실행은 `contracts/ExecutionRegistry.sol`에 proof 레이어 예시로 포함했습니다.
