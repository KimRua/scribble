import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { buildSeedAnnotations, defaultUserSettings, generateCandles, marketOptions } from '../src/data/mockMarket';
import { createAuditEvent } from '../src/services/auditLogService';
import { armAutomation, createExecutionPreview, executeStrategy } from '../src/services/executionService';
import { validateStrategy } from '../src/utils/strategy';
import type { Annotation, AutomationRule, Candle, NotificationItem, Strategy } from '../src/types/domain';
import { createAnnotationFromText, syncAnnotationWithStrategy } from '../src/utils/annotation';
import { getState, updateState } from './services/fileStore';
import { analyzeChartWithLlm, parseAnnotationWithLlm } from './services/llmService';
import { createId } from './utils/ids';
import { sendError, sendSuccess } from './utils/response';

const app = express();
const port = Number(process.env.API_PORT ?? 8787);

app.use(cors());
app.use(express.json());

const chartCache = new Map<string, Candle[]>();

function getCandles(symbol: string, timeframe: string) {
  const key = `${symbol}:${timeframe}`;
  if (!chartCache.has(key)) {
    chartCache.set(key, generateCandles(symbol, timeframe));
  }
  return chartCache.get(key) ?? [];
}

function ensureSeedState(symbol: string, timeframe: string) {
  const candles = getCandles(symbol, timeframe);
  const seed = buildSeedAnnotations(symbol, timeframe, candles);
  const state = getState();
  if (!state.annotations.some((annotation) => annotation.marketSymbol === symbol && annotation.timeframe === timeframe)) {
    updateState((current) => ({
      ...current,
      annotations: [...seed, ...current.annotations]
    }));
  }
}

function appendNotification(notification: NotificationItem) {
  updateState((state) => ({
    ...state,
    notifications: [notification, ...state.notifications].slice(0, 50)
  }));
}

function appendAudit(eventType: Parameters<typeof createAuditEvent>[0], entityType: Parameters<typeof createAuditEvent>[1], entityId: string, metadata: Record<string, string | number | boolean>) {
  updateState((state) => ({
    ...state,
    auditEvents: [createAuditEvent(eventType, entityType, entityId, metadata), ...state.auditEvents].slice(0, 100)
  }));
}

app.get('/api/v1/health', (_request, response) => {
  sendSuccess(response, { ok: true, llmConfigured: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) });
});

app.get('/api/v1/markets', (_request, response) => {
  sendSuccess(response, { markets: marketOptions });
});

app.get('/api/v1/market-data/candles', (request, response) => {
  const symbol = String(request.query.symbol ?? 'BTCUSDT');
  const timeframe = String(request.query.timeframe ?? '1h');
  const candles = getCandles(symbol, timeframe);
  sendSuccess(response, {
    symbol,
    timeframe,
    candles: candles.map((candle) => ({
      open_time: candle.openTime,
      open: String(candle.open),
      high: String(candle.high),
      low: String(candle.low),
      close: String(candle.close),
      volume: String(candle.volume)
    }))
  });
});

app.get('/api/v1/annotations', (request, response) => {
  const symbol = String(request.query.symbol ?? 'BTCUSDT');
  const timeframe = String(request.query.timeframe ?? '1h');
  ensureSeedState(symbol, timeframe);
  const state = getState();
  const annotations = state.annotations.filter((annotation) => annotation.marketSymbol === symbol && annotation.timeframe === timeframe);
  sendSuccess(response, { annotations });
});

app.get('/api/v1/annotations/:annotationId', (request, response) => {
  const state = getState();
  const annotation = state.annotations.find((item) => item.annotationId === request.params.annotationId);
  if (!annotation) {
    return sendError(response, 'NOT_FOUND', 'annotation not found');
  }
  return sendSuccess(response, { annotation });
});

