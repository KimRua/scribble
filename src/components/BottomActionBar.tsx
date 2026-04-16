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
  const note = primaryReason ?? (selectedAnnotation ? selectedAnnotation.text : 'Select an annotation');

  return (
    <div className="bottom-action-bar panel">
      <div className="bottom-action-copy">
        <p className="eyebrow">Quick Actions</p>
        <strong>
          {selectedAnnotation
            ? `${selectedAnnotation.marketSymbol} · ${selectedAnnotation.strategy.bias.toUpperCase()} · ${formatPrice(selectedAnnotation.strategy.entryPrice)}`
            : 'No strategy selected'}
        </strong>
        <p className="bottom-action-note">{note}</p>
        {selectedAnnotation && !primaryReason ? <p className="bottom-action-hint">Execution venue: {executionVenueLabel}</p> : null}
      </div>
      <div className="action-buttons">
        <button disabled={executeDisabled} onClick={onExecute} title={executeDisabledReason ?? executionVenueLabel}>
          Execute order
        </button>
        <button
          disabled={conditionalOrderDisabled}
          className="secondary"
          onClick={onConditionalOrder}
          title={conditionalDisabledReason ?? executionVenueLabel}
        >
          Conditional order
        </button>
        <button disabled={!selectedAnnotation} className="secondary" onClick={onSetAlert}>
          Set alert
        </button>
        <button disabled={autoExecuteDisabled} className="accent" onClick={onAutoExecute} title={autoExecuteDisabledReason ?? executionVenueLabel}>
          Auto-execute
        </button>
      </div>
    </div>
  );
}
