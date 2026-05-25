import { useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, Candle, ChartAnchor, DrawingMode, NewsInsight } from '../types/domain';
import { annotationBadgeTone, formatPrice } from '../utils/strategy';

interface DraftComposer {
  x: number;
  y: number;
  anchor: ChartAnchor;
}

interface ChartCanvasProps {
  minimal?: boolean;
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
const MINIMAL_WIDTH = 1180;
const MINIMAL_HEIGHT = 640;
const MINIMAL_PRICE_AXIS_WIDTH = 84;
const MINIMAL_MIN_VISIBLE_CANDLES = 24;
const MINIMAL_VISIBLE_CANDLES = 72;
const PRICE_BADGE_HEIGHT = 26;
const PRICE_BADGE_HALF_HEIGHT = PRICE_BADGE_HEIGHT / 2;
const PRICE_BADGE_SEPARATION = PRICE_BADGE_HEIGHT + 4;
const PADDING = 36;
const PRICE_AXIS_WIDTH = 76;
const PLOT_RIGHT_GUTTER = 18;
const PRICE_AXIS_INSET = 10;
const TIME_AXIS_HEIGHT = 30;
const AXIS_TICK_TARGET = 5;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function xForIndexAtStep(index: number, xStep: number, padding: number) {
  return padding + index * xStep;
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

function getAnnotationBubbleBox(
  text: string,
  anchorX: number,
  anchorY: number,
  mode: 'preview' | 'hover' | 'selected',
  bounds: { maxX: number; height: number }
) {
  const maxX = bounds.maxX;

  if (mode === 'preview') {
    const width = 180;
    const height = 52;
    return {
      width,
      height,
      x: clamp(anchorX + 8, 8, maxX - width),
      y: clamp(anchorY - height - 32, 8, bounds.height - height - 8)
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
      y: clamp(anchorY - height - 32, 8, bounds.height - height - 8)
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
    y: clamp(anchorY - height - 32, 8, bounds.height - height - 8)
  };
}

function getNewsInsightBubbleBox(insight: NewsInsight, anchorX: number, anchorY: number, bounds: { maxX: number; height: number }) {
  const maxX = bounds.maxX;
  const textLength = insight.headline.length + insight.summary.length + insight.aiComment.length;
  const estimatedLines = Math.max(6, Math.ceil(textLength / 34));
  const width = textLength > 220 ? 340 : 310;
  const height = clamp(136 + estimatedLines * 16, 176, 280);

  return {
    width,
    height,
    x: clamp(anchorX + 10, 8, maxX - width),
    y: clamp(anchorY - height - 12, 8, bounds.height - height - 8)
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

function getTimeTickStride(visibleCandleCount: number, timeframe: string) {
  const tickTarget = 5;
  const desiredStride = Math.max(1, visibleCandleCount / tickTarget);
  const strideCandidates =
    timeframe === '15m'
      ? [4, 8, 12, 16, 24, 32, 48, 96]
      : timeframe === '1h'
        ? [2, 4, 6, 8, 12, 24, 48, 72, 168]
        : [2, 3, 4, 6, 8, 12, 18, 24, 42];

  return strideCandidates.reduce((bestStride, candidateStride) => {
    const bestDistance = Math.abs(bestStride - desiredStride);
    const candidateDistance = Math.abs(candidateStride - desiredStride);
    return candidateDistance < bestDistance ? candidateStride : bestStride;
  }, strideCandidates[0]);
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
  minimal = false,
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
  const dragStartXRef = useRef<number | null>(null);
  const dragStartOffsetRef = useRef(0);
  const previousViewportRef = useRef<{ marketLength: number; visibleCandleCount: number } | null>(null);
  const [draftComposer, setDraftComposer] = useState<DraftComposer | null>(null);
  const [draftText, setDraftText] = useState('');
  const [boxStartPrice, setBoxStartPrice] = useState<number | null>(null);
  const [segmentStartAnchor, setSegmentStartAnchor] = useState<ChartAnchor | null>(null);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  const [hoveredInsightId, setHoveredInsightId] = useState<string | null>(null);
  const [horizontalOffset, setHorizontalOffset] = useState(0);
  const [visibleWindowSize, setVisibleWindowSize] = useState(MINIMAL_VISIBLE_CANDLES);
  const [isDragging, setIsDragging] = useState(false);

  const renderWidth = minimal ? MINIMAL_WIDTH : WIDTH;
  const renderHeight = minimal ? MINIMAL_HEIGHT : HEIGHT;
  const padding = minimal ? 16 : PADDING;
  const priceAxisWidth = minimal ? MINIMAL_PRICE_AXIS_WIDTH : PRICE_AXIS_WIDTH;
  const plotRightGutter = minimal ? 8 : PLOT_RIGHT_GUTTER;
  const priceAxisInset = minimal ? 6 : PRICE_AXIS_INSET;
  const timeAxisHeight = minimal ? 20 : TIME_AXIS_HEIGHT;
  const annotationBoxClampRight = minimal ? 16 : 36;
  const visibleCandleCount = minimal
    ? clamp(Math.min(visibleWindowSize, marketData.length || MINIMAL_VISIBLE_CANDLES), MINIMAL_MIN_VISIBLE_CANDLES, Math.max(marketData.length, MINIMAL_MIN_VISIBLE_CANDLES))
    : marketData.length;
  const maxHorizontalOffset = Math.max(marketData.length - visibleCandleCount, 0);
  const effectiveHorizontalOffset = clamp(horizontalOffset, 0, maxHorizontalOffset);
  const visibleMarketData = useMemo(
    () => (minimal ? marketData.slice(effectiveHorizontalOffset, effectiveHorizontalOffset + visibleCandleCount) : marketData),
    [effectiveHorizontalOffset, marketData, minimal, visibleCandleCount]
  );
  const viewportReferenceCandle = visibleMarketData.at(-1) ?? null;
  const viewportReferencePrice = minimal ? (visibleMarketData.at(-1)?.close ?? currentPrice) : currentPrice;
  const actualCurrentPrice = currentPrice;
  const viewportReferenceTone = viewportReferenceCandle && viewportReferenceCandle.close >= viewportReferenceCandle.open ? 'up' : 'down';
  const showViewportReferencePrice =
    minimal &&
    effectiveHorizontalOffset !== maxHorizontalOffset &&
    Math.abs(viewportReferencePrice - actualCurrentPrice) > Math.max(Math.abs(actualCurrentPrice) * 0.0001, 0.01);
  const bubbleBounds = useMemo(
    () => ({ maxX: renderWidth - padding - priceAxisWidth - 8, height: renderHeight }),
    [padding, priceAxisWidth, renderHeight, renderWidth]
  );

  useEffect(() => {
    if (!minimal) {
      previousViewportRef.current = { marketLength: marketData.length, visibleCandleCount };
      return;
    }

    const previousViewport = previousViewportRef.current;
    previousViewportRef.current = { marketLength: marketData.length, visibleCandleCount };

    if (!previousViewport) {
      setHorizontalOffset(maxHorizontalOffset);
      return;
    }

    if (previousViewport.marketLength === marketData.length) {
      return;
    }

    const previousMaxOffset = Math.max(previousViewport.marketLength - previousViewport.visibleCandleCount, 0);
    setHorizontalOffset((current) => {
      const wasPinnedToLatest = current >= previousMaxOffset;
      return wasPinnedToLatest ? maxHorizontalOffset : clamp(current, 0, maxHorizontalOffset);
    });
  }, [marketData.length, maxHorizontalOffset, minimal, visibleCandleCount]);

  useEffect(() => {
    if (!minimal) {
      return;
    }

    setVisibleWindowSize((current) => clamp(current, MINIMAL_MIN_VISIBLE_CANDLES, Math.max(marketData.length, MINIMAL_MIN_VISIBLE_CANDLES)));
  }, [marketData.length, minimal]);

  const rawExtent = useMemo(() => {
    const baseExtent = priceExtent(visibleMarketData, viewportReferencePrice);
    const drawingPrices = annotations
      .filter((annotation) => annotation.annotationId === selectedAnnotationId)
      .flatMap((annotation) =>
        annotation.drawingObjects.flatMap((object) => {
          if (object.type === 'line') {
            return [object.price];
          }
          if (object.type === 'box') {
            return [object.priceFrom, object.priceTo];
          }
          if (object.type === 'segment') {
            return [object.startAnchor.price, object.endAnchor.price];
          }
          return [];
        })
      )
      .filter((price) => Number.isFinite(price));
    return {
      min: Math.min(baseExtent.min, actualCurrentPrice * 0.995, ...drawingPrices),
      max: Math.max(baseExtent.max, actualCurrentPrice * 1.005, ...drawingPrices)
    };
  }, [actualCurrentPrice, annotations, selectedAnnotationId, viewportReferencePrice, visibleMarketData]);
  const priceScale = useMemo(
    () => buildPriceScale(rawExtent.min, rawExtent.max, AXIS_TICK_TARGET),
    [rawExtent.max, rawExtent.min]
  );
  const plotTop = padding;
  const plotBottom = renderHeight - padding - timeAxisHeight;
  const plotHeight = plotBottom - plotTop;
  const axisDividerX = renderWidth - padding - priceAxisWidth;
  const plotRight = axisDividerX - plotRightGutter;
  const axisLeft = axisDividerX + priceAxisInset;
  const axisRight = renderWidth - 12;
  const axisWidth = axisRight - axisLeft;
  const axisLabelTop = 24;
  const axisLabelBottom = plotBottom - 8;
  const xStep = (plotRight - padding) / Math.max(visibleMarketData.length - 1, 1);
  const priceTicks = useMemo(
    () => priceScale.ticks.map((price) => ({ price })),
    [priceScale.ticks]
  );
  const timeTicks = useMemo(() => {
    if (visibleMarketData.length === 0 || marketData.length === 0) {
      return [];
    }

    const firstTime = new Date(visibleMarketData[0]?.openTime ?? Date.now()).getTime();
    const lastTime = new Date(visibleMarketData[visibleMarketData.length - 1]?.openTime ?? Date.now()).getTime();
    const showDate = timeframe === '4h' || lastTime - firstTime >= 24 * 60 * 60 * 1000;
    const tickStride = getTimeTickStride(visibleCandleCount, timeframe);
    const visibleStartIndex = effectiveHorizontalOffset;
    const visibleEndIndex = effectiveHorizontalOffset + visibleMarketData.length - 1;
    const firstTickIndex = Math.ceil(visibleStartIndex / tickStride) * tickStride;
    const tickIndexes: number[] = [];

    for (let globalIndex = firstTickIndex; globalIndex <= visibleEndIndex; globalIndex += tickStride) {
      tickIndexes.push(globalIndex);
    }

    if (tickIndexes.length === 0) {
      tickIndexes.push(clamp(visibleStartIndex, 0, marketData.length - 1));
    }

    return tickIndexes.map((globalIndex) => {
      const localIndex = globalIndex - effectiveHorizontalOffset;
      const x = xForIndexAtStep(localIndex, xStep, padding);
      const anchor = x <= padding + 24 ? 'start' : x >= plotRight - 24 ? 'end' : 'middle';

      return {
        index: globalIndex,
        x,
        label: formatTimeAxisLabel(marketData[globalIndex]?.openTime ?? '', timeframe, showDate),
        anchor: anchor as
        | 'start'
        | 'middle'
        | 'end'
      };
    });
  }, [effectiveHorizontalOffset, marketData, plotRight, timeframe, visibleCandleCount, visibleMarketData, xStep]);

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

  const selectedPriceAxisMarkers = useMemo(() => {
    const selectedAnnotation = annotations.find((annotation) => annotation.annotationId === selectedAnnotationId);
    if (!selectedAnnotation) {
      return [];
    }

    return selectedAnnotation.drawingObjects.flatMap((object) => {
      if (object.type !== 'line' || !['entry', 'stop_loss', 'take_profit'].includes(object.role)) {
        return [];
      }

      return [{
        id: object.id,
        role: object.role,
        price: object.price
      }];
    });
  }, [annotations, selectedAnnotationId]);

  const currentPriceY = yForPrice(actualCurrentPrice);
  const viewportReferencePriceY = yForPrice(viewportReferencePrice);
  const priceBadgeMinCenterY = 12 + PRICE_BADGE_HALF_HEIGHT;
  const priceBadgeMaxCenterY = plotBottom - PRICE_BADGE_HALF_HEIGHT;
  const currentPriceBadgeCenterY = clamp(currentPriceY, priceBadgeMinCenterY, priceBadgeMaxCenterY);
  const viewportReferenceBadgeBaseY = clamp(viewportReferencePriceY, priceBadgeMinCenterY, priceBadgeMaxCenterY);
  const viewportReferenceBadgeCenterY = (() => {
    if (!showViewportReferencePrice) {
      return viewportReferenceBadgeBaseY;
    }

    const occupiedCenters = [currentPriceBadgeCenterY];
    let center = viewportReferenceBadgeBaseY;

    for (let step = 0; step < occupiedCenters.length + 3; step += 1) {
      const conflictingCenter = occupiedCenters.find((occupiedY) => Math.abs(center - occupiedY) < PRICE_BADGE_SEPARATION);
      if (conflictingCenter === undefined) {
        return center;
      }
      center = clamp(Math.min(center, conflictingCenter) - PRICE_BADGE_SEPARATION, priceBadgeMinCenterY, priceBadgeMaxCenterY);
    }

    return center;
  })();

  const xForIndex = (index: number) => padding + index * xStep;
  const isVisibleGlobalIndex = (index: number) => index >= effectiveHorizontalOffset && index < effectiveHorizontalOffset + visibleMarketData.length;
  const localIndexFromGlobal = (index: number) => index - effectiveHorizontalOffset;

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

  const visibleSelectedPriceAxisMarkers = selectedPriceAxisMarkers.filter((marker) => {
    const markerY = clamp(yForPrice(marker.price), axisLabelTop, axisLabelBottom);
    const conflictsWithCurrentPrice = Math.abs(markerY - currentPriceBadgeCenterY) < PRICE_BADGE_SEPARATION;
    return !conflictsWithCurrentPrice;
  });
  const renderAnnotations = useMemo(
    () =>
      [...annotations].sort((left, right) => {
        if (left.annotationId === selectedAnnotationId) return 1;
        if (right.annotationId === selectedAnnotationId) return -1;
        return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
      }),
    [annotations, selectedAnnotationId]
  );

  const priceForClientY = (clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return viewportReferencePrice;
    }

    const boundedY = Math.min(Math.max(clientY - rect.top, plotTop), plotBottom);
    const ratio = 1 - (boundedY - plotTop) / (plotHeight || 1);
    return Number((priceScale.min + ratio * (priceScale.max - priceScale.min)).toFixed(2));
  };

  const anchorFromClient = (clientX: number, clientY: number): ChartAnchor => {
    const rect = containerRef.current?.getBoundingClientRect();
    const relativeX = rect ? clientX - rect.left - padding : 0;
    const localIndex = Math.min(visibleMarketData.length - 1, Math.max(0, Math.round(relativeX / Math.max(xStep, 1))));
    const index = minimal ? effectiveHorizontalOffset + localIndex : localIndex;
    return {
      index,
      time: marketData[index]?.openTime ?? new Date().toISOString(),
      price: priceForClientY(clientY)
    };
  };

  const handleChartWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!minimal) {
      return;
    }

    const horizontalDelta = Math.abs(event.deltaX);
    const verticalDelta = Math.abs(event.deltaY);
    const hasHorizontalIntent = horizontalDelta > 0 && (horizontalDelta >= 2 || horizontalDelta >= verticalDelta * 0.2);
    const panDelta = hasHorizontalIntent ? event.deltaX : event.shiftKey ? event.deltaY : 0;

    if (panDelta !== 0) {
      if (maxHorizontalOffset === 0) {
        return;
      }

      event.preventDefault();
      const step = Math.max(1, Math.round(Math.abs(panDelta) / 48));
      setHorizontalOffset((current) => clamp(current + (panDelta > 0 ? step : -step), 0, maxHorizontalOffset));
      return;
    }

    if (event.deltaY === 0) {
      return;
    }

    event.preventDefault();
    const plotWidth = Math.max(plotRight - padding, 1);
    const rect = containerRef.current?.getBoundingClientRect();
    const relativeX = rect ? clamp(event.clientX - rect.left - padding, 0, plotWidth) : plotWidth;
    const anchorRatio = plotWidth <= 0 ? 1 : relativeX / plotWidth;
    const currentWindowSize = visibleCandleCount;
    const nextWindowSize = clamp(
      Math.round(currentWindowSize * (event.deltaY < 0 ? 0.9 : 1.12)),
      MINIMAL_MIN_VISIBLE_CANDLES,
      Math.max(marketData.length, MINIMAL_MIN_VISIBLE_CANDLES)
    );

    if (nextWindowSize === currentWindowSize) {
      return;
    }

    const currentSpan = Math.max(currentWindowSize - 1, 1);
    const nextSpan = Math.max(nextWindowSize - 1, 1);
    const anchorIndex = effectiveHorizontalOffset + anchorRatio * currentSpan;
    const nextMaxOffset = Math.max(marketData.length - nextWindowSize, 0);
    const nextOffset = clamp(Math.round(anchorIndex - anchorRatio * nextSpan), 0, nextMaxOffset);

    setVisibleWindowSize(nextWindowSize);
    setHorizontalOffset(nextOffset);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!minimal || maxHorizontalOffset === 0) {
      return;
    }

    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    dragStartXRef.current = event.clientX;
    dragStartOffsetRef.current = effectiveHorizontalOffset;
    setIsDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!minimal || dragStartXRef.current === null || maxHorizontalOffset === 0) {
      return;
    }

    const deltaX = event.clientX - dragStartXRef.current;
    const candlesPerPixel = visibleMarketData.length / Math.max(plotRight - padding, 1);
    const offsetDelta = Math.round(deltaX * candlesPerPixel * -1);
    setHorizontalOffset(clamp(dragStartOffsetRef.current + offsetDelta, 0, maxHorizontalOffset));
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartXRef.current === null) {
      return;
    }

