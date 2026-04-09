import type { Annotation } from '../types/domain';
import { formatPrice } from '../utils/strategy';

interface MyStrategiesPanelProps {
  open: boolean;
  annotations: Annotation[];
  onClose: () => void;
  onSelect: (annotationId: string) => void;
}

export function MyStrategiesPanel({ open, annotations, onClose, onSelect }: MyStrategiesPanelProps) {
  return (
    <aside className={`side-drawer left ${open ? 'open' : ''}`}>
      <div className="drawer-header">
        <div>
          <p className="eyebrow">Portfolio</p>
          <h3>내 전략 목록</h3>
        </div>
        <button className="ghost-button" onClick={onClose}>
          닫기
        </button>
      </div>
      <div className="drawer-list">
        {annotations.map((annotation) => (
          <button key={annotation.annotationId} className="list-card" onClick={() => onSelect(annotation.annotationId)}>
            <div className="list-row">
              <strong>{annotation.marketSymbol}</strong>
              <span className={`pill ${annotation.status.toLowerCase()}`}>{annotation.status}</span>
            </div>
            <p>{annotation.text}</p>
            <span>
              Entry {formatPrice(annotation.strategy.entryPrice)} · TP {formatPrice(annotation.strategy.takeProfitPrices[0] ?? 0)}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
