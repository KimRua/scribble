import { parseAnnotationText } from '../../src/services/parserService';
import type { Annotation, Candle, UserSettings } from '../../src/types/domain';
import { generateAiAnnotation } from '../../src/services/aiService';

type RawLlmStrategy = {
  bias: string;
  entry_type: string;
  entry_price: number;
  stop_loss_price: number;
  take_profit_prices: number[];
  invalidation_condition: string;
  confidence: number;
  risk_level: string;
  position_size_ratio: number;
  leverage: number;
  auto_execute_enabled: boolean;
};

interface AnalyzeParams {
  marketSymbol: string;
  timeframe: string;
  candles: Candle[];
  userSettings: UserSettings;
}

interface ParseParams {
  text: string;
  marketSymbol: string;
  timeframe: string;
  currentPrice: number;
  visibleLevels: number[];
  annotationId: string;
}

function hasOpenAiConfig() {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeBias(input: string): Annotation['strategy']['bias'] {
  const value = input.toLowerCase();
  if (['bullish', 'long', 'buy', 'up'].includes(value)) {
    return 'bullish';
  }
  if (['bearish', 'short', 'sell', 'down'].includes(value)) {
    return 'bearish';
  }
  return 'neutral';
}

function normalizeEntryType(input: string): Annotation['strategy']['entryType'] {
  const value = input.toLowerCase();
  if (value.includes('market')) {
    return 'market';
  }
  if (value.includes('limit')) {
    return 'limit';
  }
  return 'conditional';
}

function normalizeRiskLevel(input: string): Annotation['strategy']['riskLevel'] {
  const value = input.toLowerCase();
  if (['conservative', 'low'].includes(value)) {
    return 'conservative';
  }
  if (['aggressive', 'high'].includes(value)) {
    return 'aggressive';
  }
  return 'balanced';
}

export function normalizeLlmStrategyShape(raw: RawLlmStrategy) {
  return {
    bias: normalizeBias(raw.bias),
    entryType: normalizeEntryType(raw.entry_type),
    entryPrice: Number(raw.entry_price),
    stopLossPrice: Number(raw.stop_loss_price),
    takeProfitPrices: raw.take_profit_prices.map((price) => Number(price)),
    invalidationCondition: raw.invalidation_condition,
    confidence: clamp(Number(raw.confidence), 0, 1),
    riskLevel: normalizeRiskLevel(raw.risk_level),
    positionSizeRatio: clamp(Number(raw.position_size_ratio), 0.01, 1),
    leverage: clamp(Number(raw.leverage), 1, 10),
    autoExecuteEnabled: Boolean(raw.auto_execute_enabled)
  };
}

async function callOpenAi(prompt: string) {
  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a trading copilot. Return JSON only with fields: text, strategy. Strategy must contain bias, entry_type, entry_price, stop_loss_price, take_profit_prices, invalidation_condition, confidence, risk_level, position_size_ratio, leverage, auto_execute_enabled.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`LLM request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return payload.choices?.[0]?.message?.content ?? '';
}

export async function analyzeChartWithLlm(params: AnalyzeParams): Promise<Pick<Annotation, 'text' | 'chartAnchor' | 'drawingObjects'> & { strategy: Annotation['strategy']; provider: 'openai' | 'fallback'; }> {
  if (!hasOpenAiConfig()) {
    const annotation = generateAiAnnotation({
      symbol: params.marketSymbol,
      timeframe: params.timeframe,
      candles: params.candles,
      settings: params.userSettings
    });
    return {
      text: annotation.text,
      chartAnchor: annotation.chartAnchor,
      drawingObjects: annotation.drawingObjects,
      strategy: annotation.strategy,
      provider: 'fallback'
    };
  }

  try {
    const lastCandle = params.candles.at(-1);
    const prompt = JSON.stringify({
      marketSymbol: params.marketSymbol,
      timeframe: params.timeframe,
      currentPrice: lastCandle?.close,
      recentCandles: params.candles.slice(-20),
      userSettings: params.userSettings
    });
    const content = await callOpenAi(prompt);
    const parsed = JSON.parse(content) as {
      text: string;
      strategy: RawLlmStrategy;
    };
    const normalizedStrategy = normalizeLlmStrategyShape(parsed.strategy);
    const anchorIndex = Math.max(params.candles.length - 2, 0);
    const anchor = {
      time: params.candles[anchorIndex]?.openTime ?? new Date().toISOString(),
      price: normalizedStrategy.entryPrice,
      index: anchorIndex
    };

    return {
      text: parsed.text,
      chartAnchor: anchor,
      drawingObjects: [
        { id: 'llm_entry', type: 'line', role: 'entry', price: normalizedStrategy.entryPrice },
        { id: 'llm_sl', type: 'line', role: 'stop_loss', price: normalizedStrategy.stopLossPrice },
        ...normalizedStrategy.takeProfitPrices.map((price, index) => ({ id: `llm_tp_${index}`, type: 'line' as const, role: 'take_profit' as const, price }))
      ],
      strategy: {
        strategyId: '',
        annotationId: '',
        ...normalizedStrategy
      },
      provider: 'openai'
    };
  } catch {
    const annotation = generateAiAnnotation({
      symbol: params.marketSymbol,
      timeframe: params.timeframe,
      candles: params.candles,
      settings: params.userSettings
    });
    return {
      text: annotation.text,
      chartAnchor: annotation.chartAnchor,
      drawingObjects: annotation.drawingObjects,
      strategy: annotation.strategy,
      provider: 'fallback'
    };
  }
}

export async function parseAnnotationWithLlm(params: ParseParams) {
  if (!hasOpenAiConfig()) {
    return {
      ...parseAnnotationText(params.text, {
        currentPrice: params.currentPrice,
        visibleLevels: params.visibleLevels,
        annotationId: params.annotationId
      }),
      provider: 'fallback' as const
    };
  }

  try {
    const content = await callOpenAi(
      JSON.stringify({
        task: 'parse_annotation',
        text: params.text,
        marketSymbol: params.marketSymbol,
        timeframe: params.timeframe,
        currentPrice: params.currentPrice,
        visibleLevels: params.visibleLevels
      })
    );
    const parsed = JSON.parse(content) as {
      text?: string;
      strategy: RawLlmStrategy;
      parsing_notes?: string[];
      missing_fields?: string[];
    };
    const normalizedStrategy = normalizeLlmStrategyShape(parsed.strategy);

    return {
      strategy: {
        strategyId: `str_${params.annotationId}`,
        annotationId: params.annotationId,
        ...normalizedStrategy
      },
      parsingNotes: parsed.parsing_notes ?? [],
      missingFields: parsed.missing_fields ?? [],
      provider: 'openai' as const
    };
  } catch {
    return {
      ...parseAnnotationText(params.text, {
        currentPrice: params.currentPrice,
        visibleLevels: params.visibleLevels,
        annotationId: params.annotationId
      }),
      provider: 'fallback' as const
    };
  }
}
