import type { Annotation, ExecutionPlan, StrategyValidation } from '../types/domain';
import { formatPercent, formatPrice } from '../utils/strategy';

interface ExecutionModalProps {
  open: boolean;
  selectedAnnotation: Annotation | null;
  preview: ExecutionPlan | null;
  validation: StrategyValidation | null;
  mode: 'execute' | 'conditional';
  onClose: () => void;
  onConfirm: () => void;
}

export function ExecutionModal({
  open,
  selectedAnnotation,
  preview,
  validation,
  mode,
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
            닫기
          </button>
        </div>
        <div className="grid two-columns">
          <div className="info-block">
            <span>진입 방식</span>
            <strong>{selectedAnnotation.strategy.entryType}</strong>
          </div>
          <div className="info-block">
            <span>진입 가격</span>
            <strong>{formatPrice(preview.entryPrice)}</strong>
          </div>
          <div className="info-block">
            <span>수량/비중</span>
            <strong>{preview.positionSize} USDT</strong>
          </div>
          <div className="info-block">
            <span>슬리피지 제한</span>
            <strong>{formatPercent(preview.estimatedSlippage)}</strong>
          </div>
          <div className="info-block">
            <span>예상 최대 손실</span>
            <strong>{formatPercent(validation.riskSummary.maxLossRatio)}</strong>
          </div>
          <div className="info-block">
            <span>예상 수수료</span>
            <strong>${preview.estimatedFee}</strong>
          </div>
        </div>
        <div className="warning-box">
          <strong>Guardrail</strong>
          <p>
            {preview.guardrailCheck.passed
              ? '리스크 기준을 통과했습니다. 승인 후 실행할 수 있습니다.'
              : preview.guardrailCheck.violations.join(' / ')}
          </p>
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            취소
          </button>
          <button disabled={!preview.guardrailCheck.passed} onClick={onConfirm}>
            최종 승인
          </button>
        </div>
      </div>
    </div>
  );
}
