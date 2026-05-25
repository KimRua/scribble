import { useEffect, useState } from 'react';
import type { Annotation, AuditEvent, Execution, NewsInsight, Strategy, StrategyValidation } from '../types/domain';
import { formatPercent, formatPrice } from '../utils/strategy';

interface RightPanelProps {
  selectedAnnotation: Annotation | null;
  selectedNewsInsight: NewsInsight | null;
  validation: StrategyValidation | null;
  latestExecution: Execution | null;
  manualExecutionReady: boolean;
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
  selectedNewsInsight,
  validation,
  latestExecution,
  manualExecutionReady,
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
  const [activeTab, setActiveTab] = useState<'overview' | 'strategy' | 'execution' | 'logs'>('overview');
  const [closePriceInput, setClosePriceInput] = useState('');

  useEffect(() => {
    const price = selectedAnnotation?.strategy.entryPrice ?? currentPrice ?? 0;
    setClosePriceInput(String(price));
  }, [selectedAnnotation?.annotationId, selectedAnnotation?.strategy.entryPrice, currentPrice]);

  if (selectedNewsInsight) {
    return (
      <aside className="right-panel panel">
        <section className="card-block news-detail-block">
          <div className="list-row">
            <div>
              <p className="eyebrow">News Insight</p>
              <h3>{selectedNewsInsight.direction === 'spike' ? 'Bullish Event' : 'Risk Event'}</h3>
            </div>
            <span className={`news-sentiment-pill ${selectedNewsInsight.sentiment}`}>
              {selectedNewsInsight.direction === 'spike' ? '▲' : '▼'} {Math.abs(selectedNewsInsight.priceChangePercent).toFixed(1)}%
            </span>
          </div>
          <div className="summary-grid">
            <div>
              <span>Headline</span>
              <strong>{selectedNewsInsight.headline}</strong>
            </div>
            <div>
              <span>Time</span>
              <strong>{new Date(selectedNewsInsight.time).toLocaleString('ko-KR')}</strong>
            </div>
            <div>
              <span>Sentiment</span>
              <strong>{selectedNewsInsight.sentiment}</strong>
            </div>
            <div>
              <span>Move</span>
              <strong>{selectedNewsInsight.priceChangePercent.toFixed(2)}%</strong>
            </div>
          </div>
        </section>

        <section className="card-block news-detail-block">
          <p className="eyebrow">Summary</p>
          <p className="news-detail-copy">{selectedNewsInsight.summary}</p>
        </section>

        <section className="card-block news-detail-block">
          <p className="eyebrow">AI Opinion</p>
          <p className="news-detail-copy news-detail-highlight">{selectedNewsInsight.aiComment}</p>
        </section>

        <section className="card-block news-detail-block">
          <p className="eyebrow">Chart Context</p>
          <div className="summary-grid risk">
            <div>
              <span>Candle Index</span>
              <strong>{selectedNewsInsight.candleIndex}</strong>
            </div>
            <div>
              <span>Current Price</span>
              <strong>{formatPrice(currentPrice)}</strong>
            </div>
          </div>
        </section>
      </aside>
    );
  }

  if (!selectedAnnotation || !validation) {
    return (
      <aside className="right-panel panel empty-panel">
        <p className="eyebrow">작업 패널</p>
        <h3>차트에서 전략을 선택하세요</h3>
        <p className="muted">AI 분석을 생성하거나 메모를 추가하면 이곳에서 전략, 실행, 로그를 한눈에 관리할 수 있습니다.</p>
      </aside>
    );
  }

  const { strategy } = selectedAnnotation;
  const canCancelOrder =
    selectedAnnotation.status !== 'Executed' &&
    selectedAnnotation.status !== 'Closed' &&
    selectedAnnotation.status !== 'Invalidated' &&
    selectedAnnotation.status !== 'Archived' &&
    (strategy.entryType === 'limit' || strategy.entryType === 'conditional');
  const canClosePosition = selectedAnnotation.status === 'Executed';
  const hasPendingCloseOrder =
    canClosePosition &&
    latestExecution?.actionType === 'close' &&
    (latestExecution.status === 'Pending' ||
      latestExecution.status === 'ReadyToExecute' ||
      latestExecution.status === 'Executing' ||
      latestExecution.status === 'PartiallyFilled') &&
    Boolean(latestExecution.externalOrderId);
  const closePriceValid = Number.isFinite(Number(closePriceInput)) && Number(closePriceInput) > 0;

