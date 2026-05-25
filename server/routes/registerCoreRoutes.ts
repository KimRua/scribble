import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { defaultUserSettings } from '../../src/data/mockMarket';
import { armAutomation } from '../../src/services/executionService';
import { validateStrategy } from '../../src/utils/strategy';
import type {
  Annotation,
  AutomationRule,
  DelegatedAutomationPolicy,
  NewsInsight,
  NewsInsightCacheEntry,
  NotificationItem
} from '../../src/types/domain';
import { syncAnnotationWithStrategy } from '../../src/utils/annotation';
import { isValidTxHash, normalizeTxHash } from '../../src/utils/txHash';
import type { AuditRepository } from '../services/auditRepository';
import type { AutomationRepository } from '../services/automationRepository';
import type { DelegatedPolicyRepository } from '../services/delegatedPolicyRepository';
import type { NotificationRepository } from '../services/notificationRepository';
import { analyzeChartWithLlm, generateNewsInsights, parseAnnotationWithLlm } from '../services/llmService';
import { getAvailableMarkets, getMarketCandles, getMarketSnapshot, isRealMarketDataEnabled } from '../services/marketDataService';
import { getDelegatedAutomationConfigStatus } from '../services/delegatedAutomationService';
import { getDexExecutionConfigStatus } from '../services/dexExecutionService';
import { getHyperliquidConfigStatus } from '../services/hyperliquidExecutionService';
import { getOnchainConfigStatus } from '../services/onchainExecutionService';
import { createId } from '../utils/ids';
import { getRequestContext } from '../utils/requestContext';
import { sendError, sendSuccess } from '../utils/response';

type State = ReturnType<RegisterCoreRoutesDependencies['getState']>;

interface RegisterCoreRoutesDependencies {
  app: Express;
  marketStreamIntervalMs: number;
  auditRepository: AuditRepository;
  automationRepository: AutomationRepository;
  delegatedPolicyRepository: DelegatedPolicyRepository;
  notificationRepository: NotificationRepository;
  getState: () => {
    annotations: Annotation[];
    newsInsightCache: NewsInsightCacheEntry[];
  };
  updateState: (updater: (state: State) => State) => State;
  getCandles: (symbol: string, timeframe: string) => Promise<Awaited<ReturnType<typeof getMarketCandles>>['candles']>;
  getNewsInsightCacheKey: (symbol: string, timeframe: string, threshold: number) => string;
  reindexNewsInsights: (insights: NewsInsight[], candles: Awaited<ReturnType<typeof getMarketCandles>>['candles']) => NewsInsight[];
  mergeNewsInsights: (existing: NewsInsight[], incoming: NewsInsight[]) => NewsInsight[];
  resolveAnnotationOwnerKey: (request: Request, response: Response) => string | null;
  findScopedAnnotation: (state: State, annotationId: string, ownerKey: string) => Annotation | undefined;
  appendNotification: (notification: NotificationItem) => void;
  appendAudit: (
    eventType:
      | 'ai_analysis_requested'
      | 'strategy_validated'
      | 'strategy_invalid'
      | 'status_changed'
      | 'automation_enabled',
    entityType: 'annotation' | 'strategy' | 'automation',
    entityId: string,
    metadata: Record<string, string | number | boolean>,
    sessionId?: string | null
  ) => void;
}

function toCandleResponse(candle: { openTime: string; open: number; high: number; low: number; close: number; volume: number }) {
  return {
    open_time: candle.openTime,
    open: String(candle.open),
    high: String(candle.high),
    low: String(candle.low),
    close: String(candle.close),
    volume: String(candle.volume)
  };
}

