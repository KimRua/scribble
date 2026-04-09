import type { ParserResult, Strategy } from '../types/domain';

interface ParseContext {
  currentPrice: number;
  visibleLevels: number[];
  annotationId: string;
}

function nearestLevel(levels: number[], fallback: number) {
  if (levels.length === 0) {
    return fallback;
  }

  return levels.reduce((closest, level) => {
    return Math.abs(level - fallback) < Math.abs(closest - fallback) ? level : closest;
  }, levels[0]);
}

function extractNumbers(text: string) {
  return Array.from(text.matchAll(/\d+(?:\.\d+)?/g)).map((match) => Number(match[0]));
}

export function parseAnnotationText(text: string, context: ParseContext): ParserResult {
  const normalized = text.toLowerCase();
  const numbers = extractNumbers(text);
  const bullishHint = /(롱|매수|지지|반등|상승|돌파)/.test(text);
  const bearishDirectionalHint = /(숏|매도|저항|하락|하방)/.test(text);
  const invalidationHint = /(이탈|손절|무효)/.test(text);
  const bias: Strategy['bias'] = bullishHint
    ? 'bullish'
    : bearishDirectionalHint
      ? 'bearish'
      : invalidationHint
        ? 'bullish'
        : 'neutral';
  const inferredEntry = numbers[0] ?? nearestLevel(context.visibleLevels, context.currentPrice);
  const inferredStop =
    numbers[1] ??
    (bias === 'bearish'
      ? Number((inferredEntry * 1.006).toFixed(2))
      : Number((inferredEntry * 0.994).toFixed(2)));
  const defaultTp =
    bias === 'bearish'
      ? Number((inferredEntry * 0.988).toFixed(2))
      : Number((inferredEntry * 1.01).toFixed(2));
  const inferredTp = numbers[2] ?? nearestLevel(context.visibleLevels, defaultTp);

  const parsingNotes = [
    bullishHint || bearishDirectionalHint || invalidationHint
      ? 'bias inferred from directional wording'
      : 'bias defaulted to neutral',
    numbers.length > 0 ? 'price levels extracted from annotation text' : 'visible chart levels used as fallback'
  ];

  const missingFields: string[] = [];
  if (numbers.length < 3) {
    missingFields.push('take_profit_prices');
  }

  const strategy: Strategy = {
    strategyId: `str_${context.annotationId}`,
    annotationId: context.annotationId,
    bias,
    entryType: normalized.includes('즉시') ? 'market' : 'conditional',
    entryPrice: inferredEntry,
    stopLossPrice: inferredStop,
    takeProfitPrices: [inferredTp],
    invalidationCondition: bias === 'bearish' ? `price closes above ${inferredStop}` : `price closes below ${inferredStop}`,
    confidence: numbers.length > 1 ? 0.68 : 0.54,
    riskLevel: 'balanced',
    positionSizeRatio: 0.1,
    leverage: 1,
    autoExecuteEnabled: false
  };

  return { strategy, parsingNotes, missingFields };
}
