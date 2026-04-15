import { useMemo, useState } from 'react';
import { getOpbnbAddressUrl, getOpbnbTxUrl } from '../services/apiClient';
import type { Annotation, Execution } from '../types/domain';

interface ExecutionHistoryPanelProps {
  annotations: Annotation[];
  executions: Execution[];
  onCancelOrder: (annotationId: string) => void;
  onSelectAnnotation: (annotationId: string) => void;
}

function formatDateTime(value?: string) {
  if (!value) {
    return '-';
  }

  return new Date(value).toLocaleString('en-US', {
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

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  }).format(value);
}

export function ExecutionHistoryPanel({
  annotations,
  executions,
  onCancelOrder,
  onSelectAnnotation
}: ExecutionHistoryPanelProps) {
  const [view, setView] = useState<'executions' | 'positions' | 'orders'>('executions');
  const [filter, setFilter] = useState<'all' | 'dex' | 'mock' | 'proof'>('all');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'proof_first'>('newest');

  const visibleExecutions = useMemo(() => {
    const filtered = executions.filter((execution) => {
      if (filter === 'dex') {
        return execution.settlementMode === 'dex';
      }

      if (filter === 'mock') {
        return execution.settlementMode === 'mock';
      }

      if (filter === 'proof') {
        return execution.proofRecorded;
      }

      return true;
    });

    const byTimestamp = (execution: Execution) => new Date(execution.filledAt ?? 0).getTime();

    return [...filtered].sort((left, right) => {
      if (sort === 'oldest') {
        return byTimestamp(left) - byTimestamp(right);
      }

      if (sort === 'proof_first') {
        if (left.proofRecorded !== right.proofRecorded) {
          return left.proofRecorded ? -1 : 1;
        }
      }

      return byTimestamp(right) - byTimestamp(left);
    });
  }, [executions, filter, sort]);

  const latestExecutionByStrategyId = useMemo(() => {
    const latest = new Map<string, Execution>();
    executions.forEach((execution) => {
      const current = latest.get(execution.strategyId);
      const currentTime = current?.filledAt ? Date.parse(current.filledAt) : 0;
      const nextTime = execution.filledAt ? Date.parse(execution.filledAt) : 0;
      if (!current || nextTime >= currentTime) {
        latest.set(execution.strategyId, execution);
      }
    });
    return latest;
  }, [executions]);

  const visiblePositions = useMemo(() => {
    return annotations
      .filter((annotation) => {
        const latestExecution = latestExecutionByStrategyId.get(annotation.strategy.strategyId);
        return (
          annotation.status === 'Executed' &&
          (latestExecution?.status === 'Filled' || latestExecution?.status === 'PartiallyFilled')
        );
      })
      .map((annotation) => ({
        annotation,
        latestExecution: latestExecutionByStrategyId.get(annotation.strategy.strategyId) ?? null
      }));
  }, [annotations, latestExecutionByStrategyId]);

  const visiblePendingOrders = useMemo(() => {
    return annotations
      .filter(
        (annotation) =>
          annotation.status !== 'Executed' &&
          annotation.status !== 'Closed' &&
          annotation.status !== 'Invalidated' &&
          annotation.status !== 'Archived' &&
          (annotation.strategy.entryType === 'limit' || annotation.strategy.entryType === 'conditional')
      )
      .map((annotation) => ({
        annotation,
        latestExecution: latestExecutionByStrategyId.get(annotation.strategy.strategyId) ?? null
      }));
  }, [annotations, latestExecutionByStrategyId]);

  const sectionTitle =
    view === 'executions' ? 'Executions' : view === 'positions' ? 'Open Positions' : 'Pending Orders';
  const sectionCount =
    view === 'executions' ? visibleExecutions.length : view === 'positions' ? visiblePositions.length : visiblePendingOrders.length;

  return (
    <section className="execution-history panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Execution History</p>
          <h3>{sectionTitle}</h3>
        </div>
        <span className="section-count">{sectionCount} items</span>
      </div>

      <div className="history-toolbar">
        <div className="history-filter-group">
          {[
            { id: 'executions', label: 'Executions' },
            { id: 'positions', label: 'Positions' },
            { id: 'orders', label: 'Orders' }
          ].map((option) => (
            <button
              key={option.id}
              className={view === option.id ? 'secondary history-chip active' : 'secondary history-chip'}
              onClick={() => setView(option.id as typeof view)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {view === 'executions' ? (
          <div className="history-filter-group">
          {[
            { id: 'all', label: 'All' },
            { id: 'dex', label: 'DEX' },
            { id: 'mock', label: 'Mock' },
            { id: 'proof', label: 'Proof' }
          ].map((option) => (
            <button
              key={option.id}
              className={filter === option.id ? 'secondary history-chip active' : 'secondary history-chip'}
              onClick={() => setFilter(option.id as typeof filter)}
            >
              {option.label}
            </button>
          ))}
          </div>
        ) : (
          <div />
        )}
        {view === 'executions' ? (
          <label className="history-sort">
            <span>Sort</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="proof_first">Proof first</option>
            </select>
          </label>
        ) : null}
      </div>

      {view === 'executions' && visibleExecutions.length === 0 ? (
        <div className="history-empty">
          <strong>No executions yet.</strong>
          <p className="muted">No execution results match the current filter.</p>
        </div>
      ) : null}

      {view === 'executions' && visibleExecutions.length > 0 ? (
        <div className="history-table">
          <div className="history-table-head">
            <span>Execution</span>
            <span>Fill price</span>
            <span>Filled at</span>
            <span>Strategy</span>
            <span>Links</span>
          </div>
          {visibleExecutions.map((execution) => (
            <article key={execution.executionId} className="history-row">
              <div className="history-col history-col-main">
                <p className="eyebrow">{execution.executionId}</p>
                <strong>
                  {execution.actionType === 'close' ? 'Close' : 'Open'} · {execution.status} · {execution.executionChain}
                </strong>
                <span className={`pill ${execution.proofRecorded ? 'executed' : 'triggered'}`}>
                  {execution.proofRecorded ? 'Proof recorded' : 'Proof pending'}
                </span>
              </div>
              <div className="history-col">
                <span className="history-mobile-label">Fill price</span>
                <strong>{formatPrice(execution.filledPrice)}</strong>
              </div>
              <div className="history-col">
                <span className="history-mobile-label">Filled at</span>
                <strong>{formatDateTime(execution.filledAt)}</strong>
              </div>
              <div className="history-col">
                <span className="history-mobile-label">Strategy</span>
                <strong>{execution.strategyId.slice(0, 12)}...</strong>
                {execution.proofRegistryId ? (
                  <span className="history-proof-id">{execution.proofRegistryId.slice(0, 16)}...</span>
                ) : null}
              </div>
              <div className="history-col history-col-links">
                <span className="history-mobile-label">Links</span>
                <div className="status-links history-links">
                  {execution.executionChainTxHash ? (
                    <a href={getOpbnbTxUrl(execution.executionChainTxHash)} target="_blank" rel="noreferrer">
                      Execution tx
                    </a>
                  ) : (
                    <span className="muted">{execution.txHashWarning ? 'Invalid Tx hidden' : 'Tx unavailable'}</span>
                  )}
                  {execution.proofContractAddress ? (
                    <a href={getOpbnbAddressUrl(execution.proofContractAddress)} target="_blank" rel="noreferrer">
                      Registry
                    </a>
                  ) : null}
                </div>
                {execution.txHashWarning ? <span className="muted">{execution.txHashWarning}</span> : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {view === 'positions' && visiblePositions.length === 0 ? (
        <div className="history-empty">
          <strong>No open positions.</strong>
          <p className="muted">Only filled positions that remain active are shown here.</p>
        </div>
      ) : null}

      {view === 'positions' && visiblePositions.length > 0 ? (
        <div className="history-compact-list">
          {visiblePositions.map(({ annotation, latestExecution }) => (
            <article key={annotation.annotationId} className="history-compact-row">
              <div className="history-compact-main">
                <div>
                  <p className="eyebrow">Position</p>
                  <strong>{annotation.marketSymbol}</strong>
                </div>
                <span className="pill executed">{annotation.strategy.bias.toUpperCase()}</span>
              </div>
              <div className="history-compact-meta">
                <span>Entry</span>
                <strong>{formatPrice(latestExecution?.filledPrice ?? annotation.strategy.entryPrice)}</strong>
              </div>
              <div className="history-compact-meta">
                <span>Last fill</span>
                <strong>{formatDateTime(latestExecution?.filledAt)}</strong>
              </div>
              <div className="history-compact-meta">
                <span>Status</span>
                <strong>{latestExecution?.settlementMode?.toUpperCase() ?? 'LOCAL'}</strong>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {view === 'orders' && visiblePendingOrders.length === 0 ? (
        <div className="history-empty">
          <strong>No pending orders.</strong>
          <p className="muted">Only active limit and conditional orders appear here.</p>
        </div>
      ) : null}

      {view === 'orders' && visiblePendingOrders.length > 0 ? (
        <div className="history-compact-list">
          {visiblePendingOrders.map(({ annotation, latestExecution }) => (
            <article key={annotation.annotationId} className="history-compact-row pending">
              <div className="history-compact-main">
                <div>
                  <p className="eyebrow">Order</p>
                  <strong>{annotation.marketSymbol}</strong>
                </div>
                <span className="pill triggered">{annotation.strategy.entryType.toUpperCase()}</span>
              </div>
              <div className="history-compact-meta">
                <span>Target</span>
                <strong>{formatPrice(annotation.strategy.entryPrice)}</strong>
              </div>
              <div className="history-compact-meta">
                <span>Setup</span>
                <strong>{annotation.strategy.entryType.toUpperCase()} · {annotation.strategy.bias.toUpperCase()}</strong>
              </div>
              <div className="history-compact-meta">
                <span>Status</span>
                <strong>{latestExecution?.status ?? annotation.status}</strong>
              </div>
              <div className="history-compact-actions">
                <button
                  type="button"
                  className="secondary history-inline-button"
                  onClick={() => onSelectAnnotation(annotation.annotationId)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="history-remove-button"
                  onClick={() => onCancelOrder(annotation.annotationId)}
                  aria-label={`Remove ${annotation.marketSymbol} order`}
                  title="Remove order"
                >
                  ×
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