  return (
    <aside className="right-panel panel">
      <section className="card-block workspace-selection-card">
        <div className="list-row">
          <div>
            <p className="eyebrow">선택된 전략</p>
            <h3>
              {selectedAnnotation.marketSymbol} · {strategy.bias === 'bullish' ? '상승' : strategy.bias === 'bearish' ? '하락' : '중립'}
            </h3>
          </div>
          <button className="secondary" onClick={onActivate}>
            {selectedAnnotation.status === 'Draft' ? '전략 활성화' : '상태 유지'}
          </button>
        </div>
        <div className="summary-grid">
          <div>
            <span>현재 상태</span>
            <strong>{selectedAnnotation.status}</strong>
          </div>
          <div>
            <span>신뢰도</span>
            <strong>{Math.round(strategy.confidence * 100)}%</strong>
          </div>
          <div>
            <span>진입가</span>
            <strong>{formatPrice(strategy.entryPrice)}</strong>
          </div>
          <div>
            <span>현재가</span>
            <strong>{formatPrice(currentPrice)}</strong>
          </div>
        </div>
      </section>

      <div className="workspace-panel-tabs">
        {[
          { id: 'overview', label: '개요' },
          { id: 'strategy', label: '전략' },
          { id: 'execution', label: '실행' },
          { id: 'logs', label: '로그' }
        ].map((tab) => (
          <button
            key={tab.id}
            className={activeTab === tab.id ? 'secondary workspace-panel-tab active' : 'ghost-button workspace-panel-tab'}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' ? (
        <>
          <section className="card-block">
            <p className="eyebrow">전략 메모</p>
            <textarea value={selectedAnnotation.text} onChange={(event) => onChangeText(event.target.value)} />
            {parsingNotes.length > 0 ? <p className="muted">{parsingNotes.join(' · ')}</p> : null}
          </section>

          <section className="card-block">
            <p className="eyebrow">리스크 요약</p>
            <div className="summary-grid risk">
              <div>
                <span>최대 손실 비율</span>
                <strong>{formatPercent(validation.riskSummary.maxLossRatio)}</strong>
              </div>
              <div>
                <span>예상 손실</span>
                <strong>${validation.riskSummary.maxLossAmount}</strong>
              </div>
              <div>
                <span>손익비</span>
                <strong>{validation.riskSummary.riskRewardRatio}</strong>
              </div>
              <div>
                <span>청산 위험</span>
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
        </>
      ) : null}

      {activeTab === 'strategy' ? (
        <>
          <section className="card-block">
            <p className="eyebrow">전략 설정</p>
            <div className="quick-preset-group">
              <span className="muted">방향</span>
              <div className="quick-preset-row">
                {([
                  ['bullish', '상승'],
                  ['bearish', '하락'],
                  ['neutral', '중립']
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    className={strategy.bias === value ? 'secondary preset-button active' : 'secondary preset-button'}
                    onClick={() => onChangeStrategy('bias', value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="quick-preset-group">
              <span className="muted">진입 방식</span>
              <div className="quick-preset-row">
                {([
                  ['market', '시장가'],
                  ['limit', '지정가'],
                  ['conditional', '조건부']
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    className={strategy.entryType === value ? 'secondary preset-button active' : 'secondary preset-button'}
                    onClick={() => onChangeStrategy('entryType', value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-grid compact">
              <label>
                <span>진입가</span>
                <input type="number" value={strategy.entryPrice} onChange={(event) => onChangeStrategy('entryPrice', Number(event.target.value))} />
              </label>
              <label>
                <span>손절가</span>
                <input
                  type="number"
                  value={strategy.stopLossPrice}
                  onChange={(event) => onChangeStrategy('stopLossPrice', Number(event.target.value))}
                />
              </label>
              <label>
                <span>익절 1</span>
                <input
                  type="number"
                  value={strategy.takeProfitPrices[0] ?? 0}
                  onChange={(event) =>
                    onChangeStrategy('takeProfitPrices', [
                      Number(event.target.value),
                      strategy.takeProfitPrices[1] ?? Number(event.target.value)
                    ])
                  }
                />
              </label>
              <label>
                <span>익절 2</span>
                <input
                  type="number"
                  value={strategy.takeProfitPrices[1] ?? strategy.takeProfitPrices[0] ?? 0}
                  onChange={(event) =>
                    onChangeStrategy('takeProfitPrices', [
                      strategy.takeProfitPrices[0] ?? strategy.entryPrice,
                      Number(event.target.value)
                    ])
                  }
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
                <input type="number" min="1" max="10" value={strategy.leverage} onChange={(event) => onChangeStrategy('leverage', Number(event.target.value))} />
              </label>
            </div>
            <div className="quick-preset-grid">
              <div className="quick-preset-group">
                <span className="muted">비중 프리셋</span>
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
                <span className="muted">레버리지 프리셋</span>
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
            <p className="eyebrow">무효화 조건</p>
            <textarea value={strategy.invalidationCondition} onChange={(event) => onChangeStrategy('invalidationCondition', event.target.value)} />
          </section>

          <section className="card-block">
            <div className="list-row">
              <p className="eyebrow">차트 오브젝트</p>
              <span className="muted">{selectedAnnotation.drawingObjects.length}개</span>
            </div>
            <div className="drawing-object-list">
              {selectedAnnotation.drawingObjects.length === 0 ? <p className="muted">추가된 차트 오브젝트가 없습니다.</p> : null}
              {selectedAnnotation.drawingObjects.map((object) => {
                const label =
                  object.type === 'line'
                    ? `수평선 · ${formatPrice(object.price)}`
                    : object.type === 'segment'
                      ? `추세선 · ${formatPrice(object.startAnchor.price)} → ${formatPrice(object.endAnchor.price)}`
                      : object.type === 'box'
                        ? `박스 영역 · ${formatPrice(object.priceFrom)} ~ ${formatPrice(object.priceTo)}`
                        : `텍스트 메모 · ${object.text}`;

                return (
                  <div key={object.id} className="drawing-object-item">
                    <div>
                      <strong>{label}</strong>
                      <p className="muted">{object.role}</p>
                    </div>
                    <button className="secondary" onClick={() => onRemoveDrawingObject(object.id)}>
                      제거
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      ) : null}

      {activeTab === 'execution' ? (
        <>
          {canCancelOrder ? (
            <section className="card-block">
              <p className="eyebrow">대기 주문 관리</p>
              <div className="warning-box compact">
                <strong>대기 주문 있음</strong>
                <p>아직 체결되지 않은 주문입니다. 필요하다면 즉시 취소할 수 있습니다.</p>
              </div>
              <div className="modal-actions">
                <button className="secondary" onClick={onCancelOrder}>
                  주문 취소
                </button>
              </div>
            </section>
          ) : null}

          {canClosePosition ? (
            <section className="card-block">
              <p className="eyebrow">포지션 정리</p>
              <div className="info-banner">
                <strong>Hyperliquid testnet</strong>
                <p>
                  {manualExecutionReady
                    ? hasPendingCloseOrder
                      ? '현재 리듀스온리 청산 주문이 대기 중입니다. 먼저 취소한 뒤 새 청산 주문을 넣으세요.'
                      : '시장가 청산은 즉시 정리하고, 지정가 청산은 지정 가격에 리듀스온리 주문을 남깁니다.'
                    : '지갑을 연결해야 실제 시장가/지정가 청산을 보낼 수 있습니다.'}
                </p>
              </div>
              <div className="form-grid compact">
                <label>
                  <span>청산 가격</span>
                  <input
                    type="number"
                    value={closePriceInput}
                    disabled={!manualExecutionReady || hasPendingCloseOrder}
                    onChange={(event) => setClosePriceInput(event.target.value)}
                  />
                </label>
                <label>
                  <span>현재 가격</span>
                  <input type="text" value={formatPrice(currentPrice)} disabled />
                </label>
              </div>
              <p className="muted">빠른 신규 주문과 알림 설정은 아래 실행 바에서 계속 사용할 수 있습니다.</p>
              <div className="modal-actions">
                <button className="secondary" disabled={!manualExecutionReady || hasPendingCloseOrder} onClick={() => onClosePosition({ mode: 'market' })}>
                  시장가 청산
                </button>
                <button
                  onClick={() => onClosePosition({ mode: 'price', closePrice: Number(closePriceInput) })}
                  disabled={!manualExecutionReady || hasPendingCloseOrder || !closePriceValid}
                >
                  지정가 청산
                </button>
              </div>
              {hasPendingCloseOrder ? (
                <div className="modal-actions">
                  <button className="secondary" onClick={onCancelOrder}>
                    대기 청산 취소
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}

          {!canCancelOrder && !canClosePosition ? (
            <section className="card-block">
              <p className="eyebrow">실행 상태</p>
              <p className="muted">현재 선택된 전략은 즉시 취소하거나 청산할 실행 항목이 없습니다. 신규 실행은 아래 빠른 실행 바에서 진행하세요.</p>
            </section>
          ) : null}
        </>
      ) : null}

      {activeTab === 'logs' ? (
        <section className="card-block">
          <p className="eyebrow">감사 로그</p>
          <div className="audit-list">
            {auditEvents.length === 0 ? <p className="muted">아직 기록된 이벤트가 없습니다.</p> : null}
            {auditEvents.map((event) => (
              <div key={event.eventId} className="audit-item">
                <strong>{event.eventType}</strong>
                <span>{new Date(event.timestamp).toLocaleTimeString('ko-KR')}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </aside>
  );
}
