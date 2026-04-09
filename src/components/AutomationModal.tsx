import { useEffect, useState } from 'react';
import type { Annotation, AutomationRule } from '../types/domain';

interface AutomationModalProps {
  open: boolean;
  selectedAnnotation: Annotation | null;
  automation: AutomationRule | null;
  onClose: () => void;
  onSave: (config: {
    maxPositionSizeRatio: number;
    maxLeverage: number;
    maxLossRatio: number;
    maxDailyExecutions: number;
  }) => void;
}

export function AutomationModal({ open, selectedAnnotation, automation, onClose, onSave }: AutomationModalProps) {
  const [form, setForm] = useState({
    maxPositionSizeRatio: 0.1,
    maxLeverage: 2,
    maxLossRatio: 0.05,
    maxDailyExecutions: 3
  });

  useEffect(() => {
    if (automation) {
      setForm({
        maxPositionSizeRatio: automation.maxPositionSizeRatio,
        maxLeverage: automation.maxLeverage,
        maxLossRatio: automation.maxLossRatio,
        maxDailyExecutions: automation.maxDailyExecutions
      });
    }
  }, [automation]);

  if (!open || !selectedAnnotation) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal panel">
        <div className="modal-header">
          <div>
            <p className="eyebrow">Automation</p>
            <h3>자동 실행 설정</h3>
          </div>
          <button className="ghost-button" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="form-grid">
          <label>
            <span>최대 포지션 비중</span>
            <input
              type="number"
              min="0.01"
              max="1"
              step="0.01"
              value={form.maxPositionSizeRatio}
              onChange={(event) => setForm((prev) => ({ ...prev, maxPositionSizeRatio: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>최대 레버리지</span>
            <input
              type="number"
              min="1"
              max="10"
              value={form.maxLeverage}
              onChange={(event) => setForm((prev) => ({ ...prev, maxLeverage: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>최대 허용 손실</span>
            <input
              type="number"
              min="0.01"
              max="0.2"
              step="0.01"
              value={form.maxLossRatio}
              onChange={(event) => setForm((prev) => ({ ...prev, maxLossRatio: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>1일 최대 실행 횟수</span>
            <input
              type="number"
              min="1"
              max="10"
              value={form.maxDailyExecutions}
              onChange={(event) => setForm((prev) => ({ ...prev, maxDailyExecutions: Number(event.target.value) }))}
            />
          </label>
        </div>
        <div className="warning-box">
          <strong>활성 조건</strong>
          <p>{selectedAnnotation.strategy.entryPrice} 터치 시 트리거, guardrail 통과 시 실행합니다.</p>
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            취소
          </button>
          <button onClick={() => onSave(form)}>저장</button>
        </div>
      </div>
    </div>
  );
}
