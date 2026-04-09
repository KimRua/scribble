import { useMemo, useRef, useState } from 'react';
import type { Annotation, Candle, ChartAnchor, DrawingMode } from '../types/domain';
import { annotationBadgeTone, formatPrice } from '../utils/strategy';

interface DraftComposer {
  x: number;
  y: number;
  anchor: ChartAnchor;
}

interface ChartCanvasProps {
  marketData: Candle[];
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  drawingMode: DrawingMode;
  currentPrice: number;
  onChangeMode: (mode: DrawingMode) => void;
  onSelectAnnotation: (annotationId: string) => void;
  onCreateAnnotation: (text: string, anchor: ChartAnchor) => void;
  onAddLineToSelected: (price: number) => void;
  onAddBoxToSelected: (priceFrom: number, priceTo: number) => void;
  onRequestAi: () => void;
  onNudgePrice: (deltaRatio: number) => void;
  onTriggerSelected: () => void;
}

const WIDTH = 860;
const HEIGHT = 480;
const PADDING = 36;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getAnnotationBubbleBox(text: string, anchorX: number, anchorY: number) {
  const charsPerLine = 24;
  const estimatedLines = Math.max(2, Math.ceil(text.length / charsPerLine));
  const width = text.length > 110 ? 280 : 250;
  const height = clamp(72 + estimatedLines * 18, 98, 178);

  return {
    width,
    height,
    x: clamp(anchorX + 12, 12, WIDTH - width - 12),
    y: clamp(anchorY - height - 14, 14, HEIGHT - height - 14)
  };
}

function priceExtent(candles: Candle[], currentPrice: number) {
  const lows = candles.map((candle) => candle.low);
  const highs = candles.map((candle) => candle.high);
  return {
    min: Math.min(...lows, currentPrice) * 0.995,
    max: Math.max(...highs, currentPrice) * 1.005
  };
}