export function registerCoreRoutes({
  app,
  marketStreamIntervalMs,
  auditRepository,
  automationRepository,
  delegatedPolicyRepository,
  notificationRepository,
  getState,
  updateState,
  getCandles,
  getNewsInsightCacheKey,
  reindexNewsInsights,
  mergeNewsInsights,
  resolveAnnotationOwnerKey,
  findScopedAnnotation,
  appendNotification,
  appendAudit
}: RegisterCoreRoutesDependencies) {
  app.get('/api/v1/health', (_request, response) => {
    sendSuccess(response, {
      ok: true,
      llmConfigured: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL),
      marketDataEnabled: isRealMarketDataEnabled(),
      marketDataProvider: isRealMarketDataEnabled() ? 'binance' : 'mock',
      onchainConfigured: getOnchainConfigStatus().ready,
      dexConfigured: getDexExecutionConfigStatus().ready,
      hyperliquidConfigured: getHyperliquidConfigStatus().ready,
      delegatedAutomationConfigured: getDelegatedAutomationConfigStatus().ready,
      delegatedExecutorAddress: getDelegatedAutomationConfigStatus().executorAddress,
      delegationVaultAddress: getDelegatedAutomationConfigStatus().vaultAddress
    });
  });

  app.get('/api/v1/delegations/config', (_request, response) => {
    return sendSuccess(response, getDelegatedAutomationConfigStatus());
  });

  app.get('/api/v1/delegations', (request, response) => {
    const { walletAddress } = getRequestContext(response);
    if (!walletAddress) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to access delegations');
    }
    const ownerAddress = request.query.owner_address ? String(request.query.owner_address).toLowerCase() : null;
    const strategyId = request.query.strategy_id ? String(request.query.strategy_id) : null;
    const policies = delegatedPolicyRepository.list().filter((policy) => {
      if (ownerAddress && policy.ownerAddress.toLowerCase() !== ownerAddress) {
        return false;
      }
      if (strategyId && policy.strategyId !== strategyId) {
        return false;
      }
      return true;
    });

    return sendSuccess(response, {
      policies,
      ...getDelegatedAutomationConfigStatus()
    });
  });

  app.post('/api/v1/delegations', (request, response) => {
    const bodySchema = z.object({
      strategy_id: z.string().min(1),
      owner_address: z.string().min(42),
      market_symbol: z.string().min(1),
      max_order_size_usd: z.number().positive(),
      max_slippage_bps: z.number().int().min(1).max(1_000),
      daily_loss_limit_usd: z.number().positive(),
      valid_until: z.string().min(1),
      approval_tx_hash: z
        .string()
        .trim()
        .refine((value) => isValidTxHash(value), {
          message: 'approval_tx_hash must be a 0x-prefixed 64-byte hex transaction hash'
        })
        .optional()
        .nullable()
    });

    const parsedBody = bodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendError(response, 'VALIDATION_ERROR', 'invalid delegation payload', parsedBody.error.flatten());
    }

    const data = parsedBody.data;
    const { sessionId, walletAddress } = getRequestContext(response);
    if (!walletAddress) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to create delegations');
    }
    if (walletAddress !== data.owner_address.toLowerCase()) {
      return sendError(response, 'AUTH_REQUIRED', 'connected wallet does not match owner address');
    }
    const state = getState();
    const annotation = state.annotations.find((item) => item.strategy.strategyId === data.strategy_id);
    if (!annotation) {
      return sendError(response, 'NOT_FOUND', 'strategy not found');
    }

    const config = getDelegatedAutomationConfigStatus();
    const now = new Date().toISOString();
    const existing = delegatedPolicyRepository.list().find(
      (policy) => policy.strategyId === data.strategy_id && policy.ownerAddress.toLowerCase() === data.owner_address.toLowerCase()
    );

    const policy: DelegatedAutomationPolicy = {
      policyId: existing?.policyId ?? createId('dlg'),
      strategyId: data.strategy_id,
      ownerAddress: data.owner_address,
      delegateAddress: config.executorAddress ?? '0x0000000000000000000000000000000000000000',
      marketSymbol: data.market_symbol,
      status: data.approval_tx_hash ? 'active' : 'pending_approval',
      maxOrderSizeUsd: data.max_order_size_usd,
      maxSlippageBps: data.max_slippage_bps,
      dailyLossLimitUsd: data.daily_loss_limit_usd,
      validUntil: data.valid_until,
      approvalTxHash: normalizeTxHash(data.approval_tx_hash),
      vaultAddress: config.vaultAddress,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    delegatedPolicyRepository.upsert(policy);
    appendAudit(
      'automation_enabled',
      'automation',
      policy.policyId,
      {
        strategyId: policy.strategyId,
        delegated: true,
        maxOrderSizeUsd: policy.maxOrderSizeUsd,
        maxSlippageBps: policy.maxSlippageBps
      },
      sessionId
    );

    return sendSuccess(response, {
      policy,
      executor_address: config.executorAddress,
      vault_address: config.vaultAddress,
      ready: config.ready
    });
  });

  app.get('/api/v1/markets', async (_request, response) => {
    const { markets, source } = await getAvailableMarkets();
    sendSuccess(response, { markets, source });
  });

  app.get('/api/v1/market-data/candles', async (request, response) => {
    const symbol = String(request.query.symbol ?? 'BTCUSDT');
    const timeframe = String(request.query.timeframe ?? '1h');
    const { candles, source } = await getMarketCandles(symbol, timeframe);
    sendSuccess(response, {
      symbol,
      timeframe,
      source,
      candles: candles.map(toCandleResponse)
    });
  });

  app.get('/api/v1/market-data/stream', async (request, response) => {
    const symbol = String(request.query.symbol ?? 'BTCUSDT');
    const timeframe = String(request.query.timeframe ?? '1h');

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();

    let closed = false;

    const pushSnapshot = async () => {
      try {
        const { candles, source } = await getMarketSnapshot(symbol, timeframe);
        if (closed) {
          return;
        }

        response.write(
          `data: ${JSON.stringify({
            symbol,
            timeframe,
            source,
            current_price: candles.at(-1)?.close ?? 0,
            candles: candles.map(toCandleResponse)
          })}\n\n`
        );
      } catch (error) {
        if (closed) {
          return;
        }

        response.write(
          `event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : 'stream failed' })}\n\n`
        );
      }
    };

    response.write(': connected\n\n');
    await pushSnapshot();

    const interval = setInterval(() => {
      void pushSnapshot();
    }, marketStreamIntervalMs);

    request.on('close', () => {
      closed = true;
      clearInterval(interval);
      response.end();
    });
  });

  app.post('/api/v1/alerts', (request, response) => {
    const annotationId = String(request.body.annotation_id ?? '');
    const value = String(request.body.value ?? '');
    const { sessionId } = getRequestContext(response);
    const state = getState();
    const ownerKey = resolveAnnotationOwnerKey(request, response);
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to create alerts');
    }
    const annotation = findScopedAnnotation(state, annotationId, ownerKey);
    if (!annotation) {
      return sendError(response, 'NOT_FOUND', 'annotation not found');
    }

    const notification: NotificationItem = {
      notificationId: createId('noti'),
      type: 'alert_fired',
      title: '알림 등록 완료',
      body: `${annotation.marketSymbol} ${value} 조건 알림이 등록되었습니다.`,
      annotationId,
      sessionId,
      createdAt: new Date().toISOString(),
      read: false
    };
    appendNotification(notification);
    appendAudit('status_changed', 'annotation', annotationId, { alertValue: value }, sessionId);
    return sendSuccess(response, { notification });
  });

  app.post('/api/v1/ai/news-insights', async (request, response) => {
    const bodySchema = z.object({
      market_symbol: z.string(),
      timeframe: z.string(),
      threshold: z.number().min(0.1).max(20).optional()
    });
    const parsedBody = bodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendError(response, 'VALIDATION_ERROR', 'invalid news insights payload', parsedBody.error.flatten());
    }

    const { market_symbol, timeframe } = parsedBody.data;
    const threshold = parsedBody.data.threshold ?? 0.5;
    const ownerKey = resolveAnnotationOwnerKey(request, response);
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to access personalized insights');
    }
    const candles = await getCandles(market_symbol, timeframe);
    const cacheKey = getNewsInsightCacheKey(market_symbol, timeframe, threshold);
    const state = getState();
    const cachedEntry =
      state.newsInsightCache.find((entry) => entry.cacheKey === cacheKey && entry.ownerKey === ownerKey) ?? null;
    const currentLastOpenTime = candles.at(-1)?.openTime ?? null;

    const cachedInsights = reindexNewsInsights(cachedEntry?.insights ?? [], candles);

    if (!currentLastOpenTime) {
      return sendSuccess(response, {
        insights: cachedInsights,
        provider: 'fallback' as const,
        cached: Boolean(cachedEntry)
      });
    }

    if (cachedEntry?.lastAnalyzedOpenTime === currentLastOpenTime) {
      return sendSuccess(response, { insights: cachedInsights, provider: 'openai' as const, cached: true });
    }

    let incrementalCandles = candles;
    let indexOffset = 0;
    if (cachedEntry?.lastAnalyzedOpenTime) {
      const lastAnalyzedIndex = candles.findIndex((candle) => candle.openTime === cachedEntry.lastAnalyzedOpenTime);
      if (lastAnalyzedIndex >= 0 && lastAnalyzedIndex < candles.length - 1) {
        indexOffset = Math.max(lastAnalyzedIndex, 0);
        incrementalCandles = candles.slice(indexOffset);
      }
    }

    if (incrementalCandles.length < 2) {
      return sendSuccess(response, { insights: cachedInsights, provider: 'openai' as const, cached: true });
    }

    const result = await generateNewsInsights({
      marketSymbol: market_symbol,
      timeframe,
      candles: incrementalCandles,
      threshold,
      indexOffset
    });

    const mergedInsights = reindexNewsInsights(mergeNewsInsights(cachedInsights, result.insights), candles);
    const nextEntry: NewsInsightCacheEntry = {
      cacheKey,
      ownerKey,
      marketSymbol: market_symbol,
      timeframe,
      threshold,
      lastAnalyzedOpenTime: currentLastOpenTime,
      updatedAt: new Date().toISOString(),
      insights: mergedInsights
    };

    updateState((current) => ({
      ...current,
      newsInsightCache: [
        ...current.newsInsightCache.filter((entry) => !(entry.cacheKey === cacheKey && entry.ownerKey === ownerKey)),
        nextEntry
      ]
    }));

    return sendSuccess(response, { insights: mergedInsights, provider: result.provider, cached: false });
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
    const { sessionId } = getRequestContext(response);
    const ownerKey = resolveAnnotationOwnerKey(request, response);
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to create AI strategies');
    }
    const candles = await getCandles(market_symbol, timeframe);
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
      ownerKey,
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
    appendAudit(
      'ai_analysis_requested',
      'annotation',
      annotationId,
      { provider: analysis.provider, symbol: market_symbol, timeframe },
      sessionId
    );
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
    return sendSuccess(response, {
      strategy: result.strategy,
      parsing_notes: result.parsingNotes,
      missing_fields: result.missingFields,
      provider: result.provider
    });
  });

  app.post('/api/v1/strategies/:strategyId/validate', async (request, response) => {
    const state = getState();
    const { sessionId } = getRequestContext(response);
    const ownerKey = resolveAnnotationOwnerKey(request, response);
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to validate strategies');
    }
    const annotation = state.annotations.find(
      (item) => item.strategy.strategyId === request.params.strategyId && item.ownerKey === ownerKey
    );
    if (!annotation) {
      return sendError(response, 'NOT_FOUND', 'strategy not found');
    }
    const candles = await getCandles(annotation.marketSymbol, annotation.timeframe);
    const currentPrice = candles.at(-1)?.close ?? annotation.strategy.entryPrice;
    const validation = validateStrategy(annotation.strategy, currentPrice, defaultUserSettings);
    appendAudit(
      validation.isValid ? 'strategy_validated' : 'strategy_invalid',
      'strategy',
      annotation.strategy.strategyId,
      { currentPrice },
      sessionId
    );
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

  app.post('/api/v1/automations', (request, response) => {
    const strategyId = String(request.body.strategy_id ?? '');
    const { sessionId } = getRequestContext(response);
    const state = getState();
    const ownerKey = resolveAnnotationOwnerKey(request, response);
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to configure automations');
    }
    const annotation = state.annotations.find((item) => item.strategy.strategyId === strategyId && item.ownerKey === ownerKey);
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
      annotations: current.annotations.map((item) =>
        item.annotationId === annotation.annotationId
          ? syncAnnotationWithStrategy(item, { ...item.strategy, autoExecuteEnabled: true })
          : item
      )
    }));
    automationRepository.create(automation);
    appendAudit('automation_enabled', 'automation', automation.automationId, { maxLeverage: automation.maxLeverage }, sessionId);
    return sendSuccess(response, { automation_id: automation.automationId, status: automation.status });
  });

  app.get('/api/v1/notifications', (_request, response) => {
    const { sessionId, walletAddress } = getRequestContext(response);
    if (!walletAddress) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to access notifications');
    }
    const notifications = notificationRepository.list();
    return sendSuccess(response, {
      notifications: notifications.filter((notification) => notification.sessionId === sessionId)
    });
  });

  app.get('/api/v1/audit-logs', (request, response) => {
    const annotationId = request.query.annotation_id ? String(request.query.annotation_id) : null;
    const strategyId = request.query.strategy_id ? String(request.query.strategy_id) : null;
    const executionId = request.query.execution_id ? String(request.query.execution_id) : null;
    const { sessionId, walletAddress } = getRequestContext(response);
    if (!walletAddress) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to access audit logs');
    }
    const events = auditRepository.list().filter((event) => {
      if (event.sessionId !== sessionId) {
        return false;
      }
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
}
