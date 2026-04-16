import { useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, Candle, ChartAnchor, DrawingMode, NewsInsight } from '../types/domain';
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
  selectedNewsInsightId: string | null;
  timeframe: string;
  drawingMode: DrawingMode;
  currentPrice: number;
  annotationCreationLocked: boolean;
  aiRequestPending: boolean;
  newsInsights: NewsInsight[];
  onChangeMode: (mode: DrawingMode) => void;
  onSelectAnnotation: (annotationId: string | null) => void;
  onSelectNewsInsight: (insightId: string | null) => void;
  onCreateAnnotation: (text: string, anchor: ChartAnchor) => void;
  onAddLineToSelected: (price: number) => void;
  onAddBoxToSelected: (priceFrom: number, priceTo: number) => void;
  onAddSegmentToSelected: (startAnchor: ChartAnchor, endAnchor: ChartAnchor) => void;
  onRequestAi: () => void;
  onNudgePrice: (deltaRatio: number) => void;
  onTriggerSelected: () => void;
}

const WIDTH = 860;
const HEIGHT = 480;
const PADDING = 36;
const PRICE_AXIS_WIDTH = 76;
const PLOT_RIGHT_GUTTER = 18;
const PRICE_AXIS_INSET = 10;
const TIME_AXIS_HEIGHT = 30;
const AXIS_TICK_TARGET = 5;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function xForIndexAtStep(index: number, xStep: number) {
  return PADDING + index * xStep;
}

function formatHoverTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getAnnotationBubbleBox(text: string, anchorX: number, anchorY: number, mode: 'preview' | 'hover' | 'selected') {
  const maxX = WIDTH - PADDING - PRICE_AXIS_WIDTH - 8;

  if (mode === 'preview') {
    const width = 180;
    const height = 52;
    return {
      width,
      height,
      x: clamp(anchorX + 8, 8, maxX - width),
      y: clamp(anchorY - height - 32, 8, HEIGHT - height - 8)
    };
  }

  if (mode === 'hover') {
    const charsPerLine = 24;
    const estimatedLines = Math.max(2, Math.ceil(text.length / charsPerLine));
    const width = text.length > 72 ? 260 : 228;
    const height = clamp(104 + estimatedLines * 18, 128, 198);

    return {
      width,
      height,
      x: clamp(anchorX + 8, 8, maxX - width),
      y: clamp(anchorY - height - 32, 8, HEIGHT - height - 8)
    };
  }

  const charsPerLine = 20;
  const estimatedLines = Math.max(2, Math.ceil(text.length / charsPerLine));
  const width = text.length > 100 ? 288 : 244;
  const height = clamp(82 + estimatedLines * 20, 116, 220);

  return {
    width,
    height,
    x: clamp(anchorX + 8, 8, maxX - width),
    y: clamp(anchorY - height - 32, 8, HEIGHT - height - 8)
  };
}