export function ChartCanvas({
  marketData,
  annotations,
  selectedAnnotationId,
  drawingMode,
  currentPrice,
  onChangeMode,
  onSelectAnnotation,
  onCreateAnnotation,
  onAddLineToSelected,
  onAddBoxToSelected,
  onRequestAi,
  onNudgePrice,
  onTriggerSelected
}: ChartCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [draftComposer, setDraftComposer] = useState<DraftComposer | null>(null);
  const [draftText, setDraftText] = useState('');
  const [boxStartPrice, setBoxStartPrice] = useState<number | null>(null);

  const extent = useMemo(() => priceExtent(marketData, currentPrice), [marketData, currentPrice]);
  const xStep = (WIDTH - PADDING * 2) / Math.max(marketData.length - 1, 1);

  const yForPrice = (price: number) => {
    const ratio = (price - extent.min) / (extent.max - extent.min || 1);
    return HEIGHT - PADDING - ratio * (HEIGHT - PADDING * 2);
  };

  const priceForClientY = (clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return currentPrice;
    }

    const boundedY = Math.min(Math.max(clientY - rect.top, PADDING), HEIGHT - PADDING);
    const ratio = 1 - (boundedY - PADDING) / (HEIGHT - PADDING * 2);
    return Number((extent.min + ratio * (extent.max - extent.min)).toFixed(2));
  };

  const anchorFromClient = (clientX: number, clientY: number): ChartAnchor => {
    const rect = containerRef.current?.getBoundingClientRect();
    const relativeX = rect ? clientX - rect.left - PADDING : 0;
    const index = Math.min(
      marketData.length - 1,
      Math.max(0, Math.round(relativeX / Math.max(xStep, 1)))
    );
    return {
      index,
      time: marketData[index]?.openTime ?? new Date().toISOString(),
      price: priceForClientY(clientY)
    };
  };

  const handleCanvasClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const anchor = anchorFromClient(event.clientX, event.clientY);
    if (drawingMode === 'text') {
      const rect = containerRef.current?.getBoundingClientRect();
      setDraftComposer({
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
        anchor
      });
      setDraftText('');
      return;
    }

    if (drawingMode === 'line') {
      onAddLineToSelected(anchor.price);
      return;
    }

    if (drawingMode === 'box') {
      if (boxStartPrice === null) {
        setBoxStartPrice(anchor.price);
      } else {
        onAddBoxToSelected(boxStartPrice, anchor.price);
        setBoxStartPrice(null);
      }
    }
  };

  return (
    <section className="chart-shell panel">
      <div className="chart-toolbar-row">
        <div className="drawing-toolbar">
          {[
            { id: 'none', label: 'Select' },
            { id: 'text', label: 'Text' },
            { id: 'line', label: 'Line' },
            { id: 'box', label: 'Box' }
          ].map((tool) => (
            <button
              key={tool.id}
              className={drawingMode === tool.id ? 'active' : ''}
              onClick={() => onChangeMode(tool.id as DrawingMode)}
            >
              {tool.label}
            </button>
          ))}
        </div>
        <div className="chart-actions">
          <button className="secondary" onClick={onRequestAi}>
            AI 분석
          </button>
          <button className="ghost-button" onClick={() => onNudgePrice(-0.004)}>
            가격 -0.4%
          </button>
          <button className="ghost-button" onClick={() => onNudgePrice(0.004)}>
            가격 +0.4%
          </button>
          <button className="accent" onClick={onTriggerSelected}>
            선택 전략 트리거
          </button>
        </div>
      </div>
      <div className="chart-help muted">
        {drawingMode === 'text' && '차트를 클릭해 텍스트 주석을 작성하세요.'}
        {drawingMode === 'line' && '선택된 주석에 수평 라인을 추가합니다.'}
        {drawingMode === 'box' && (boxStartPrice === null ? '시작 가격을 클릭하세요.' : '끝 가격을 클릭해 박스를 완성하세요.')}
        {drawingMode === 'none' && '주석을 선택해 우측 패널에서 전략을 편집하세요.'}
      </div>
      <div className="chart-container" ref={containerRef}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="chart-svg" onClick={handleCanvasClick}>
          <rect x="0" y="0" width={WIDTH} height={HEIGHT} rx="18" className="chart-bg" />
          {Array.from({ length: 5 }, (_, gridIndex) => {
            const y = PADDING + ((HEIGHT - PADDING * 2) / 4) * gridIndex;
            return <line key={gridIndex} x1={PADDING} x2={WIDTH - PADDING} y1={y} y2={y} className="grid-line" />;
          })}
          {marketData.map((candle, index) => {
            const x = PADDING + index * xStep;
            const openY = yForPrice(candle.open);
            const closeY = yForPrice(candle.close);
            const highY = yForPrice(candle.high);
            const lowY = yForPrice(candle.low);
            const rising = candle.close >= candle.open;
            return (
              <g key={candle.openTime}>
                <line x1={x} x2={x} y1={highY} y2={lowY} className="wick-line" />
                <rect
                  x={x - Math.max(xStep * 0.28, 3)}
                  width={Math.max(xStep * 0.56, 6)}
                  y={Math.min(openY, closeY)}
                  height={Math.max(Math.abs(closeY - openY), 2)}
                  className={rising ? 'candle up' : 'candle down'}
                />
              </g>
            );
          })}
          <line
            x1={PADDING}
            x2={WIDTH - PADDING}
            y1={yForPrice(currentPrice)}
            y2={yForPrice(currentPrice)}
            className="current-price-line"
          />
          {annotations.map((annotation) => {
            const selected = annotation.annotationId === selectedAnnotationId;
            const anchorX = PADDING + annotation.chartAnchor.index * xStep;
            const anchorY = yForPrice(annotation.chartAnchor.price);
            const bubbleBox = getAnnotationBubbleBox(annotation.text, anchorX, anchorY);
            return (
              <g key={annotation.annotationId} onClick={() => onSelectAnnotation(annotation.annotationId)}>
                {annotation.drawingObjects.map((object) => {
                  if (object.type === 'line') {
                    return (
                      <line
                        key={object.id}
                        x1={PADDING}
                        x2={WIDTH - PADDING}
                        y1={yForPrice(object.price)}
                        y2={yForPrice(object.price)}
                        className={`annotation-line ${object.role} ${selected ? 'selected' : ''}`}
                      />
                    );
                  }

                  if (object.type === 'box') {
                    const top = yForPrice(Math.max(object.priceFrom, object.priceTo));
                    const bottom = yForPrice(Math.min(object.priceFrom, object.priceTo));
                    return (
                      <rect
                        key={object.id}
                        x={anchorX - 56}
                        y={top}
                        width={112}
                        height={Math.max(bottom - top, 8)}
                        className={`annotation-box ${selected ? 'selected' : ''}`}
                      />
                    );
                  }

                  return null;
                })}
                <circle cx={anchorX} cy={anchorY} r={selected ? 7 : 5} className="anchor-dot" />
                <foreignObject x={bubbleBox.x} y={bubbleBox.y} width={bubbleBox.width} height={bubbleBox.height}>
                  <div className={`annotation-bubble ${selected ? 'selected' : ''}`}>
                    <div className="list-row">
                      <span className={`pill ${annotationBadgeTone(annotation.status)}`}>{annotation.status}</span>
                      <span className="badge-author">{annotation.authorType.toUpperCase()}</span>
                    </div>
                    <p>{annotation.text}</p>
                    <span>{formatPrice(annotation.strategy.entryPrice)}</span>
                  </div>
                </foreignObject>
              </g>
            );
          })}
          <text x={WIDTH - 110} y={yForPrice(currentPrice) - 8} className="price-label">
            {formatPrice(currentPrice)}
          </text>
        </svg>

        {draftComposer ? (
          <div className="draft-composer panel" style={{ left: draftComposer.x, top: draftComposer.y }}>
            <textarea
              autoFocus
              placeholder="여기 지지 재테스트 시 진입..."
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
            />
            <div className="composer-actions">
              <button className="secondary" onClick={() => setDraftComposer(null)}>
                취소
              </button>
              <button
                onClick={() => {
                  if (draftText.trim()) {
                    onCreateAnnotation(draftText.trim(), draftComposer.anchor);
                    setDraftComposer(null);
                    setDraftText('');
                  }
                }}
              >
                저장
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
