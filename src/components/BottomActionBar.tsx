import type { Annotation } from '../types/domain';
import { formatPrice } from '../utils/strategy';

interface BottomActionBarProps {
  selectedAnnotation: Annotation | null;
  executeDisabledReason: string | null;
  conditionalDisabledReason: string | null;
  autoExecuteDisabledReason: string | null;
  executionVenueLabel: string;
  onExecute: () => void;
  onConditionalOrder: () => void;
  onSetAlert: () => void;
  onAutoExecute: () => void;
}

export function BottomActionBar({
  selectedAnnotation,
  executeDisabledReason,
  conditionalDisabledReason,
  autoExecuteDisabledReason,
  executionVenueLabel,
  onExecute,
  onConditionalOrder,
  onSetAlert,
  onAutoExecute
}: BottomActionBarProps) {
  const executeDisabled = !selectedAnnotation;
  const conditionalOrderDisabled = !selectedAnnotation;
  const autoExecuteDisabled = Boolean(autoExecuteDisabledReason);
  const primaryReason = executeDisabledReason ?? conditionalDisabledReason ?? autoExecuteDisabledReason;
  const note = primaryReason ?? (selectedAnnotation ? selectedAnnotation.text : '차트에서 전략을 선택하세요');

  return (
    <div className="bottom-action-bar panel">
      <div className="bottom-action-copy">
        <p className="eyebrow">빠른 실행</p>
        <strong>
          {selectedAnnotation
            ? `${selectedAnnotation.marketSymbol} · ${selectedAnnotation.strategy.bias.toUpperCase()} · ${formatPrice(selectedAnnotation.strategy.entryPrice)}`
            : '선택된 전략 없음'}
        </strong>
        <p className="bottom-action-note">{note}</p>
        {selectedAnnotation && !primaryReason ? <p className="bottom-action-hint">실행 경로: {executionVenueLabel}</p> : null}
      </div>
      <div className="action-buttons">
        <button disabled={executeDisabled} onClick={onExecute} title={executeDisabledReason ?? executionVenueLabel}>
          즉시 실행
        </button>
        <button
          disabled={conditionalOrderDisabled}
          className="secondary"
          onClick={onConditionalOrder}
          title={conditionalDisabledReason ?? executionVenueLabel}
        >
          조건부 주문
        </button>
        <button disabled={!selectedAnnotation} className="secondary" onClick={onSetAlert}>
          알림 설정
        </button>
        <button disabled={autoExecuteDisabled} className="accent" onClick={onAutoExecute} title={autoExecuteDisabledReason ?? executionVenueLabel}>
          자동 실행
        </button>
      </div>
    </div>
  );
}
