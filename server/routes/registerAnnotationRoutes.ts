import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { createAnnotationFromText, syncAnnotationWithStrategy } from '../../src/utils/annotation';
import type {
  Annotation,
  Execution,
  NotificationItem
} from '../../src/types/domain';
import { sendError, sendSuccess } from '../utils/response';
import { getRequestContext } from '../utils/requestContext';
import { createId } from '../utils/ids';
import { parseAnnotationWithLlm } from '../services/llmService';
import { getHyperliquidConfigStatus, closeHyperliquidPosition } from '../services/hyperliquidExecutionService';

type State = ReturnType<RegisterAnnotationRoutesDependencies['getState']>;

interface RegisterAnnotationRoutesDependencies {
  app: Express;
  getState: () => State;
  updateState: (updater: (state: State) => State) => State;
  getCandles: (symbol: string, timeframe: string) => Promise<Array<{ openTime: string; high: number; low: number; close: number }>>;
  ensureSeedState: (symbol: string, timeframe: string, ownerKey: string) => Promise<void>;
  resolveAnnotationOwnerKey: (request: Request, response: Response) => string | null;
  isAnnotationVisibleToOwner: (annotation: Annotation, ownerKey: string) => boolean;
  findScopedAnnotation: (state: State, annotationId: string, ownerKey: string) => Annotation | undefined;
  executionRepository: {
    list: () => Execution[];
    create: (execution: Execution) => Execution;
    update: (executionId: string, updater: (execution: Execution) => Execution) => Execution | null;
  };
  isCancellableExecutionStatus: (status: Execution['status']) => boolean;
  isFilledExecutionStatus: (status: Execution['status']) => boolean;
  deriveAnnotationStatusForDirectClose: (status: Execution['status']) => Annotation['status'];
  buildDirectExecutionRecord: (input: {
    strategyId: string;
    sessionId?: string | null;
    actionType: Execution['actionType'];
    closeMode: Execution['closeMode'];
    receipt: unknown;
    fallbackPrice: number;
  }) => Execution;
  directExecutionReceiptSchema: z.ZodTypeAny;
  normalizeWalletAddress: (value: unknown) => string | null;
  toExecutionResponse: (execution: Execution) => unknown;
  appendNotification: (notification: NotificationItem) => void;
  appendAudit: (
    eventType: 'annotation_created' | 'annotation_edited' | 'status_changed',
    entityType: 'annotation' | 'execution',
    entityId: string,
    metadata: Record<string, string | number | boolean>,
    sessionId?: string | null
  ) => void;
}