app.post('/api/v1/annotations', async (request, response) => {
  const bodySchema = z.object({
    market_symbol: z.string(),
    timeframe: z.string(),
    text: z.string().min(1),
    chart_anchor: z.object({ time: z.string(), price: z.union([z.string(), z.number()]), index: z.number().optional() }),
    visibility: z.enum(['private', 'public', 'unlisted']).default('private')
  });
  const parsedBody = bodySchema.safeParse(request.body);
  if (!parsedBody.success) {
    return sendError(response, 'VALIDATION_ERROR', 'invalid annotation payload', parsedBody.error.flatten());
  }

  const data = parsedBody.data;
  const candles = getCandles(data.market_symbol, data.timeframe);
  const visibleLevels = candles.slice(-10).flatMap((candle) => [candle.high, candle.low, candle.close]);
  const annotationId = createId('ann');
  const parsed = await parseAnnotationWithLlm({
    text: data.text,
    marketSymbol: data.market_symbol,
    timeframe: data.timeframe,
    currentPrice: candles.at(-1)?.close ?? 0,
    visibleLevels,
    annotationId
  });
  const annotation = createAnnotationFromText({
    annotationId,
    symbol: data.market_symbol,
    timeframe: data.timeframe,
    text: data.text,
    authorType: 'user',
    authorId: 'me',
    anchor: {
      time: data.chart_anchor.time,
      price: Number(data.chart_anchor.price),
      index: data.chart_anchor.index ?? Math.max(candles.length - 1, 0)
    },
    strategy: parsed.strategy
  });

  updateState((state) => ({ ...state, annotations: [annotation, ...state.annotations] }));
  appendAudit('annotation_created', 'annotation', annotation.annotationId, { provider: parsed.provider });
  return sendSuccess(response, { annotation_id: annotation.annotationId, status: annotation.status, annotation, parsing_notes: parsed.parsingNotes });
});

app.patch('/api/v1/annotations/:annotationId', async (request, response) => {
  const state = getState();
  const annotation = state.annotations.find((item) => item.annotationId === request.params.annotationId);
  if (!annotation) {
    return sendError(response, 'NOT_FOUND', 'annotation not found');
  }

  const nextText = typeof request.body.text === 'string' ? request.body.text : annotation.text;
  const candles = getCandles(annotation.marketSymbol, annotation.timeframe);
  const visibleLevels = candles.slice(-10).flatMap((candle) => [candle.high, candle.low, candle.close]);
  const parsed = await parseAnnotationWithLlm({
    text: nextText,
    marketSymbol: annotation.marketSymbol,
    timeframe: annotation.timeframe,
    currentPrice: candles.at(-1)?.close ?? 0,
    visibleLevels,
    annotationId: annotation.annotationId
  });

  const nextAnnotation = syncAnnotationWithStrategy(
    {
      ...annotation,
      text: nextText,
      updatedAt: new Date().toISOString()
    },
    {
      ...annotation.strategy,
      ...parsed.strategy,
      bias: request.body.bias ?? parsed.strategy.bias,
      entryType: request.body.entry_type ?? parsed.strategy.entryType,
      entryPrice: Number(request.body.entry_price ?? parsed.strategy.entryPrice),
      stopLossPrice: Number(request.body.stop_loss_price ?? parsed.strategy.stopLossPrice),
      takeProfitPrices: Array.isArray(request.body.take_profit_prices)
        ? request.body.take_profit_prices.map((value: string | number) => Number(value))
        : parsed.strategy.takeProfitPrices,
      invalidationCondition: request.body.invalidation_condition ?? parsed.strategy.invalidationCondition,
      confidence: Number(request.body.confidence ?? parsed.strategy.confidence),
      riskLevel: request.body.risk_level ?? parsed.strategy.riskLevel,
      positionSizeRatio: Number(request.body.position_size_ratio ?? annotation.strategy.positionSizeRatio),
      leverage: Number(request.body.leverage ?? annotation.strategy.leverage),
      autoExecuteEnabled: request.body.auto_execute_enabled ?? annotation.strategy.autoExecuteEnabled
    },
    nextText
  );

  updateState((current) => ({
    ...current,
    annotations: current.annotations.map((item) => (item.annotationId === nextAnnotation.annotationId ? nextAnnotation : item))
  }));
  appendAudit('annotation_edited', 'annotation', nextAnnotation.annotationId, { provider: parsed.provider });
  return sendSuccess(response, { annotation: nextAnnotation, parsing_notes: parsed.parsingNotes });
});

app.post('/api/v1/alerts', (request, response) => {
  const annotationId = String(request.body.annotation_id ?? '');
  const value = String(request.body.value ?? '');
  const state = getState();
  const annotation = state.annotations.find((item) => item.annotationId === annotationId);
  if (!annotation) {
    return sendError(response, 'NOT_FOUND', 'annotation not found');
  }

  const notification: NotificationItem = {
    notificationId: createId('noti'),
    type: 'alert_fired',
    title: '알림 등록 완료',
    body: `${annotation.marketSymbol} ${value} 조건 알림이 등록되었습니다.`,
    annotationId,
    createdAt: new Date().toISOString(),
    read: false
  };
  appendNotification(notification);
  appendAudit('status_changed', 'annotation', annotationId, { alertValue: value });
  return sendSuccess(response, { notification });
});