    dragStartXRef.current = null;
    setIsDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
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
        if (!isVisibleGlobalIndex(resolvedIndex)) {
          return null;
        }
        const anchorX = xForIndex(localIndexFromGlobal(resolvedIndex));
        const anchorY = yForPrice(hoveredAnnotation.chartAnchor.price);
        const hoverBox = getAnnotationBubbleBox(hoveredAnnotation.text, anchorX, anchorY, 'hover', bubbleBounds);

        return {
          annotation: hoveredAnnotation,
          hoverBox
        };
      })()
    : null;

  return (
    <section className={minimal ? 'chart-shell panel chart-shell-minimal' : 'chart-shell panel'}>
      {!minimal ? (
        <>
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
              <button
                className={aiRequestPending ? 'ai-cta-button is-loading' : 'ai-cta-button'}
                onClick={onRequestAi}
                disabled={annotationCreationLocked || aiRequestPending}
              >
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
            {drawingMode === 'segment' &&
              (segmentStartAnchor === null ? 'Click the first point.' : 'Click the second point to finish the diagonal line.')}
            {drawingMode === 'box' && (boxStartPrice === null ? 'Click the start price.' : 'Click the end price to complete the box.')}
            {drawingMode === 'none' && 'Select an annotation to edit its strategy in the right panel.'}
          </div>
        </>
      ) : null}
      <div
        className={minimal && maxHorizontalOffset > 0 ? (isDragging ? 'chart-container is-draggable is-dragging' : 'chart-container is-draggable') : 'chart-container'}
        ref={containerRef}
        onWheel={handleChartWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onPointerLeave={handlePointerEnd}
      >
        <svg viewBox={`0 0 ${renderWidth} ${renderHeight}`} className="chart-svg" onClick={handleCanvasClick}>
          <rect x="0" y="0" width={renderWidth} height={renderHeight} rx="18" className="chart-bg" />
          <line x1={axisDividerX} x2={axisDividerX} y1={12} y2={plotBottom} className="price-axis-divider" />
          <line x1={padding} x2={axisDividerX} y1={plotBottom + 8} y2={plotBottom + 8} className="time-axis-divider" />
          <rect x={axisLeft} y={12} width={axisWidth} height={plotBottom - 12} rx="14" className="price-axis-bg" />
          {timeTicks.map((tick, gridIndex) => (
            <line key={`time-grid-${gridIndex}`} x1={tick.x} x2={tick.x} y1={plotTop} y2={plotBottom} className="grid-line" />
          ))}
          {priceTicks.map((tick, gridIndex) => {
            const y = yForPrice(tick.price);
            return <line key={gridIndex} x1={padding} x2={axisDividerX} y1={y} y2={y} className="grid-line" />;
          })}
          {visibleMarketData.map((candle, index) => {
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
          <line x1={padding} x2={axisDividerX} y1={currentPriceY} y2={currentPriceY} className="current-price-line" />
          {priceTicks.map((tick, index) => (
            Math.abs(yForPrice(tick.price) - currentPriceBadgeCenterY) > 18 &&
            (!showViewportReferencePrice || Math.abs(yForPrice(tick.price) - viewportReferenceBadgeCenterY) > 18) ? (
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
          {visibleSelectedPriceAxisMarkers.map((marker) => {
            const y = clamp(yForPrice(marker.price), axisLabelTop, axisLabelBottom);
            return (
              <g key={`axis-marker-${marker.id}`} className={`annotation-axis-price ${marker.role}`}>
                <rect
                  x={axisLeft + 2}
                  y={y - 10}
                  width={axisWidth - 4}
                  height={20}
                  rx={4}
                />
                <text x={axisRight - 8} y={y + 4} textAnchor="end">
                  {formatPrice(marker.price)}
                </text>
              </g>
            );
          })}
          {showViewportReferencePrice ? (
            <g className="viewport-price-badge-group">
              <rect
                x={axisLeft + 2}
                y={viewportReferenceBadgeCenterY - PRICE_BADGE_HALF_HEIGHT}
                width={axisWidth - 4}
                height={PRICE_BADGE_HEIGHT}
                rx={PRICE_BADGE_HALF_HEIGHT}
                className={`viewport-price-badge ${viewportReferenceTone}`}
              />
              <text
                x={axisRight - 8}
                y={clamp(viewportReferenceBadgeCenterY + 4, axisLabelTop, axisLabelBottom)}
                textAnchor="end"
                className={`price-label viewport-price-text ${viewportReferenceTone}`}
              >
                {formatPrice(viewportReferencePrice)}
              </text>
            </g>
          ) : null}
          <g className="current-price-badge-group">
            <rect
              x={axisLeft + 2}
              y={currentPriceBadgeCenterY - PRICE_BADGE_HALF_HEIGHT}
              width={axisWidth - 4}
              height={PRICE_BADGE_HEIGHT}
              rx={PRICE_BADGE_HALF_HEIGHT}
              className="current-price-badge"
            />
            <text
              x={axisRight - 8}
              y={clamp(currentPriceBadgeCenterY + 4, axisLabelTop, axisLabelBottom)}
              textAnchor="end"
              className="price-label current-price-text"
            >
              {formatPrice(actualCurrentPrice)}
            </text>
          </g>
          {newsInsights.map((insight) => {
            const ix = resolveInsightIndex(insight);
            if (!isVisibleGlobalIndex(ix)) return null;
            const candle = marketData[ix];
            if (!candle) return null;
            const markerX = xForIndex(localIndexFromGlobal(ix));
            const markerY = insight.direction === 'spike' ? yForPrice(candle.high) - 18 : yForPrice(candle.low) + 18;
            const isHovered = hoveredInsightId === insight.insightId;
            const isSelected = selectedNewsInsightId === insight.insightId;

            return (
              <g
                key={insight.insightId}
                className={`news-insight-marker ${insight.direction} ${isHovered ? 'hovered' : ''} ${isSelected ? 'selected' : ''}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onPointerUp={(event) => {
                  event.stopPropagation();
                  onSelectNewsInsight(insight.insightId);
                }}
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
          {renderAnnotations.map((annotation) => {
            const selected = annotation.annotationId === selectedAnnotationId;
            const hovered = annotation.annotationId === hoveredAnnotationId && !selected;
            const anchorIndex = resolveAnchorIndex(annotation.chartAnchor);
            const anchorVisible = isVisibleGlobalIndex(anchorIndex);
            if (!selected && !anchorVisible) return null;
            const anchorX = xForIndex(localIndexFromGlobal(anchorIndex));
            const anchorY = yForPrice(annotation.chartAnchor.price);
            const takeProfitLabelById = new Map(
              annotation.drawingObjects
                .filter((object) => object.type === 'line' && object.role === 'take_profit')
                .map((object, index) => [object.id, `TP${index + 1}`])
            );
            return (
              <g
                key={annotation.annotationId}
                className={`annotation-pin-group ${selected ? 'selected' : ''} ${hovered ? 'hovered' : ''}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onPointerUp={(event) => {
                  event.stopPropagation();
                  onSelectAnnotation(annotation.annotationId);
                }}
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
                    const label =
                      object.role === 'entry'
                        ? 'Entry'
                        : object.role === 'stop_loss'
                          ? 'SL'
                          : object.role === 'take_profit'
                            ? takeProfitLabelById.get(object.id) ?? 'TP'
                            : null;
                    const y = yForPrice(object.price);
                    return (
                      <g key={object.id}>
                        <line
                          x1={padding}
                          x2={axisDividerX}
                          y1={y}
                          y2={y}
                          className={`annotation-line ${object.role} ${selected ? 'selected' : ''}`}
                        />
                        {label ? (
                          <g className={`annotation-line-label ${object.role}`}>
                            <rect x={padding + 8} y={y - 10} width={label.length > 3 ? 42 : 30} height={18} rx={4} />
                            <text x={padding + 16} y={y + 3}>{label}</text>
                          </g>
                        ) : null}
                      </g>
                    );
                  }

                  if (object.type === 'box') {
                    const top = yForPrice(Math.max(object.priceFrom, object.priceTo));
                    const bottom = yForPrice(Math.min(object.priceFrom, object.priceTo));
                    const boxLeft = clamp(anchorX - 56, padding, plotRight - annotationBoxClampRight);
                    const boxWidth = Math.max(Math.min(112, plotRight - boxLeft), 24);
                    return (
                      <rect
                        key={object.id}
                        x={boxLeft}
                        y={top}
                        width={boxWidth}
                        height={Math.max(bottom - top, 8)}
                        className={`annotation-box ${object.role} ${object.id.includes('risk') ? 'risk-zone' : ''} ${object.id.includes('reward') ? 'reward-zone' : ''} ${selected ? 'selected' : ''}`}
                      />
                    );
                  }

                  if (object.type === 'segment') {
                    const startIndex = resolveAnchorIndex(object.startAnchor);
                    const endIndex = resolveAnchorIndex(object.endAnchor);
                    if (!isVisibleGlobalIndex(startIndex) || !isVisibleGlobalIndex(endIndex)) {
                      return null;
                    }
                    return (
                      <line
                        key={object.id}
                        x1={xForIndex(localIndexFromGlobal(startIndex))}
                        y1={yForPrice(object.startAnchor.price)}
                        x2={xForIndex(localIndexFromGlobal(endIndex))}
                        y2={yForPrice(object.endAnchor.price)}
                        className={`annotation-line ${object.role} ${selected ? 'selected' : ''}`}
                      />
                    );
                  }

                  return null;
                    })
                  : null}
                {anchorVisible ? (
                  <>
                    <line x1={anchorX} x2={anchorX} y1={anchorY - 12} y2={anchorY - 2} className="annotation-pin-stem" />
                    <circle cx={anchorX} cy={anchorY - 16} r={selected ? 7 : 5} className="annotation-pin" />
                    <circle cx={anchorX} cy={anchorY - 16} r="2" className="annotation-pin-core" />
                  </>
                ) : null}
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
              if (!isVisibleGlobalIndex(ix)) return null;
              const candle = marketData[ix];
              if (!candle) return null;
              const markerX = xForIndex(localIndexFromGlobal(ix));
              const markerY = insight.direction === 'spike' ? yForPrice(candle.high) - 18 : yForPrice(candle.low) + 18;
              const bubbleBox = getNewsInsightBubbleBox(insight, markerX, markerY, bubbleBounds);
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
                      <span className={`news-sentiment-pill ${insight.sentiment}`}>
                        {insight.category === 'global' ? 'GLOBAL' : `${insight.direction === 'spike' ? '▲' : '▼'} ${Math.abs(insight.priceChangePercent).toFixed(1)}%`}
                      </span>
                      <span className="news-insight-time">{formatHoverTime(insight.time)}</span>
                    </div>
                    <p className="news-insight-headline">{insight.headline}</p>
                    <p className="news-insight-summary">{insight.summary}</p>
                    <p className="news-insight-comment">{insight.aiComment}</p>
                  </div>
                </foreignObject>
              );
            })}
          {timeTicks.map((tick) => (
            <g key={`time-tick-${tick.index}`}>
              <line x1={tick.x} x2={tick.x} y1={plotBottom + 8} y2={plotBottom + 14} className="time-axis-tick" />
              <text x={tick.x} y={renderHeight - 14} textAnchor={tick.anchor} className="time-axis-label">
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
