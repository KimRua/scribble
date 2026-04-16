import type { Annotation, ExecutionPlan, StrategyValidation } from '../types/domain';
import { formatPercent, formatPrice } from '../utils/strategy';

interface ExecutionModalProps {
  open: boolean;
  selectedAnnotation: Annotation | null;
  preview: ExecutionPlan | null;
  validation: StrategyValidation | null;
  mode: 'execute' | 'conditional';
  executionConfigured: boolean;
  executionVenueLabel: string;
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
  executionConfigured,
  executionVenueLabel,
  onchainConfigured,
  onClose,
  onConfirm
}: ExecutionModalProps) {
  if (!open || !selectedAnnotation || !preview || !validation) {
    return null;
  }

  const approvalDisabled = !preview.guardrailCheck.passed || !executionConfigured;

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
        {!executionConfigured ? (
          <div className="warning-box unsupported-feature-box">
            <strong>Execution unavailable</strong>
            <p>
              실행 가능한 거래 경로가 없습니다. 지갑 연결 또는 DEX 서버 설정이 필요합니다.
            </p>
          </div>
        ) : null}
        <div className="info-banner">
          <strong>Execution Venue</strong>
          <p>
            {mode === 'execute'
              ? executionConfigured
                ? `${executionVenueLabel} 경로로 ${selectedAnnotation.strategy.bias.toUpperCase()} 방향 주문을 실행합니다.`
                : '실행 경로가 아직 준비되지 않았습니다.'
              : `${executionVenueLabel} 경로로 ${formatPrice(selectedAnnotation.strategy.entryPrice)} 부근 조건 주문을 시도합니다.`}
          </p>
          {mode === 'execute' && executionConfigured && !onchainConfigured ? (
            <p>opBNB proof recording은 선택 기능이며 현재 주문 실행과는 분리되어 있습니다.</p>
          ) : null}
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button disabled={approvalDisabled} onClick={onConfirm}>
            Final approve
          </button>
        </div>
      </div>
    </div>
  );
}
