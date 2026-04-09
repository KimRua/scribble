import { getOpbnbAddressUrl, getOpbnbTxUrl } from '../services/apiClient';
import type { Execution } from '../types/domain';

interface ExecutionHistoryPanelProps {
  executions: Execution[];
}

function formatDateTime(value?: string) {
  if (!value) {
    return '-';
  }

  return new Date(value).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatPrice(value?: number) {
  if (typeof value !== 'number') {
    return '-';
  }

  return new Intl.NumberFormat('ko-KR', {
    maximumFractionDigits: 2
  }).format(value);
}

export function ExecutionHistoryPanel({ executions }: ExecutionHistoryPanelProps) {
  return (
    <section className="execution-history panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Execution History</p>
          <h3>최근 실행 기록</h3>
        </div>
        <span className="section-count">{executions.length}건</span>
      </div>

      {executions.length === 0 ? (
        <div className="history-empty">
          <strong>아직 실행 기록이 없습니다.</strong>
          <p className="muted">주문 실행 후 이 영역에서 proof 상태와 트랜잭션 링크를 빠르게 확인할 수 있습니다.</p>
        </div>
      ) : (
        <div className="history-table">
          <div className="history-table-head">
            <span>실행</span>
            <span>체결가</span>
            <span>실행 시각</span>
            <span>전략</span>
            <span>링크</span>
          </div>
          {executions.map((execution) => (
            <article key={execution.executionId} className="history-row">
              <div className="history-col history-col-main">
                <p className="eyebrow">{execution.executionId}</p>
                <strong>
                  {execution.status} · {execution.executionChain}
                </strong>
                <span className={`pill ${execution.proofRecorded ? 'executed' : 'triggered'}`}>
                  {execution.proofRecorded ? 'Proof recorded' : 'Proof pending'}
                </span>
              </div>
              <div className="history-col">
                <span className="history-mobile-label">체결가</span>
                <strong>{formatPrice(execution.filledPrice)}</strong>
              </div>
              <div className="history-col">
                <span className="history-mobile-label">실행 시각</span>
                <strong>{formatDateTime(execution.filledAt)}</strong>
              </div>
              <div className="history-col">
                <span className="history-mobile-label">전략</span>
                <strong>{execution.strategyId.slice(0, 12)}…</strong>
                {execution.proofRegistryId ? <span className="history-proof-id">{execution.proofRegistryId.slice(0, 16)}…</span> : null}
              </div>
              <div className="history-col history-col-links">
                <span className="history-mobile-label">링크</span>
                <div className="status-links history-links">
                  <a href={getOpbnbTxUrl(execution.executionChainTxHash)} target="_blank" rel="noreferrer">
                    실행 Tx
                  </a>
                  {execution.proofContractAddress ? (
                    <a href={getOpbnbAddressUrl(execution.proofContractAddress)} target="_blank" rel="noreferrer">
                      Registry
                    </a>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
