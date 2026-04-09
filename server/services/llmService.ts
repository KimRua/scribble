import { parseAnnotationText } from '../../src/services/parserService';
import type { Annotation, Candle, UserSettings } from '../../src/types/domain';
import { generateAiAnnotation } from '../../src/services/aiService';

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
      strategy: {
        bias: Annotation['strategy']['bias'];
        entry_type: Annotation['strategy']['entryType'];
        entry_price: number;
        stop_loss_price: number;
        take_profit_prices: number[];
        invalidation_condition: string;
        confidence: number;
        risk_level: Annotation['strategy']['riskLevel'];
        position_size_ratio: number;
        leverage: number;
        auto_execute_enabled: boolean;
      };
    };
    const anchorIndex = Math.max(params.candles.length - 2, 0);
    const anchor = {
      time: params.candles[anchorIndex]?.openTime ?? new Date().toISOString(),
      price: parsed.strategy.entry_price,
      index: anchorIndex
    };

    return {
      text: parsed.text,
      chartAnchor: anchor,
      drawingObjects: [
        { id: 'llm_entry', type: 'line', role: 'entry', price: parsed.strategy.entry_price },
        { id: 'llm_sl', type: 'line', role: 'stop_loss', price: parsed.strategy.stop_loss_price },
        ...parsed.strategy.take_profit_prices.map((price, index) => ({ id: `llm_tp_${index}`, type: 'line' as const, role: 'take_profit' as const, price }))
      ],
      strategy: {
        strategyId: '',
        annotationId: '',
        bias: parsed.strategy.bias,
        entryType: parsed.strategy.entry_type,
        entryPrice: parsed.strategy.entry_price,
        stopLossPrice: parsed.strategy.stop_loss_price,
        takeProfitPrices: parsed.strategy.take_profit_prices,
        invalidationCondition: parsed.strategy.invalidation_condition,
        confidence: parsed.strategy.confidence,
        riskLevel: parsed.strategy.risk_level,
        positionSizeRatio: parsed.strategy.position_size_ratio,
        leverage: parsed.strategy.leverage,
        autoExecuteEnabled: parsed.strategy.auto_execute_enabled
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
      strategy: {
        bias: 'bullish' | 'bearish' | 'neutral';
        entry_type: 'market' | 'limit' | 'conditional';
        entry_price: number;
        stop_loss_price: number;
        take_profit_prices: number[];
        invalidation_condition: string;
        confidence: number;
        risk_level: 'conservative' | 'balanced' | 'aggressive';
        position_size_ratio: number;
        leverage: number;
        auto_execute_enabled: boolean;
      };
      parsing_notes?: string[];
      missing_fields?: string[];
    };

    return {
      strategy: {
        strategyId: `str_${params.annotationId}`,
        annotationId: params.annotationId,
        bias: parsed.strategy.bias,
        entryType: parsed.strategy.entry_type,
        entryPrice: parsed.strategy.entry_price,
        stopLossPrice: parsed.strategy.stop_loss_price,
        takeProfitPrices: parsed.strategy.take_profit_prices,
        invalidationCondition: parsed.strategy.invalidation_condition,
        confidence: parsed.strategy.confidence,
        riskLevel: parsed.strategy.risk_level,
        positionSizeRatio: parsed.strategy.position_size_ratio,
        leverage: parsed.strategy.leverage,
        autoExecuteEnabled: parsed.strategy.auto_execute_enabled
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