function getNewsInsightBubbleBox(insight: NewsInsight, anchorX: number, anchorY: number) {
  const maxX = WIDTH - PADDING - PRICE_AXIS_WIDTH - 8;
  const textLength = insight.headline.length + insight.summary.length + insight.aiComment.length;
  const estimatedLines = Math.max(6, Math.ceil(textLength / 34));
  const width = textLength > 220 ? 340 : 310;
  const height = clamp(136 + estimatedLines * 16, 176, 280);

  return {
    width,
    height,
    x: clamp(anchorX + 10, 8, maxX - width),
    y: clamp(anchorY - height - 12, 8, HEIGHT - height - 8)
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

function getNiceStep(range: number, tickCount: number) {
  const safeRange = Math.max(range, 0.0001);
  const rawStep = safeRange / Math.max(tickCount - 1, 1);
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = 10 ** exponent;
  const fraction = rawStep / magnitude;

  if (fraction <= 1) return magnitude;
  if (fraction <= 2) return 2 * magnitude;
  if (fraction <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function buildPriceScale(min: number, max: number, tickCount: number) {
  const step = getNiceStep(max - min, tickCount);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];

  for (let value = niceMax; value >= niceMin - step * 0.5; value -= step) {
    ticks.push(Number(value.toFixed(8)));
  }

  return {
    min: niceMin,
    max: niceMax,
    ticks
  };
}

function formatTimeAxisLabel(value: string, timeframe: string, showDate: boolean) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  if (timeframe === '15m') {
    return showDate
      ? parsed.toLocaleString('ko-KR', {
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        })
      : parsed.toLocaleTimeString('ko-KR', {
          hour: 'numeric',
          minute: '2-digit'
        });
  }

  if (timeframe === '1h') {
    return showDate
      ? parsed.toLocaleString('ko-KR', {
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric'
        })
      : parsed.toLocaleTimeString('ko-KR', {
          hour: 'numeric'
        });
  }

  if (showDate) {
    return parsed.toLocaleString('ko-KR', {
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric'
    });
  }

  return parsed.toLocaleDateString('ko-KR', {
    month: 'numeric',
    day: 'numeric'
  });
}

export function ChartCanvas({
  marketData,
  annotations,
  selectedAnnotationId,
  selectedNewsInsightId,
  timeframe,
  drawingMode,
  currentPrice,
  annotationCreationLocked,
  aiRequestPending,
  newsInsights,
  onChangeMode,
  onSelectAnnotation,
  onSelectNewsInsight,
  onCreateAnnotation,
  onAddLineToSelected,
  onAddBoxToSelected,
  onAddSegmentToSelected,
  onRequestAi,
  onNudgePrice,
  onTriggerSelected
}: ChartCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [draftComposer, setDraftComposer] = useState<DraftComposer | null>(null);
  const [draftText, setDraftText] = useState('');
  const [boxStartPrice, setBoxStartPrice] = useState<number | null>(null);
  const [segmentStartAnchor, setSegmentStartAnchor] = useState<ChartAnchor | null>(null);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  const [hoveredInsightId, setHoveredInsightId] = useState<string | null>(null);

  const rawExtent = useMemo(() => priceExtent(marketData, currentPrice), [marketData, currentPrice]);
  const priceScale = useMemo(
    () => buildPriceScale(rawExtent.min, rawExtent.max, AXIS_TICK_TARGET),
    [rawExtent.max, rawExtent.min]
  );
  const plotTop = PADDING;
  const plotBottom = HEIGHT - PADDING - TIME_AXIS_HEIGHT;
  const plotHeight = plotBottom - plotTop;
  const axisDividerX = WIDTH - PADDING - PRICE_AXIS_WIDTH;
  const plotRight = axisDividerX - PLOT_RIGHT_GUTTER;
  const axisLeft = axisDividerX + PRICE_AXIS_INSET;
  const axisRight = WIDTH - 12;
  const axisWidth = axisRight - axisLeft;
  const axisLabelTop = 24;
  const axisLabelBottom = plotBottom - 8;
  const xStep = (plotRight - PADDING) / Math.max(marketData.length - 1, 1);
  const priceTicks = useMemo(
    () => priceScale.ticks.map((price) => ({ price })),
    [priceScale.ticks]
  );
  const timeTicks = useMemo(() => {
    if (marketData.length === 0) {
      return [];
    }

    const positions = Array.from({ length: 5 }, (_, index) => Math.round((Math.max(marketData.length - 1, 0) * index) / 4));
    const uniquePositions = positions.filter((value, index) => positions.indexOf(value) === index);
    const firstTime = new Date(marketData[0]?.openTime ?? Date.now()).getTime();
    const lastTime = new Date(marketData[marketData.length - 1]?.openTime ?? Date.now()).getTime();
    const showDate = timeframe === '4h' || lastTime - firstTime >= 24 * 60 * 60 * 1000;

    return uniquePositions.map((index, positionIndex, array) => ({
      index,
      x: xForIndexAtStep(index, xStep),
      label: formatTimeAxisLabel(marketData[index]?.openTime ?? '', timeframe, showDate),
      anchor: (positionIndex === 0 ? 'start' : positionIndex === array.length - 1 ? 'end' : 'middle') as
        | 'start'
        | 'middle'
        | 'end'
    }));
  }, [marketData, timeframe, xStep]);

  const candleIndexByTime = useMemo(
    () => new Map(marketData.map((candle, index) => [candle.openTime, index])),
    [marketData]
  );

  useEffect(() => {
    if (drawingMode !== 'box' && boxStartPrice !== null) {
      setBoxStartPrice(null);
    }
    if (drawingMode !== 'segment' && segmentStartAnchor !== null) {
      setSegmentStartAnchor(null);
    }
    if (annotationCreationLocked && draftComposer !== null) {
      setDraftComposer(null);
      setDraftText('');
    }
  }, [annotationCreationLocked, boxStartPrice, draftComposer, drawingMode, segmentStartAnchor]);

  const yForPrice = (price: number) => {
    const ratio = (price - priceScale.min) / (priceScale.max - priceScale.min || 1);
    return plotBottom - ratio * plotHeight;
  };

  const currentPriceY = yForPrice(currentPrice);

  const xForIndex = (index: number) => PADDING + index * xStep;

  const resolveTimeIndex = (time: string, fallbackIndex: number) => {
    const exact = candleIndexByTime.get(time);
    if (typeof exact === 'number') {
      return exact;
    }

    const targetTime = new Date(time).getTime();
    if (Number.isNaN(targetTime) || marketData.length === 0) {
      return clamp(fallbackIndex, 0, Math.max(marketData.length - 1, 0));
    }

    let closestIndex = clamp(fallbackIndex, 0, Math.max(marketData.length - 1, 0));
    let smallestGap = Number.POSITIVE_INFINITY;

    marketData.forEach((candle, index) => {
      const candleTime = new Date(candle.openTime).getTime();
      if (Number.isNaN(candleTime)) {
        return;
      }

      const gap = Math.abs(candleTime - targetTime);
      if (gap < smallestGap) {
        smallestGap = gap;
        closestIndex = index;
      }
    });

    return closestIndex;
  };

  const resolveAnchorIndex = (anchor: ChartAnchor) => resolveTimeIndex(anchor.time, anchor.index);

  const resolveInsightIndex = (insight: NewsInsight) => resolveTimeIndex(insight.time, insight.candleIndex);

  const priceForClientY = (clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return currentPrice;
    }

    const boundedY = Math.min(Math.max(clientY - rect.top, plotTop), plotBottom);
    const ratio = 1 - (boundedY - plotTop) / (plotHeight || 1);
    return Number((priceScale.min + ratio * (priceScale.max - priceScale.min)).toFixed(2));
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

    if (drawingMode === 'none') {
      onSelectAnnotation(null);
      return;
    }

    if (annotationCreationLocked) {
      return;
    }

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

    if (drawingMode === 'segment') {
      if (segmentStartAnchor === null) {
        setSegmentStartAnchor(anchor);
      } else {
        onAddSegmentToSelected(segmentStartAnchor, anchor);
        setSegmentStartAnchor(null);
      }
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

  const hoveredAnnotation =
    annotations.find(
      (annotation) => annotation.annotationId === hoveredAnnotationId && annotation.annotationId !== selectedAnnotationId
    ) ?? null;

  const hoveredAnnotationBubble = hoveredAnnotation
    ? (() => {
        const resolvedIndex = resolveAnchorIndex(hoveredAnnotation.chartAnchor);
        const anchorX = xForIndex(resolvedIndex);
        const anchorY = yForPrice(hoveredAnnotation.chartAnchor.price);
        const hoverBox = getAnnotationBubbleBox(hoveredAnnotation.text, anchorX, anchorY, 'hover');

        return {
          annotation: hoveredAnnotation,
          hoverBox
        };
      })()
    : null;

  return (
    <section className="chart-shell panel">
      <div className="chart-toolbar-row">
        <div className="drawing-toolbar">
          {[
            { id: 'none', label: 'Select' },
            { id: 'text', label: 'Text' },
            { id: 'line', label: 'Line' },
            { id: 'segment', label: 'Diagonal' },
            { id: 'box', label: 'Box' }
          ].map((tool) => (
            <button
              key={tool.id}
              className={drawingMode === tool.id ? 'active' : ''}
              disabled={annotationCreationLocked && tool.id !== 'none'}
              onClick={() => onChangeMode(tool.id as DrawingMode)}
            >
              {tool.label}
            </button>
          ))}
        </div>
        <div className="chart-actions">
          <button className={aiRequestPending ? 'ai-cta-button is-loading' : 'ai-cta-button'} onClick={onRequestAi} disabled={annotationCreationLocked || aiRequestPending}>
            <span className="ai-cta-icon" aria-hidden>
              {aiRequestPending ? '◌' : '✦'}
            </span>
            <span className="ai-cta-label">{aiRequestPending ? 'Analyzing…' : 'AI analysis'}</span>
            <span className="ai-cta-badge" aria-hidden>
              {aiRequestPending ? 'LIVE' : 'AI'}
            </span>
          </button>
          <button className="ghost-button" onClick={() => onNudgePrice(-0.004)}>
            Price -0.4%
          </button>
          <button className="ghost-button" onClick={() => onNudgePrice(0.004)}>
            Price +0.4%
          </button>
          <button className="secondary" onClick={onTriggerSelected}>
            Trigger selected setup
          </button>
        </div>
      </div>
      <div className="chart-help muted">
        {annotationCreationLocked && 'Connect a wallet to create annotations.'}
        {drawingMode === 'text' && 'Click the chart to place a text annotation.'}
        {drawingMode === 'line' && 'Add a horizontal line to the selected annotation.'}
        {drawingMode === 'segment' && (segmentStartAnchor === null ? 'Click the first point.' : 'Click the second point to finish the diagonal line.')}
        {drawingMode === 'box' && (boxStartPrice === null ? 'Click the start price.' : 'Click the end price to complete the box.')}
        {drawingMode === 'none' && 'Select an annotation to edit its strategy in the right panel.'}
      </div>
      <div className="chart-container" ref={containerRef}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="chart-svg" onClick={handleCanvasClick}>
          <rect x="0" y="0" width={WIDTH} height={HEIGHT} rx="18" className="chart-bg" />
          <line x1={axisDividerX} x2={axisDividerX} y1={12} y2={plotBottom} className="price-axis-divider" />
          <line x1={PADDING} x2={axisDividerX} y1={plotBottom + 8} y2={plotBottom + 8} className="time-axis-divider" />
          <rect x={axisLeft} y={12} width={axisWidth} height={plotBottom - 12} rx="14" className="price-axis-bg" />
          {priceTicks.map((tick, gridIndex) => {
            const y = yForPrice(tick.price);
            return <line key={gridIndex} x1={PADDING} x2={axisDividerX} y1={y} y2={y} className="grid-line" />;
          })}
          {marketData.map((candle, index) => {
            const x = xForIndex(index);
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
            x2={axisDividerX}
            y1={yForPrice(currentPrice)}
            y2={yForPrice(currentPrice)}
            className="current-price-line"
          />
          {priceTicks.map((tick, index) => (
            Math.abs(yForPrice(tick.price) - currentPriceY) > 18 ? (
              <g key={`price-tick-${index}`}>
                <line x1={axisDividerX} x2={axisLeft - 4} y1={yForPrice(tick.price)} y2={yForPrice(tick.price)} className="price-axis-tick" />
                <text
                  x={axisRight - 8}
                  y={clamp(yForPrice(tick.price) + 4, axisLabelTop, axisLabelBottom)}
                  textAnchor="end"
                  className="price-axis-label"
                >
                  {formatPrice(tick.price)}
                </text>
              </g>
            ) : null
          ))}
          <g className="current-price-badge-group">
            <rect
              x={axisLeft + 2}
              y={currentPriceY - 13}
              width={axisWidth - 4}
              height={26}
              rx={13}
              className="current-price-badge"
            />
            <text
              x={axisRight - 8}
              y={clamp(currentPriceY + 4, axisLabelTop, axisLabelBottom)}
              textAnchor="end"
              className="price-label current-price-text"
            >
              {formatPrice(currentPrice)}
            </text>
          </g>
          {newsInsights.map((insight) => {
            const ix = resolveInsightIndex(insight);
            const candle = marketData[ix];
            if (!candle) return null;
            const markerX = xForIndex(ix);
            const markerY = insight.direction === 'spike' ? yForPrice(candle.high) - 18 : yForPrice(candle.low) + 18;
            const isHovered = hoveredInsightId === insight.insightId;
            const isSelected = selectedNewsInsightId === insight.insightId;

            return (
              <g
                key={insight.insightId}
                className={`news-insight-marker ${insight.direction} ${isHovered ? 'hovered' : ''} ${isSelected ? 'selected' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectNewsInsight(insight.insightId);
                }}
                onMouseEnter={() => setHoveredInsightId(insight.insightId)}
                onMouseLeave={() => setHoveredInsightId((current) => (current === insight.insightId ? null : current))}
              >
                <line
                  x1={markerX}
                  x2={markerX}
                  y1={insight.direction === 'spike' ? markerY + 10 : markerY - 10}
                  y2={insight.direction === 'spike' ? markerY + 2 : markerY - 2}
                  className="news-insight-stem"
                />
                <circle cx={markerX} cy={markerY} r={isHovered || isSelected ? 8 : 6} className="news-insight-dot" />
                <text x={markerX} y={markerY + 4} textAnchor="middle" className="news-insight-icon">📰</text>
              </g>
            );
          })}
          {annotations.map((annotation) => {
            const selected = annotation.annotationId === selectedAnnotationId;
            const hovered = annotation.annotationId === hoveredAnnotationId && !selected;
            const anchorIndex = resolveAnchorIndex(annotation.chartAnchor);
            const anchorX = xForIndex(anchorIndex);
            const anchorY = yForPrice(annotation.chartAnchor.price);
            return (
              <g
                key={annotation.annotationId}
                className={`annotation-pin-group ${selected ? 'selected' : ''} ${hovered ? 'hovered' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectAnnotation(annotation.annotationId);
                }}
                onMouseEnter={() => setHoveredAnnotationId(annotation.annotationId)}
                onMouseLeave={() => setHoveredAnnotationId((current) => (current === annotation.annotationId ? null : current))}
              >
                {selected
                  ? annotation.drawingObjects.map((object) => {
                  if (object.type === 'line') {
                    return (
                      <line
                        key={object.id}
                        x1={PADDING}
                        x2={axisDividerX}
                        y1={yForPrice(object.price)}
                        y2={yForPrice(object.price)}
                        className={`annotation-line ${object.role} ${selected ? 'selected' : ''}`}
                      />
                    );
                  }

                  if (object.type === 'box') {
                    const top = yForPrice(Math.max(object.priceFrom, object.priceTo));
                    const bottom = yForPrice(Math.min(object.priceFrom, object.priceTo));
                    const boxLeft = clamp(anchorX - 56, PADDING, plotRight - 36);
                    const boxWidth = Math.max(Math.min(112, plotRight - boxLeft), 24);
                    return (
                      <rect
                        key={object.id}
                        x={boxLeft}
                        y={top}
                        width={boxWidth}
                        height={Math.max(bottom - top, 8)}
                        className={`annotation-box ${selected ? 'selected' : ''}`}
                      />
                    );
                  }

                  if (object.type === 'segment') {
                    const startIndex = resolveAnchorIndex(object.startAnchor);
                    const endIndex = resolveAnchorIndex(object.endAnchor);
                    return (
                      <line
                        key={object.id}
                        x1={xForIndex(startIndex)}
                        y1={yForPrice(object.startAnchor.price)}
                        x2={xForIndex(endIndex)}
                        y2={yForPrice(object.endAnchor.price)}
                        className={`annotation-line ${object.role} ${selected ? 'selected' : ''}`}
                      />
                    );
                  }

                  return null;
                    })
                  : null}
                <line x1={anchorX} x2={anchorX} y1={anchorY - 12} y2={anchorY - 2} className="annotation-pin-stem" />
                <circle cx={anchorX} cy={anchorY - 16} r={selected ? 7 : 5} className="annotation-pin" />
                <circle cx={anchorX} cy={anchorY - 16} r="2" className="annotation-pin-core" />
              </g>
            );
          })}
          {hoveredAnnotationBubble && (
            <foreignObject
              x={hoveredAnnotationBubble.hoverBox.x}
              y={hoveredAnnotationBubble.hoverBox.y}
              width={hoveredAnnotationBubble.hoverBox.width}
              height={hoveredAnnotationBubble.hoverBox.height}
              pointerEvents="none"
            >
              <div className="annotation-bubble annotation-bubble-hover">
                <div className="list-row annotation-bubble-header">
                  <span className={`pill ${annotationBadgeTone(hoveredAnnotationBubble.annotation.status)}`}>
                    {hoveredAnnotationBubble.annotation.status}
                  </span>
                  <span className="badge-author">{hoveredAnnotationBubble.annotation.authorType.toUpperCase()}</span>
                </div>
                <p>{hoveredAnnotationBubble.annotation.text}</p>
                <div className="annotation-hover-meta">
                  <span className="annotation-meta-item">@ {formatPrice(hoveredAnnotationBubble.annotation.chartAnchor.price)}</span>
                  <span className="annotation-meta-item">{hoveredAnnotationBubble.annotation.timeframe.toUpperCase()}</span>
                  <span className="annotation-meta-item">{formatHoverTime(hoveredAnnotationBubble.annotation.chartAnchor.time)}</span>
                </div>
              </div>
            </foreignObject>
          )}
          {/* ─── News Insight hover bubble ─── */}
          {newsInsights
            .filter((insight) => insight.insightId === hoveredInsightId)
            .map((insight) => {
              const ix = resolveInsightIndex(insight);
              const candle = marketData[ix];
              if (!candle) return null;
              const markerX = xForIndex(ix);
              const markerY = insight.direction === 'spike' ? yForPrice(candle.high) - 18 : yForPrice(candle.low) + 18;
              const bubbleBox = getNewsInsightBubbleBox(insight, markerX, markerY);
              return (
                <foreignObject
                  key={`bubble-${insight.insightId}`}
                  x={bubbleBox.x}
                  y={bubbleBox.y}
                  width={bubbleBox.width}
                  height={bubbleBox.height}
                  pointerEvents="none"
                >
                  <div className="news-insight-bubble">
                    <div className="news-insight-bubble-header">
                      <span className={`news-sentiment-pill ${insight.sentiment}`}>{insight.direction === 'spike' ? '▲' : '▼'} {Math.abs(insight.priceChangePercent).toFixed(1)}%</span>
                      <span className="news-insight-time">{formatHoverTime(insight.time)}</span>
                    </div>
                    <p className="news-insight-headline">{insight.headline}</p>
                    <p className="news-insight-summary">{insight.summary}</p>
                    <p className="news-insight-comment">💡 {insight.aiComment}</p>
                  </div>
                </foreignObject>
              );
            })}
          {timeTicks.map((tick) => (
            <g key={`time-tick-${tick.index}`}>
              <line x1={tick.x} x2={tick.x} y1={plotBottom + 8} y2={plotBottom + 14} className="time-axis-tick" />
              <text x={tick.x} y={HEIGHT - 14} textAnchor={tick.anchor} className="time-axis-label">
                {tick.label}
              </text>
            </g>
          ))}
        </svg>

        {draftComposer ? (
          <div className="draft-composer panel" style={{ left: draftComposer.x, top: draftComposer.y }}>
            <textarea
              autoFocus
              placeholder="Retest of support here could offer a clean entry..."
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
            />
            <div className="composer-actions">
              <button className="secondary" onClick={() => setDraftComposer(null)}>
                Cancel
              </button>
              <button
                disabled={annotationCreationLocked || !draftText.trim()}
                onClick={() => {
                  if (draftText.trim()) {
                    onCreateAnnotation(draftText.trim(), draftComposer.anchor);
                    setDraftComposer(null);
                    setDraftText('');
                  }
                }}
              >
                Save
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
