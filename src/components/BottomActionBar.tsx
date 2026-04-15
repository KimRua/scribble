import type { Annotation, StrategyValidation } from '../types/domain';
import { formatPrice } from '../utils/strategy';

interface BottomActionBarProps {
  selectedAnnotation: Annotation | null;
  validation: StrategyValidation | null;
  onExecute: () => void;
  onConditionalOrder: () => void;
  onSetAlert: () => void;
  onAutoExecute: () => void;
}

export function BottomActionBar({
  selectedAnnotation,
  validation,
  onExecute,
  onConditionalOrder,
  onSetAlert,
  onAutoExecute
}: BottomActionBarProps) {
  const disabled = !selectedAnnotation || !validation?.isValid;
  const reason = !selectedAnnotation ? 'Select an annotation' : validation?.violations[0];

  return (
    <div className="bottom-action-bar panel">
      <div className="bottom-action-copy">
        <p className="eyebrow">Quick Actions</p>
        <strong>
          {selectedAnnotation
            ? `${selectedAnnotation.marketSymbol} · ${selectedAnnotation.strategy.bias.toUpperCase()} · ${formatPrice(selectedAnnotation.strategy.entryPrice)}`
            : 'No strategy selected'}
        </strong>
        <p className="bottom-action-note">
          {selectedAnnotation ? selectedAnnotation.text : reason}
        </p>
      </div>
      <div className="action-buttons">
        <button disabled={disabled} onClick={onExecute}>
          Execute order
        </button>
        <button disabled={disabled} className="secondary" onClick={onConditionalOrder}>
          Conditional order
        </button>
        <button disabled={!selectedAnnotation} className="secondary" onClick={onSetAlert}>
          Set alert
        </button>
        <button disabled={disabled} className="accent" onClick={onAutoExecute}>
          Auto-execute
        </button>
      </div>
    </div>
  );
}