export function registerAnnotationRoutes({
  app,
  getState,
  updateState,
  getCandles,
  ensureSeedState,
  resolveAnnotationOwnerKey,
  isAnnotationVisibleToOwner,
  findScopedAnnotation,
  executionRepository,
  isCancellableExecutionStatus,
  isFilledExecutionStatus,
  deriveAnnotationStatusForDirectClose,
  buildDirectExecutionRecord,
  directExecutionReceiptSchema,
  normalizeWalletAddress,
  toExecutionResponse,
  appendNotification,
  appendAudit
}: RegisterAnnotationRoutesDependencies) {
  app.get('/api/v1/annotations', async (request, response) => {
    const symbol = String(request.query.symbol ?? 'BTCUSDT');
    const timeframe = String(request.query.timeframe ?? '1h');
    const ownerKey = resolveAnnotationOwnerKey(request, response);
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to access annotations');
    }
    await ensureSeedState(symbol, timeframe, ownerKey);
    const state = getState();
    const annotations = state.annotations.filter(
      (annotation) =>
        annotation.marketSymbol === symbol &&
        annotation.timeframe === timeframe &&
        isAnnotationVisibleToOwner(annotation, ownerKey)
    );
    sendSuccess(response, { annotations });
  });

  app.get('/api/v1/annotations/:annotationId', (request, response) => {
    const state = getState();
    const ownerKey = resolveAnnotationOwnerKey(request, response);
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to access annotations');
    }
    const annotation = findScopedAnnotation(state, request.params.annotationId, ownerKey);
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
    const { sessionId } = getRequestContext(response);
    const ownerKey = resolveAnnotationOwnerKey(request, response);
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to create annotations');
    }
    const candles = await getCandles(data.market_symbol, data.timeframe);
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
      authorId: ownerKey.startsWith('wallet:') ? ownerKey.slice('wallet:'.length) : 'guest',
      ownerKey,
      anchor: {
        time: data.chart_anchor.time,
        price: Number(data.chart_anchor.price),
        index: data.chart_anchor.index ?? Math.max(candles.length - 1, 0)
      },
      strategy: parsed.strategy
    });

    updateState((state) => ({ ...state, annotations: [annotation, ...state.annotations] }));
    appendAudit('annotation_created', 'annotation', annotation.annotationId, { provider: parsed.provider }, sessionId);
    return sendSuccess(response, {
      annotation_id: annotation.annotationId,
      status: annotation.status,
      annotation,
      parsing_notes: parsed.parsingNotes
    });
  });

  app.patch('/api/v1/annotations/:annotationId', async (request, response) => {
    const state = getState();
    const { sessionId } = getRequestContext(response);
    const ownerKey = resolveAnnotationOwnerKey(request, response);
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to update annotations');
    }
    const annotation = findScopedAnnotation(state, request.params.annotationId, ownerKey);
    if (!annotation) {
      return sendError(response, 'NOT_FOUND', 'annotation not found');
    }

    const nextText = typeof request.body.text === 'string' ? request.body.text : annotation.text;
    const candles = await getCandles(annotation.marketSymbol, annotation.timeframe);
    const visibleLevels = candles.slice(-10).flatMap((candle) => [candle.high, candle.low, candle.close]);
    const parsed = await parseAnnotationWithLlm({
      text: nextText,
      marketSymbol: annotation.marketSymbol,
      timeframe: annotation.timeframe,
      currentPrice: candles.at(-1)?.close ?? 0,
      visibleLevels,
      annotationId: annotation.annotationId
    });

    const nextDrawingObjects = Array.isArray(request.body.drawing_objects)
      ? request.body.drawing_objects.map((object: any) => {
          if (object?.type === 'line') {
            return { id: String(object.id), type: 'line' as const, role: object.role, price: Number(object.price) };
          }

          if (object?.type === 'box') {
            return {
              id: String(object.id),
              type: 'box' as const,
              role: object.role,
              priceFrom: Number(object.priceFrom),
              priceTo: Number(object.priceTo)
            };
          }

          if (object?.type === 'segment') {
            return {
              id: String(object.id),
              type: 'segment' as const,
              role: object.role,
              startAnchor: {
                time: String(object.startAnchor?.time ?? annotation.chartAnchor.time),
                price: Number(object.startAnchor?.price ?? annotation.chartAnchor.price),
                index: Number(object.startAnchor?.index ?? annotation.chartAnchor.index)
              },
              endAnchor: {
                time: String(object.endAnchor?.time ?? annotation.chartAnchor.time),
                price: Number(object.endAnchor?.price ?? annotation.chartAnchor.price),
                index: Number(object.endAnchor?.index ?? annotation.chartAnchor.index)
              }
            };
          }

          return { id: String(object.id), type: 'text' as const, role: object.role, text: String(object.text ?? '') };
        })
      : annotation.drawingObjects;

    const nextAnnotation = syncAnnotationWithStrategy(
      {
        ...annotation,
        drawingObjects: nextDrawingObjects,
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
    appendAudit('annotation_edited', 'annotation', nextAnnotation.annotationId, { provider: parsed.provider }, sessionId);
    return sendSuccess(response, { annotation: nextAnnotation, parsing_notes: parsed.parsingNotes });
  });

  app.post('/api/v1/annotations/:annotationId/cancel-order', (request, response) => {
    const state = getState();
    const { sessionId } = getRequestContext(response);
    const ownerKey = resolveAnnotationOwnerKey(request, response);
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to manage annotations');
    }
    const annotation = findScopedAnnotation(state, request.params.annotationId, ownerKey);
    if (!annotation) {
      return sendError(response, 'NOT_FOUND', 'annotation not found');
    }

    const latestCancellableExecution =
      executionRepository
        .list()
        .filter(
          (execution) =>
            execution.strategyId === annotation.strategy.strategyId &&
            Boolean(execution.externalOrderId) &&
            isCancellableExecutionStatus(execution.status)
        )
        .sort((left, right) => new Date(right.filledAt ?? 0).getTime() - new Date(left.filledAt ?? 0).getTime())[0] ?? null;

    if (!latestCancellableExecution && (annotation.status === 'Executed' || annotation.status === 'Closed' || annotation.status === 'Archived')) {
      return sendError(response, 'INVALID_STATE', 'only pending orders can be cancelled');
    }

    const now = new Date().toISOString();
    const nextStatus = latestCancellableExecution?.actionType === 'close' ? ('Executed' as const) : ('Invalidated' as const);

    const nextAnnotation = { ...annotation, status: nextStatus, updatedAt: now };

    updateState((current) => ({
      ...current,
      annotations: current.annotations.map((item) => (item.annotationId === nextAnnotation.annotationId ? nextAnnotation : item))
    }));

    if (latestCancellableExecution) {
      executionRepository.update(latestCancellableExecution.executionId, (execution) => ({
        ...execution,
        status: 'Cancelled',
        filledAt: execution.filledAt ?? now
      }));
    }

    appendNotification({
      notificationId: createId('noti'),
      type: latestCancellableExecution?.actionType === 'close' ? 'strategy_triggered' : 'strategy_invalidated',
      title: latestCancellableExecution?.actionType === 'close' ? '청산 주문 취소 완료' : '주문 취소 완료',
      body:
        latestCancellableExecution?.actionType === 'close'
          ? `${annotation.marketSymbol} 리듀스온리 청산 주문이 취소되었습니다.`
          : `${annotation.marketSymbol} 대기 주문이 취소되었습니다.`,
      annotationId: annotation.annotationId,
      sessionId,
      createdAt: now,
      read: false
    });
    appendAudit(
      'status_changed',
      'annotation',
      annotation.annotationId,
      {
        action: latestCancellableExecution?.actionType === 'close' ? 'cancel_close_order' : 'cancel_order',
        executionId: latestCancellableExecution?.executionId ?? 'none',
        executionStatus: latestCancellableExecution?.status ?? 'none',
        previousStatus: annotation.status,
        nextStatus: nextAnnotation.status
      },
      sessionId
    );

    return sendSuccess(response, { annotation: nextAnnotation });
  });

  app.post('/api/v1/annotations/:annotationId/close-position', async (request, response) => {
    const bodySchema = z.object({
      mode: z.enum(['market', 'price']),
      close_price: z.number().positive().optional()
    });
    const parsedBody = bodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendError(response, 'VALIDATION_ERROR', 'invalid close position payload', parsedBody.error.flatten());
    }

    const state = getState();
    const { sessionId } = getRequestContext(response);
    const ownerKey = resolveAnnotationOwnerKey(request, response);
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to close positions');
    }
    const annotation = findScopedAnnotation(state, request.params.annotationId, ownerKey);
    if (!annotation) {
      return sendError(response, 'NOT_FOUND', 'annotation not found');
    }

    if (annotation.status !== 'Executed') {
      return sendError(response, 'INVALID_STATE', 'only active positions can be closed');
    }

    const candles = await getCandles(annotation.marketSymbol, annotation.timeframe);
    const marketPrice = candles.at(-1)?.close ?? annotation.strategy.entryPrice;
    const latestExecution =
      executionRepository
        .list()
        .filter((execution) => execution.strategyId === annotation.strategy.strategyId)
        .sort((left, right) => new Date(right.filledAt ?? 0).getTime() - new Date(left.filledAt ?? 0).getTime())[0] ?? null;

    if (latestExecution?.settlementMode === 'perp_dex' && getHyperliquidConfigStatus().ready) {
      try {
        const futuresCloseReceipt = await closeHyperliquidPosition(annotation.marketSymbol, marketPrice, parsedBody.data);
        const now = futuresCloseReceipt.filledAt;
        const closeExecution: Execution = {
          executionId: createId('exe'),
          strategyId: annotation.strategy.strategyId,
          sessionId,
          actionType: 'close',
          closeMode: parsedBody.data.mode,
          status: futuresCloseReceipt.status,
          executionChain: futuresCloseReceipt.executionChain,
          liquidityChain: futuresCloseReceipt.liquidityChain,
          executionChainTxHash: null,
          liquidityChainTxHash: null,
          executionChainTxStatus: 'success',
          liquidityChainTxStatus: 'success',
          executionChainBlockNumber: null,
          liquidityChainBlockNumber: null,
          executionChainLogCount: null,
          liquidityChainLogCount: null,
          liquidityTransferCount: null,
          liquiditySwapEventCount: null,
          liquidityTouchedContractCount: null,
          liquiditySettlementState: 'settled_without_decoded_events',
          executionChainCheckedAt: now,
          liquidityChainCheckedAt: now,
          executionChainTxHashValid: true,
          liquidityChainTxHashValid: true,
          txHashWarning: null,
          settlementMode: futuresCloseReceipt.settlementMode,
          dexExecuted: false,
          executionTxState: 'receipt_observed',
          liquidityReceiptEvidence: 'receipt_observed',
          dexRouterAddress: null,
          dexInputTokenAddress: null,
          dexOutputTokenAddress: null,
          dexAmountIn: null,
          dexExpectedAmountOut: null,
          dexMinimumAmountOut: null,
          externalVenue: futuresCloseReceipt.externalVenue,
          externalOrderId: futuresCloseReceipt.externalOrderId,
          externalClientOrderId: futuresCloseReceipt.externalClientOrderId,
          executedQuantity: futuresCloseReceipt.executedQuantity,
          leverageUsed: futuresCloseReceipt.leverageUsed,
          proofAttempted: false,
          proofRetryCount: 0,
          proofErrorMessage: null,
          proofRecorded: false,
          proofState: 'not_attempted',
          proofRegistryId: null,
          proofContractAddress: null,
          filledPrice: futuresCloseReceipt.filledPrice ?? marketPrice,
          filledAt: now
        };

        updateState((current) => ({
          ...current,
          annotations: current.annotations.map((item) =>
            item.annotationId === annotation.annotationId ? { ...item, status: 'Closed', updatedAt: now } : item
          )
        }));
        executionRepository.create(closeExecution);

        appendNotification({
          notificationId: createId('noti'),
          type: 'execution_filled',
          title: '포지션 정리 완료',
          body: `${annotation.marketSymbol} 포지션이 Hyperliquid testnet 시장가로 정리되었습니다.`,
          annotationId: annotation.annotationId,
          sessionId,
          createdAt: now,
          read: false
        });
        appendAudit(
          'status_changed',
          'execution',
          closeExecution.executionId,
          {
            action: 'close_position',
            mode: parsedBody.data.mode,
            closePrice: closeExecution.filledPrice ?? marketPrice,
            previousStatus: annotation.status,
            nextStatus: 'Closed',
            settlementMode: 'perp_dex',
            externalOrderId: futuresCloseReceipt.externalOrderId ?? 'unknown'
          },
          sessionId
        );

        return sendSuccess(response, {
          annotation: { ...annotation, status: 'Closed', updatedAt: now },
          execution: toExecutionResponse(closeExecution)
        });
      } catch (error) {
        return sendError(response, 'EXECUTION_ERROR', error instanceof Error ? error.message : 'unable to close Hyperliquid position');
      }
    }

    const closePrice = parsedBody.data.mode === 'market' ? marketPrice : parsedBody.data.close_price;
    if (!closePrice || !Number.isFinite(closePrice)) {
      return sendError(response, 'VALIDATION_ERROR', 'close price is required');
    }

    const now = new Date().toISOString();
    const closeExecution: Execution = {
      executionId: createId('exe'),
      strategyId: annotation.strategy.strategyId,
      sessionId,
      actionType: 'close',
      closeMode: parsedBody.data.mode,
      status: 'Filled',
      executionChain: 'opbnb',
      liquidityChain: 'bsc',
      executionChainTxHash: null,
      liquidityChainTxHash: null,
      executionChainTxStatus: 'unavailable',
      liquidityChainTxStatus: 'unavailable',
      executionChainBlockNumber: null,
      liquidityChainBlockNumber: null,
      executionChainLogCount: null,
      liquidityChainLogCount: null,
      liquidityTransferCount: null,
      liquiditySwapEventCount: null,
      liquidityTouchedContractCount: null,
      liquiditySettlementState: 'mock_fallback',
      executionChainCheckedAt: null,
      liquidityChainCheckedAt: null,
      executionChainTxHashValid: true,
      liquidityChainTxHashValid: true,
      txHashWarning: null,
      settlementMode: 'mock',
      dexExecuted: false,
      executionTxState: 'not_submitted',
      liquidityReceiptEvidence: 'mock_fallback',
      dexRouterAddress: null,
      dexInputTokenAddress: null,
      dexOutputTokenAddress: null,
      dexAmountIn: null,
      dexExpectedAmountOut: null,
      dexMinimumAmountOut: null,
      proofAttempted: false,
      proofRetryCount: 0,
      proofErrorMessage: null,
      proofRecorded: false,
      proofState: 'not_attempted',
      proofRegistryId: null,
      proofContractAddress: null,
      filledPrice: closePrice,
      filledAt: now
    };

    updateState((current) => ({
      ...current,
      annotations: current.annotations.map((item) =>
        item.annotationId === annotation.annotationId ? { ...item, status: 'Closed', updatedAt: now } : item
      )
    }));
    executionRepository.create(closeExecution);

    appendNotification({
      notificationId: createId('noti'),
      type: 'execution_filled',
      title: '포지션 정리 완료',
      body: `${annotation.marketSymbol} 포지션이 ${parsedBody.data.mode === 'market' ? '즉시가' : '지정가'} ${closePrice.toLocaleString('ko-KR')} USDT 기준으로 정리되었습니다.`,
      annotationId: annotation.annotationId,
      sessionId,
      createdAt: now,
      read: false
    });
    appendAudit(
      'status_changed',
      'execution',
      closeExecution.executionId,
      {
        action: 'close_position',
        mode: parsedBody.data.mode,
        closePrice,
        previousStatus: annotation.status,
        nextStatus: 'Closed'
      },
      sessionId
    );

    return sendSuccess(response, {
      annotation: { ...annotation, status: 'Closed', updatedAt: now },
      execution: toExecutionResponse(closeExecution)
    });
  });

  app.post('/api/v1/annotations/:annotationId/close-position/direct', (request, response) => {
    const bodySchema = z.object({
      mode: z.enum(['market', 'price']).default('market'),
      wallet_address: z.string().min(1),
      receipt: directExecutionReceiptSchema
    });
    const parsedBody = bodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendError(response, 'VALIDATION_ERROR', 'invalid direct close payload', parsedBody.error.flatten());
    }

    const walletAddress = normalizeWalletAddress(parsedBody.data.wallet_address);
    if (!walletAddress) {
      return sendError(response, 'VALIDATION_ERROR', 'invalid wallet address');
    }

    const ownerKey = resolveAnnotationOwnerKey(request, response);
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to close positions');
    }
    if (ownerKey !== `wallet:${walletAddress}`) {
      return sendError(response, 'AUTH_REQUIRED', 'connected wallet does not match the execution wallet');
    }

    const state = getState();
    const { sessionId } = getRequestContext(response);
    const annotation = findScopedAnnotation(state, request.params.annotationId, ownerKey);
    if (!annotation) {
      return sendError(response, 'NOT_FOUND', 'annotation not found');
    }

    if (annotation.status !== 'Executed') {
      return sendError(response, 'INVALID_STATE', 'only active positions can be closed');
    }

    const fallbackPrice = parsedBody.data.receipt.filled_price ?? annotation.strategy.entryPrice;
    const closeExecution = buildDirectExecutionRecord({
      strategyId: annotation.strategy.strategyId,
      sessionId,
      actionType: 'close',
      closeMode: parsedBody.data.mode,
      receipt: parsedBody.data.receipt,
      fallbackPrice
    });
    const nextAnnotationStatus = deriveAnnotationStatusForDirectClose(closeExecution.status);
    const nextUpdatedAt = closeExecution.filledAt ?? new Date().toISOString();

    updateState((current) => ({
      ...current,
      annotations: current.annotations.map((item) =>
        item.annotationId === annotation.annotationId
          ? { ...item, status: nextAnnotationStatus, updatedAt: nextUpdatedAt }
          : item
      )
    }));
    executionRepository.create(closeExecution);

    appendNotification({
      notificationId: createId('noti'),
      type: isFilledExecutionStatus(closeExecution.status) ? 'execution_filled' : 'strategy_triggered',
      title: isFilledExecutionStatus(closeExecution.status) ? '포지션 정리 완료' : '청산 주문 등록 완료',
      body: isFilledExecutionStatus(closeExecution.status)
        ? `${annotation.marketSymbol} 포지션이 연결된 지갑으로 직접 정리되었습니다.`
        : `${annotation.marketSymbol} 리듀스온리 청산 주문이 Hyperliquid testnet에 등록되었습니다.`,
      annotationId: annotation.annotationId,
      sessionId,
      createdAt: nextUpdatedAt,
      read: false
    });
    appendAudit(
      'status_changed',
      'execution',
      closeExecution.executionId,
      {
        action: 'close_position',
        mode: parsedBody.data.mode,
        closePrice: closeExecution.filledPrice ?? fallbackPrice,
        previousStatus: annotation.status,
        nextStatus: nextAnnotationStatus,
        settlementMode: closeExecution.settlementMode ?? 'perp_dex',
        externalOrderId: closeExecution.externalOrderId ?? 'unknown',
        walletAddress
      },
      sessionId
    );

    return sendSuccess(response, {
      annotation: { ...annotation, status: nextAnnotationStatus, updatedAt: nextUpdatedAt },
      execution: toExecutionResponse(closeExecution)
    });
  });
}
