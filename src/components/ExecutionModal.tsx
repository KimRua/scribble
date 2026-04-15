import type { Annotation, ExecutionPlan, StrategyValidation } from '../types/domain';
import { formatPercent, formatPrice } from '../utils/strategy';

interface ExecutionModalProps {
  open: boolean;
  selectedAnnotation: Annotation | null;
  preview: ExecutionPlan | null;
  validation: StrategyValidation | null;
  mode: 'execute' | 'conditional';
  onchainConfigured: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function ExecutionModal({
  open,
  selectedAnnotation,
  preview,
  validation,
  mode,
  onchainConfigured,
  onClose,
  onConfirm
}: ExecutionModalProps) {
  if (!open || !selectedAnnotation || !preview || !validation) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal panel">
        <div className="modal-header">
          <div>
            <p className="eyebrow">{mode === 'execute' ? 'Execution Preview' : 'Conditional Order'}</p>
            <h3>{selectedAnnotation.marketSymbol}</h3>
          </div>
          <button className="ghost-button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="grid two-columns">
          <div className="info-block">
            <span>Entry mode</span>
            <strong>{selectedAnnotation.strategy.entryType}</strong>
          </div>
          <div className="info-block">
            <span>Entry price</span>
            <strong>{formatPrice(preview.entryPrice)}</strong>
          </div>
          <div className="info-block">
            <span>Size / allocation</span>
            <strong>{preview.positionSize} USDT</strong>
          </div>
          <div className="info-block">
            <span>Slippage cap</span>
            <strong>{formatPercent(preview.estimatedSlippage)}</strong>
          </div>
          <div className="info-block">
            <span>Estimated max loss</span>
            <strong>{formatPercent(validation.riskSummary.maxLossRatio)}</strong>
          </div>
          <div className="info-block">
            <span>Estimated fee</span>
            <strong>${preview.estimatedFee}</strong>
          </div>
        </div>
        <div className="warning-box">
          <strong>Guardrail</strong>
          <p>
            {preview.guardrailCheck.passed
              ? 'Risk guardrails passed. You can approve and execute this plan.'
              : preview.guardrailCheck.violations.join(' / ')}
          </p>
        </div>
        <div className="info-banner">
          <strong>Onchain Proof</strong>
          <p>
            {mode === 'execute'
              ? onchainConfigured
                ? 'Approval will also attempt to record execution proof on opBNB.'
                : 'opBNB proof is not configured, so only the in-app audit log will be recorded.'
              : 'For conditional orders, proof recording is decided at fill time.'}
          </p>
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button disabled={!preview.guardrailCheck.passed} onClick={onConfirm}>
            Final approve
          </button>
        </div>
      </div>
    </div>
  );
}