app.post('/api/v1/ai/analyze', async (request, response) => {
  const bodySchema = z.object({
    market_symbol: z.string(),
    timeframe: z.string(),
    user_preferences: z
      .object({
        risk_level: z.enum(['conservative', 'balanced', 'aggressive']).default('balanced'),
        default_position_size_ratio: z.number().min(0.01).max(1).default(0.1),
        leverage: z.number().min(1).max(10).default(2)
      })
      .optional()
  });
  const parsedBody = bodySchema.safeParse(request.body);
  if (!parsedBody.success) {
    return sendError(response, 'VALIDATION_ERROR', 'invalid ai analysis payload', parsedBody.error.flatten());
  }

  const { market_symbol, timeframe, user_preferences } = parsedBody.data;
  const candles = getCandles(market_symbol, timeframe);
  const analysis = await analyzeChartWithLlm({
    marketSymbol: market_symbol,
    timeframe,
    candles,
    userSettings: {
      ...defaultUserSettings,
      riskLevel: user_preferences?.risk_level ?? defaultUserSettings.riskLevel,
      defaultPositionSize: user_preferences?.default_position_size_ratio ?? defaultUserSettings.defaultPositionSize,
      leverage: user_preferences?.leverage ?? defaultUserSettings.leverage
    }
  });
  const annotationId = createId('ann_ai');
  const strategyId = createId('str');
  const annotation: Annotation = {
    annotationId,
    authorType: 'ai',
    authorId: 'system',
    marketSymbol: market_symbol,
    timeframe,
    text: analysis.text,
    chartAnchor: analysis.chartAnchor,
    drawingObjects: analysis.drawingObjects,
    strategy: {
      ...analysis.strategy,
      annotationId,
      strategyId
    },
    status: 'Draft',
    visibility: 'private',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  updateState((state) => ({ ...state, annotations: [annotation, ...state.annotations] }));
  appendAudit('ai_analysis_requested', 'annotation', annotationId, { provider: analysis.provider, symbol: market_symbol, timeframe });
  return sendSuccess(response, { annotation, strategy: annotation.strategy, provider: analysis.provider });
});

app.post('/api/v1/ai/parse-annotation', async (request, response) => {
  const bodySchema = z.object({
    text: z.string().min(1),
    market_symbol: z.string(),
    timeframe: z.string(),
    context: z.object({
      current_price: z.union([z.string(), z.number()]),
      visible_levels: z.array(z.union([z.string(), z.number()]))
    })
  });
  const parsedBody = bodySchema.safeParse(request.body);
  if (!parsedBody.success) {
    return sendError(response, 'VALIDATION_ERROR', 'invalid parse payload', parsedBody.error.flatten());
  }
  const annotationId = createId('ann_parse');
  const result = await parseAnnotationWithLlm({
    text: parsedBody.data.text,
    marketSymbol: parsedBody.data.market_symbol,
    timeframe: parsedBody.data.timeframe,
    currentPrice: Number(parsedBody.data.context.current_price),
    visibleLevels: parsedBody.data.context.visible_levels.map((value) => Number(value)),
    annotationId
  });
  return sendSuccess(response, { strategy: result.strategy, parsing_notes: result.parsingNotes, missing_fields: result.missingFields, provider: result.provider });
});

app.post('/api/v1/strategies/:strategyId/validate', (request, response) => {
  const state = getState();
  const annotation = state.annotations.find((item) => item.strategy.strategyId === request.params.strategyId);
  if (!annotation) {
    return sendError(response, 'NOT_FOUND', 'strategy not found');
  }
  const candles = getCandles(annotation.marketSymbol, annotation.timeframe);
  const currentPrice = candles.at(-1)?.close ?? annotation.strategy.entryPrice;
  const validation = validateStrategy(annotation.strategy, currentPrice, defaultUserSettings);
  appendAudit(validation.isValid ? 'strategy_validated' : 'strategy_invalid', 'strategy', annotation.strategy.strategyId, { currentPrice });
  return sendSuccess(response, {
    is_valid: validation.isValid,
    violations: validation.violations,
    risk_summary: {
      max_loss_ratio: validation.riskSummary.maxLossRatio,
      max_loss_amount: validation.riskSummary.maxLossAmount,
      risk_reward_ratio: validation.riskSummary.riskRewardRatio,
      estimated_liquidation_risk: validation.riskSummary.liquidationRisk
    }
  });
});

app.post('/api/v1/executions/preview', (request, response) => {
  const strategyId = String(request.body.strategy_id ?? '');
  const state = getState();
  const annotation = state.annotations.find((item) => item.strategy.strategyId === strategyId);
  if (!annotation) {
    return sendError(response, 'NOT_FOUND', 'strategy not found');
  }
  const candles = getCandles(annotation.marketSymbol, annotation.timeframe);
  const preview = createExecutionPreview(annotation.strategy, candles.at(-1)?.close ?? annotation.strategy.entryPrice, defaultUserSettings);
  return sendSuccess(response, {
    execution_plan: {
      execution_chain: preview.executionChain,
      liquidity_chain: preview.liquidityChain,
      entry_price: String(preview.entryPrice),
      position_size: String(preview.positionSize),
      estimated_slippage: String(preview.estimatedSlippage),
      estimated_fee: String(preview.estimatedFee),
      guardrail_check: {
        passed: preview.guardrailCheck.passed,
        violations: preview.guardrailCheck.violations
      }
    }
  });
});

app.post('/api/v1/executions', (request, response) => {
  const strategyId = String(request.body.strategy_id ?? '');
  const state = getState();
  const annotation = state.annotations.find((item) => item.strategy.strategyId === strategyId);
  if (!annotation) {
    return sendError(response, 'NOT_FOUND', 'strategy not found');
  }
  const execution = executeStrategy(annotation.strategy);
  updateState((current) => ({
    ...current,
    executions: [execution, ...current.executions],
    annotations: current.annotations.map((item) =>
      item.annotationId === annotation.annotationId
        ? { ...item, status: 'Executed', updatedAt: new Date().toISOString() }
        : item
    )
  }));
  appendNotification({
    notificationId: createId('noti'),
    type: 'execution_filled',
    title: '주문 실행 완료',
    body: `${annotation.marketSymbol} 전략이 실행되었습니다.`,
    annotationId: annotation.annotationId,
    createdAt: new Date().toISOString(),
    read: false
  });
  appendAudit('execute_confirmed', 'execution', execution.executionId, { executionChain: 'opbnb', liquidityChain: 'bsc' });
  return sendSuccess(response, {
    execution_id: execution.executionId,
    status: execution.status,
    execution_chain_tx_hash: execution.executionChainTxHash,
    liquidity_chain_tx_hash: execution.liquidityChainTxHash
  });
});

app.post('/api/v1/automations', (request, response) => {
  const strategyId = String(request.body.strategy_id ?? '');
  const state = getState();
  const annotation = state.annotations.find((item) => item.strategy.strategyId === strategyId);
  if (!annotation) {
    return sendError(response, 'NOT_FOUND', 'strategy not found');
  }
  const base = armAutomation(annotation.strategy, defaultUserSettings);
  const automation: AutomationRule = {
    ...base,
    automationId: createId('auto'),
    maxPositionSizeRatio: Number(request.body.guardrails?.max_position_size_ratio ?? base.maxPositionSizeRatio),
    maxLeverage: Number(request.body.guardrails?.max_leverage ?? base.maxLeverage),
    maxLossRatio: Number(request.body.guardrails?.max_loss_ratio ?? base.maxLossRatio),
    maxDailyExecutions: Number(request.body.guardrails?.max_daily_executions ?? base.maxDailyExecutions)
  };
  updateState((current) => ({
    ...current,
    automations: [automation, ...current.automations],
    annotations: current.annotations.map((item) =>
      item.annotationId === annotation.annotationId
        ? syncAnnotationWithStrategy(item, { ...item.strategy, autoExecuteEnabled: true })
        : item
    )
  }));
  appendAudit('automation_enabled', 'automation', automation.automationId, { maxLeverage: automation.maxLeverage });
  return sendSuccess(response, { automation_id: automation.automationId, status: automation.status });
});

app.get('/api/v1/notifications', (_request, response) => {
  const state = getState();
  return sendSuccess(response, { notifications: state.notifications });
});

app.get('/api/v1/audit-logs', (request, response) => {
  const annotationId = request.query.annotation_id ? String(request.query.annotation_id) : null;
  const strategyId = request.query.strategy_id ? String(request.query.strategy_id) : null;
  const executionId = request.query.execution_id ? String(request.query.execution_id) : null;
  const state = getState();
  const events = state.auditEvents.filter((event) => {
    if (annotationId) {
      return event.entityId === annotationId;
    }
    if (strategyId) {
      return event.entityId === strategyId;
    }
    if (executionId) {
      return event.entityId === executionId;
    }
    return true;
  });
  return sendSuccess(response, { events });
});

app.listen(port, () => {
  console.log(`Scribble API listening on http://localhost:${port}`);
});
