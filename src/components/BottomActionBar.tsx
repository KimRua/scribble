import type { Annotation, StrategyValidation } from '../types/domain';

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
  const reason = !selectedAnnotation ? '주석을 선택하세요' : validation?.violations[0];

  return (
    <div className="bottom-action-bar panel">
      <div>
        <p className="eyebrow">Actions</p>
        <strong>{selectedAnnotation ? selectedAnnotation.text : '선택된 전략 없음'}</strong>
        {disabled ? <p className="muted">{reason}</p> : null}
      </div>
      <div className="action-buttons">
        <button disabled={disabled} onClick={onExecute}>
          주문 실행
        </button>
        <button disabled={disabled} className="secondary" onClick={onConditionalOrder}>
          조건 주문
        </button>
        <button disabled={!selectedAnnotation} className="secondary" onClick={onSetAlert}>
          알림 설정
        </button>
        <button disabled={disabled} className="accent" onClick={onAutoExecute}>
          자동 실행
        </button>
      </div>
    </div>
  );
}
