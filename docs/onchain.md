# Onchain Proof Layer

## ExecutionRegistry

`contracts/ExecutionRegistry.sol`은 opBNB proof 레이어용 최소 컨트랙트입니다.

### 역할

- 전략 등록
- 실행 트리거 기록
- 결과 성공/실패 기록

### 설계 포인트

- 실제 거래는 오프체인 `execution-service`가 수행한다고 가정합니다.
- 온체인은 annotation → strategy → execution 흐름의 검증 가능한 로그를 남깁니다.
- 해커톤 요구사항 대응을 위해 `triggerCount`와 이벤트 로그를 유지합니다.

### 검증

`npm test`는 `solc`로 컨트랙트를 컴파일하고 필수 함수/이벤트가 ABI에 존재하는지 검증합니다.
