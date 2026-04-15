import { useEffect, useState } from 'react';
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
  onRemoveDrawingObject: (drawingObjectId: string) => void;
  onCancelOrder: () => void;
  onClosePosition: (input: { mode: 'market' | 'price'; closePrice?: number }) => void;
}

export function RightPanel({
  selectedAnnotation,
  validation,
  currentPrice,
  parsingNotes,
  auditEvents,
  onChangeText,
  onChangeStrategy,
  onActivate,
  onRemoveDrawingObject,
  onCancelOrder,
  onClosePosition
}: RightPanelProps) {
  if (!selectedAnnotation || !validation) {
    return (
      <aside className="right-panel panel empty-panel">
        <p className="eyebrow">Decision Panel</p>
        <h3>Select an annotation on the chart</h3>
        <p className="muted">Generate an AI draft or add a note in text mode to view strategy details here.</p>
      </aside>
    );
  }

  const { strategy } = selectedAnnotation;
  const [closePriceInput, setClosePriceInput] = useState(String(currentPrice || strategy.entryPrice));

  useEffect(() => {
    setClosePriceInput(String(currentPrice || strategy.entryPrice));
  }, [selectedAnnotation.annotationId, currentPrice, strategy.entryPrice]);

  const canCancelOrder =
    selectedAnnotation.status !== 'Executed' &&
    selectedAnnotation.status !== 'Closed' &&
    selectedAnnotation.status !== 'Invalidated' &&
    selectedAnnotation.status !== 'Archived' &&
    (strategy.entryType === 'limit' || strategy.entryType === 'conditional');
  const canClosePosition = selectedAnnotation.status === 'Executed';

  return (
    <aside className="right-panel panel">
      <section className="card-block">
        <div className="list-row">
          <div>
            <p className="eyebrow">AI Summary</p>
            <h3>{strategy.bias.toUpperCase()}</h3>
          </div>
          <button className="secondary" onClick={onActivate}>
            {selectedAnnotation.status === 'Draft' ? 'Activate strategy' : 'Keep current state'}
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
        <div className="quick-preset-group">
          <span className="muted">Bias</span>
          <div className="quick-preset-row">
            {(['bullish', 'bearish', 'neutral'] as const).map((value) => (
              <button
                key={value}
                className={strategy.bias === value ? 'secondary preset-button active' : 'secondary preset-button'}
                onClick={() => onChangeStrategy('bias', value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <div className="quick-preset-group">
          <span className="muted">Entry Type</span>
          <div className="quick-preset-row">
            {(['market', 'limit', 'conditional'] as const).map((value) => (
              <button
                key={value}
                className={strategy.entryType === value ? 'secondary preset-button active' : 'secondary preset-button'}
                onClick={() => onChangeStrategy('entryType', value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
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
            <span>Size</span>
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
            <span>Leverage</span>
            <input
              type="number"
              min="1"
              max="10"
              value={strategy.leverage}
              onChange={(event) => onChangeStrategy('leverage', Number(event.target.value))}
            />
          </label>
        </div>
        <div className="quick-preset-grid">
          <div className="quick-preset-group">
            <span className="muted">Size presets</span>
            <div className="quick-preset-row">
              {[0.05, 0.1, 0.25, 0.5].map((value) => (
                <button
                  key={value}
                  className={strategy.positionSizeRatio === value ? 'secondary preset-button active' : 'secondary preset-button'}
                  onClick={() => onChangeStrategy('positionSizeRatio', value)}
                >
                  {Math.round(value * 100)}%
                </button>
              ))}
            </div>
          </div>
          <div className="quick-preset-group">
            <span className="muted">Leverage presets</span>
            <div className="quick-preset-row">
              {[1, 2, 3, 5].map((value) => (
                <button
                  key={value}
                  className={strategy.leverage === value ? 'secondary preset-button active' : 'secondary preset-button'}
                  onClick={() => onChangeStrategy('leverage', value)}
                >
                  {value}x
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="card-block">
        <p className="eyebrow">Risk Summary</p>
        <div className="summary-grid risk">
          <div>
            <span>Max loss</span>
            <strong>{formatPercent(validation.riskSummary.maxLossRatio)}</strong>
          </div>
          <div>
            <span>Estimated loss</span>
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
            <strong>Guardrail violation</strong>
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
        <div className="list-row">
          <p className="eyebrow">Chart Objects</p>
          <span className="muted">{selectedAnnotation.drawingObjects.length} items</span>
        </div>
        <div className="drawing-object-list">
          {selectedAnnotation.drawingObjects.length === 0 ? <p className="muted">No chart objects added yet.</p> : null}
          {selectedAnnotation.drawingObjects.map((object) => {
            const label =
              object.type === 'line'
                ? `Horizontal line · ${formatPrice(object.price)}`
                : object.type === 'segment'
                  ? `Diagonal line · ${formatPrice(object.startAnchor.price)} → ${formatPrice(object.endAnchor.price)}`
                  : object.type === 'box'
                    ? `Zone box · ${formatPrice(object.priceFrom)} ~ ${formatPrice(object.priceTo)}`
                    : `Text note · ${object.text}`;

            return (
              <div key={object.id} className="drawing-object-item">
                <div>
                  <strong>{label}</strong>
                  <p className="muted">{object.role}</p>
                </div>
                <button className="secondary" onClick={() => onRemoveDrawingObject(object.id)}>
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {canCancelOrder ? (
        <section className="card-block">
          <p className="eyebrow">Order Controls</p>
          <div className="warning-box compact">
            <strong>Pending order</strong>
            <p>This strategy has not filled yet. You can cancel the order immediately if needed.</p>
          </div>
          <div className="modal-actions">
            <button className="secondary" onClick={onCancelOrder}>
              Cancel order
            </button>
          </div>
        </section>
      ) : null}

      {canClosePosition ? (
        <section className="card-block">
          <p className="eyebrow">Position Controls</p>
          <div className="form-grid compact">
            <label>
              <span>Close price</span>
              <input
                type="number"
                value={closePriceInput}
                onChange={(event) => setClosePriceInput(event.target.value)}
              />
            </label>
            <label>
              <span>Current price</span>
              <input type="text" value={formatPrice(currentPrice)} disabled />
            </label>
          </div>
          <p className="muted">Market close exits at the live price, while limit close records an exit at the specified price.</p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => onClosePosition({ mode: 'market' })}>
              Market close
            </button>
            <button
              onClick={() => onClosePosition({ mode: 'price', closePrice: Number(closePriceInput) })}
              disabled={!Number.isFinite(Number(closePriceInput)) || Number(closePriceInput) <= 0}
            >
              Limit close
            </button>
          </div>
        </section>
      ) : null}

      <section className="card-block">
        <p className="eyebrow">Audit Trail</p>
        <div className="audit-list">
          {auditEvents.length === 0 ? <p className="muted">No audit events yet.</p> : null}
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
