import type { Annotation, AuditEvent, Strategy, StrategyValidation } from '../types/domain';
import { formatPercent, formatPrice } from '../utils/strategy';

interface RightPanelProps {
  selectedAnnotation: Annotation | null;
  validation: StrategyValidation | null;
  currentPrice: number;
  parsingNotes: string[];
  auditEvents: AuditEvent[];
  onChangeText: (text: string) => void;
  onChangeStrategy: <K extends keyof Strategy>(key: K, value: Strategy[K]) => void;
  onActivate: () => void;
}

export function RightPanel({
  selectedAnnotation,
  validation,
  currentPrice,
  parsingNotes,
  auditEvents,
  onChangeText,
  onChangeStrategy,
  onActivate
}: RightPanelProps) {
  if (!selectedAnnotation || !validation) {
    return (
      <aside className="right-panel panel empty-panel">
        <p className="eyebrow">Decision Panel</p>
        <h3>차트에서 주석을 선택하세요</h3>
        <p className="muted">AI 분석을 생성하거나 텍스트 모드에서 직접 주석을 작성하면 전략 상세가 이 패널에 표시됩니다.</p>
      </aside>
    );
  }

  const { strategy } = selectedAnnotation;

  return (
    <aside className="right-panel panel">
      <section className="card-block">
        <div className="list-row">
          <div>
            <p className="eyebrow">AI Summary</p>
            <h3>{strategy.bias.toUpperCase()}</h3>
          </div>
          <button className="secondary" onClick={onActivate}>
            {selectedAnnotation.status === 'Draft' ? '전략 활성화' : '상태 유지'}
          </button>
        </div>
        <div className="summary-grid">
          <div>
            <span>Confidence</span>
            <strong>{Math.round(strategy.confidence * 100)}%</strong>
          </div>
          <div>
            <span>Key Level</span>
            <strong>{formatPrice(strategy.entryPrice)}</strong>
          </div>
          <div>
            <span>Current Price</span>
            <strong>{formatPrice(currentPrice)}</strong>
          </div>
        </div>
      </section>

      <section className="card-block">
        <p className="eyebrow">Annotation Text</p>
        <textarea value={selectedAnnotation.text} onChange={(event) => onChangeText(event.target.value)} />
        {parsingNotes.length > 0 ? <p className="muted">{parsingNotes.join(' · ')}</p> : null}
      </section>

      <section className="card-block">
        <p className="eyebrow">Strategy Details</p>
        <div className="form-grid compact">
          <label>
            <span>Entry</span>
            <input
              type="number"
              value={strategy.entryPrice}
              onChange={(event) => onChangeStrategy('entryPrice', Number(event.target.value))}
            />
          </label>
          <label>
            <span>SL</span>
            <input
              type="number"
              value={strategy.stopLossPrice}
              onChange={(event) => onChangeStrategy('stopLossPrice', Number(event.target.value))}
            />
          </label>
          <label>
            <span>TP1</span>
            <input
              type="number"
              value={strategy.takeProfitPrices[0] ?? 0}
              onChange={(event) => onChangeStrategy('takeProfitPrices', [Number(event.target.value), strategy.takeProfitPrices[1] ?? Number(event.target.value)])}
            />
          </label>
          <label>
            <span>TP2</span>
            <input
              type="number"
              value={strategy.takeProfitPrices[1] ?? strategy.takeProfitPrices[0] ?? 0}
              onChange={(event) => onChangeStrategy('takeProfitPrices', [strategy.takeProfitPrices[0] ?? strategy.entryPrice, Number(event.target.value)])}
            />
          </label>
          <label>
            <span>비중</span>
            <input
              type="number"
              min="0.01"
              max="1"
              step="0.01"
              value={strategy.positionSizeRatio}
              onChange={(event) => onChangeStrategy('positionSizeRatio', Number(event.target.value))}
            />
          </label>
          <label>
            <span>레버리지</span>
            <input
              type="number"
              min="1"
              max="10"
              value={strategy.leverage}
              onChange={(event) => onChangeStrategy('leverage', Number(event.target.value))}
            />
          </label>
        </div>
      </section>

      <section className="card-block">
        <p className="eyebrow">Risk Summary</p>
        <div className="summary-grid risk">
          <div>
            <span>최대 손실</span>
            <strong>{formatPercent(validation.riskSummary.maxLossRatio)}</strong>
          </div>
          <div>
            <span>예상 손실금</span>
            <strong>${validation.riskSummary.maxLossAmount}</strong>
          </div>
          <div>
            <span>RR</span>
            <strong>{validation.riskSummary.riskRewardRatio}</strong>
          </div>
          <div>
            <span>Liquidation Risk</span>
            <strong>{validation.riskSummary.liquidationRisk}</strong>
          </div>
        </div>
        {!validation.isValid ? (
          <div className="warning-box compact">
            <strong>가드레일 위반</strong>
            <p>{validation.violations.join(' / ')}</p>
          </div>
        ) : null}
      </section>

      <section className="card-block">
        <p className="eyebrow">Invalidation</p>
        <textarea
          value={strategy.invalidationCondition}
          onChange={(event) => onChangeStrategy('invalidationCondition', event.target.value)}
        />
      </section>

      <section className="card-block">
        <p className="eyebrow">Audit Trail</p>
        <div className="audit-list">
          {auditEvents.length === 0 ? <p className="muted">아직 기록이 없습니다.</p> : null}
          {auditEvents.map((event) => (
            <div key={event.eventId} className="audit-item">
              <strong>{event.eventType}</strong>
              <span>{new Date(event.timestamp).toLocaleTimeString('ko-KR')}</span>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}
