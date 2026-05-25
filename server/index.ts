import 'dotenv/config';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { buildSeedAnnotations, defaultUserSettings } from '../src/data/mockMarket';
import { createAuditEvent } from '../src/services/auditLogService';
import { armAutomation, createExecutionPreview, executeStrategy } from '../src/services/executionService';
import { validateStrategy } from '../src/utils/strategy';
import { isValidTxHash, normalizeTxHash } from '../src/utils/txHash';
import type {
  Annotation,
  AutomationRule,
  Candle,
  DelegatedAutomationPolicy,
  EntryType,
  Execution,
  NewsInsight,
  NewsInsightCacheEntry,
  NotificationItem,
  Strategy
} from '../src/types/domain';
import { createAnnotationFromText, syncAnnotationWithStrategy } from '../src/utils/annotation';
import { getAuditRepository } from './services/auditRepository';
import { getAutomationRepository } from './services/automationRepository';
import { getDelegatedPolicyRepository } from './services/delegatedPolicyRepository';
import { getExecutionRepository } from './services/executionRepository';
import { getNotificationRepository } from './services/notificationRepository';
import { getState, updateState } from './services/stateStore';
import { analyzeChartWithLlm, parseAnnotationWithLlm, generateNewsInsights } from './services/llmService';
import { getAvailableMarkets, getMarketCandles, getMarketSnapshot, isRealMarketDataEnabled } from './services/marketDataService';
import { executeDexSwap, getDexExecutionConfigStatus } from './services/dexExecutionService';
import {
  closeHyperliquidPosition,
  createHyperliquidExecutionPreview,
  executeHyperliquidOrder,
  getHyperliquidConfigStatus
} from './services/hyperliquidExecutionService';
import { getDelegatedAutomationConfigStatus } from './services/delegatedAutomationService';
import { getOnchainConfigStatus, recordOnchainExecution, retryOnchainProofRecording } from './services/onchainExecutionService';
import { fetchAndIndexTxReceipt, indexKnownTxReceipt, refreshExecutionReceiptTracking } from './services/txReceiptTrackingService';
import { createId } from './utils/ids';
import { logError, logInfo } from './utils/logger';
import { getRequestContext, requestContextMiddleware } from './utils/requestContext';
import { sendError, sendSuccess } from './utils/response';
import { registerCoreRoutes } from './routes/registerCoreRoutes';
import { registerAnnotationRoutes } from './routes/registerAnnotationRoutes';
import { registerExecutionRoutes } from './routes/registerExecutionRoutes';
import { registerAdminRoutes } from './routes/registerAdminRoutes';

const app = express();
const port = Number(process.env.API_PORT ?? 8787);
const marketStreamIntervalMs = Number(process.env.MARKET_STREAM_INTERVAL_MS ?? 5000);
const auditRepository = getAuditRepository();
const automationRepository = getAutomationRepository();
const delegatedPolicyRepository = getDelegatedPolicyRepository();
const executionRepository = getExecutionRepository();
const notificationRepository = getNotificationRepository();

app.use(cors());
app.use(express.json());
app.use((request, response, next) => {
  const startedAt = Date.now();
  requestContextMiddleware(request, response, () => {
    const { requestId, sessionId } = getRequestContext(response);

    response.on('finish', () => {
      logInfo('http_request_completed', {
        requestId,
        ...(sessionId ? { sessionId } : {}),
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt
      });
    });

    next();
  });
});

async function getCandles(symbol: string, timeframe: string) {
  return (await getMarketCandles(symbol, timeframe)).candles;
}

function getNewsInsightCacheKey(symbol: string, timeframe: string, threshold: number) {
  return `${symbol}:${timeframe}:${threshold.toFixed(2)}`;
}

function reindexNewsInsights(insights: NewsInsight[], candles: Candle[]) {
  const candleIndexByTime = new Map(candles.map((candle, index) => [candle.openTime, index]));
  return insights
    .map((insight) => {
      const candleIndex = candleIndexByTime.get(insight.time);
      if (typeof candleIndex !== 'number') {
        return null;
      }
      return {
        ...insight,
        candleIndex
      } satisfies NewsInsight;
    })
    .filter((insight): insight is NewsInsight => insight !== null)
    .sort((left, right) => left.candleIndex - right.candleIndex);
}

function mergeNewsInsights(existing: NewsInsight[], incoming: NewsInsight[]) {
  const merged = new Map<string, NewsInsight>();
  for (const insight of existing) {
    merged.set(insight.insightId, insight);
  }
  for (const insight of incoming) {
    merged.set(insight.insightId, insight);
  }
  return [...merged.values()].sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());
}

function normalizeWalletAddress(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function resolveAnnotationOwnerKey(request: Request, response: Response) {
  const walletAddress = normalizeWalletAddress(request.header('X-Wallet-Address')) ?? getRequestContext(response).walletAddress;
  if (walletAddress) {
    return `wallet:${walletAddress}`;
  }
  return null;
}

function isAnnotationVisibleToOwner(annotation: Annotation, ownerKey: string) {
  return annotation.ownerKey === ownerKey;
}

function findScopedAnnotation(state: ReturnType<typeof getState>, annotationId: string, ownerKey: string) {
  return state.annotations.find(
    (item) => item.annotationId === annotationId && isAnnotationVisibleToOwner(item, ownerKey)
  );
}

async function ensureSeedState(symbol: string, timeframe: string, ownerKey: string) {
  const candles = await getCandles(symbol, timeframe);
  const seed = buildSeedAnnotations(symbol, timeframe, candles, ownerKey);
  const state = getState();
  if (
    !state.annotations.some(
      (annotation) =>
        annotation.marketSymbol === symbol &&
        annotation.timeframe === timeframe &&
        isAnnotationVisibleToOwner(annotation, ownerKey)
    )
  ) {
    updateState((current) => ({
      ...current,
      annotations: [...seed, ...current.annotations]
    }));
  }
}

function appendNotification(notification: NotificationItem) {
  notificationRepository.create(notification);
}

function appendAudit(eventType: Parameters<typeof createAuditEvent>[0], entityType: Parameters<typeof createAuditEvent>[1], entityId: string, metadata: Record<string, string | number | boolean>, sessionId?: string | null) {
  auditRepository.create(createAuditEvent(eventType, entityType, entityId, metadata, sessionId));
}

const directExecutionReceiptSchema = z.object({
  execution_chain: z.string().min(1),
  liquidity_chain: z.string().min(1),
  settlement_mode: z.string().min(1),
  external_venue: z.string().min(1),
  external_order_id: z.string().min(1).nullable().optional(),
  external_client_order_id: z.string().min(1).nullable().optional(),
  leverage_used: z.number().nonnegative(),
  executed_quantity: z.string().min(1),
  side: z.enum(['BUY', 'SELL']),
  reduce_only: z.boolean(),
  status: z.string().min(1),
  filled_price: z.number().positive().nullable(),
  filled_at: z.string().min(1)
});

function buildDirectExecutionRecord(input: {
  strategyId: string;
  sessionId?: string | null;
  actionType: Execution['actionType'];
  closeMode: Execution['closeMode'];
  receipt: z.infer<typeof directExecutionReceiptSchema>;
  fallbackPrice: number;
}) {
  return {
    executionId: createId('exe'),
    strategyId: input.strategyId,
    sessionId: input.sessionId ?? null,
    actionType: input.actionType,
    closeMode: input.closeMode,
    status: input.receipt.status as Execution['status'],
    executionChain: input.receipt.execution_chain as Execution['executionChain'],
    liquidityChain: input.receipt.liquidity_chain as Execution['liquidityChain'],
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
    executionChainCheckedAt: input.receipt.filled_at,
    liquidityChainCheckedAt: input.receipt.filled_at,
    executionChainTxHashValid: true,
    liquidityChainTxHashValid: true,
    txHashWarning: null,
    settlementMode: input.receipt.settlement_mode as Execution['settlementMode'],
    dexExecuted: false,
    executionTxState: 'receipt_observed',
    liquidityReceiptEvidence: 'receipt_observed',
    dexRouterAddress: null,
    dexInputTokenAddress: null,
    dexOutputTokenAddress: null,
    dexAmountIn: null,
    dexExpectedAmountOut: null,
    dexMinimumAmountOut: null,
    externalVenue: input.receipt.external_venue as Execution['externalVenue'],
    externalOrderId: input.receipt.external_order_id ?? null,
    externalClientOrderId: input.receipt.external_client_order_id ?? null,
    executedQuantity: input.receipt.executed_quantity,
    leverageUsed: input.receipt.leverage_used,
    proofAttempted: false,
    proofRetryCount: 0,
    proofErrorMessage: null,
    proofRecorded: false,
    proofState: 'not_attempted',
    proofRegistryId: null,
    proofContractAddress: null,
    filledPrice: input.receipt.filled_price ?? input.fallbackPrice,
    filledAt: input.receipt.filled_at
  } satisfies Execution;
}

function isFilledExecutionStatus(status: Execution['status']) {
  return status === 'Filled' || status === 'PartiallyFilled';
}

function isCancellableExecutionStatus(status: Execution['status']) {
  return status === 'Pending' || status === 'ReadyToExecute' || status === 'Executing' || status === 'PartiallyFilled';
}

function deriveAnnotationStatusForDirectOpen(status: Execution['status'], entryType: EntryType) {
  if (isFilledExecutionStatus(status)) {
    return 'Executed' as const;
  }

  return entryType === 'conditional' ? ('Triggered' as const) : ('Active' as const);
}

function deriveAnnotationStatusForDirectClose(status: Execution['status']) {
  return isFilledExecutionStatus(status) ? ('Closed' as const) : ('Executed' as const);
}

function getTxHashWarningLabel(kind: 'execution' | 'liquidity') {
  return kind === 'execution' ? 'Execution Tx' : 'Liquidity Tx';
}

function sanitizeExecutionTxHashes(execution: Pick<Execution, 'executionChainTxHash' | 'liquidityChainTxHash'>) {
  const executionChainTxHash = normalizeTxHash(execution.executionChainTxHash);
  const liquidityChainTxHash = normalizeTxHash(execution.liquidityChainTxHash);
  const executionChainTxHashValid =
    execution.executionChainTxHash == null ? true : isValidTxHash(execution.executionChainTxHash);
  const liquidityChainTxHashValid =
    execution.liquidityChainTxHash == null ? true : isValidTxHash(execution.liquidityChainTxHash);

  const invalidLabels = [
    !executionChainTxHashValid ? getTxHashWarningLabel('execution') : null,
    !liquidityChainTxHashValid ? getTxHashWarningLabel('liquidity') : null
  ].filter(Boolean);

  return {
    executionChainTxHash,
    liquidityChainTxHash,
    executionChainTxHashValid,
    liquidityChainTxHashValid,
    txHashWarning:
      invalidLabels.length > 0 ? `${invalidLabels.join(', ')} hash was invalid and has been hidden.` : null
  };
}

function deriveProofState(execution: Pick<Execution, 'proofRecorded' | 'proofRegistryId' | 'proofContractAddress' | 'proofAttempted'> & {
  executionChainTxHash: string | null;
}) {
  if (execution.proofRecorded && execution.executionChainTxHash) {
    return 'recorded' as const;
  }

  if (execution.proofAttempted || execution.proofRegistryId || execution.proofContractAddress) {
    return 'attempted_not_recorded' as const;
  }

  return 'not_attempted' as const;
}

function usesExternalVenueSettlement(settlementMode: Execution['settlementMode']) {
  return settlementMode === 'perp_dex';
}

function deriveExecutionTxState(execution: Pick<Execution, 'settlementMode' | 'dexExecuted'> & {
  liquidityChainTxHash: string | null;
  externalOrderId?: string | null;
}) {
  if (usesExternalVenueSettlement(execution.settlementMode)) {
    return execution.externalOrderId ? 'receipt_observed' as const : 'submitted_receipt_unavailable' as const;
  }

  if (execution.settlementMode !== 'dex' || !execution.dexExecuted) {
    return 'not_submitted' as const;
  }

  if (execution.liquidityChainTxHash) {
    return 'receipt_observed' as const;
  }

  return 'submitted_receipt_unavailable' as const;
}

function deriveLiquidityReceiptEvidence(execution: Pick<Execution, 'settlementMode' | 'dexExecuted'> & {
  liquidityChainTxHash: string | null;
  liquidityChainTxHashValid?: boolean;
  externalOrderId?: string | null;
}) {
  if (usesExternalVenueSettlement(execution.settlementMode)) {
    return execution.externalOrderId ? 'receipt_observed' as const : 'receipt_not_observed' as const;
  }

  if (execution.settlementMode !== 'dex' || !execution.dexExecuted) {
    return 'mock_fallback' as const;
  }

  if (execution.liquidityChainTxHash) {
    return 'receipt_observed' as const;
  }

  if (execution.liquidityChainTxHashValid === false) {
    return 'receipt_observed_hash_hidden' as const;
  }

  return 'receipt_not_observed' as const;
}

function deriveLiquiditySettlementState(execution: Pick<
  Execution,
  'settlementMode' | 'dexExecuted' | 'liquiditySettlementState' | 'liquidityChainTxStatus' | 'liquiditySwapEventCount' | 'liquidityTransferCount'
>) {
  if (execution.liquiditySettlementState) {
    return execution.liquiditySettlementState;
  }

  if (usesExternalVenueSettlement(execution.settlementMode)) {
    if (execution.liquidityChainTxStatus === 'reverted') {
      return 'reverted' as const;
    }

    if (execution.liquidityChainTxStatus === 'pending') {
      return 'pending_receipt' as const;
    }

    return 'settled_without_decoded_events' as const;
  }

  if (execution.settlementMode !== 'dex' || !execution.dexExecuted) {
    return 'mock_fallback' as const;
  }

  if (execution.liquidityChainTxStatus === 'pending') {
    return 'pending_receipt' as const;
  }

  if (execution.liquidityChainTxStatus === 'reverted') {
    return 'reverted' as const;
  }

  if (execution.liquidityChainTxStatus !== 'success') {
    return 'receipt_unavailable' as const;
  }

  if ((execution.liquiditySwapEventCount ?? 0) > 0) {
    return 'settled_with_swap_event' as const;
  }

  if ((execution.liquidityTransferCount ?? 0) > 0) {
    return 'settled_with_transfer_events' as const;
  }

  return 'settled_without_decoded_events' as const;
}

function deriveLiquiditySettlementResult(execution: Pick<
  Execution,
  'settlementMode' | 'dexExecuted' | 'liquiditySettlementState' | 'liquidityChainTxStatus' | 'liquiditySwapEventCount' | 'liquidityTransferCount'
>) {
  const settlementState = deriveLiquiditySettlementState(execution);
  if (settlementState === 'mock_fallback' || settlementState === 'pending_receipt' || settlementState === 'receipt_unavailable') {
    return 'unknown' as const;
  }

  if (settlementState === 'reverted') {
    return 'failed' as const;
  }

  return 'success' as const;
}

function toExecutionResponse(execution: Execution) {
  const sanitizedHashes = sanitizeExecutionTxHashes(execution);
  const proofState = deriveProofState({
    proofRecorded: execution.proofRecorded,
    proofAttempted: execution.proofAttempted ?? false,
    proofRegistryId: execution.proofRegistryId ?? null,
    proofContractAddress: execution.proofContractAddress ?? null,
    executionChainTxHash: sanitizedHashes.executionChainTxHash
  });
  const executionTxState = deriveExecutionTxState({
    settlementMode: execution.settlementMode,
    dexExecuted: execution.dexExecuted,
    liquidityChainTxHash: sanitizedHashes.liquidityChainTxHash,
    externalOrderId: execution.externalOrderId ?? null
  });
  const liquidityReceiptEvidence = deriveLiquidityReceiptEvidence({
    settlementMode: execution.settlementMode,
    dexExecuted: execution.dexExecuted,
    liquidityChainTxHash: sanitizedHashes.liquidityChainTxHash,
    liquidityChainTxHashValid: sanitizedHashes.liquidityChainTxHashValid,
    externalOrderId: execution.externalOrderId ?? null
  });
  const liquiditySettlementState = deriveLiquiditySettlementState(execution);
  const liquiditySettlementResult = deriveLiquiditySettlementResult(execution);

  return {
    execution_id: execution.executionId,
    strategy_id: execution.strategyId,
    action_type: execution.actionType ?? 'open',
    close_mode: execution.closeMode ?? null,
    status: execution.status,
    execution_chain: execution.executionChain,
    liquidity_chain: execution.liquidityChain,
    execution_chain_tx_hash: sanitizedHashes.executionChainTxHash,
    liquidity_chain_tx_hash: sanitizedHashes.liquidityChainTxHash,
    execution_chain_tx_status: execution.executionChainTxStatus ?? null,
    liquidity_chain_tx_status: execution.liquidityChainTxStatus ?? null,
    execution_chain_block_number: execution.executionChainBlockNumber ?? null,
    liquidity_chain_block_number: execution.liquidityChainBlockNumber ?? null,
    execution_chain_log_count: execution.executionChainLogCount ?? null,
    liquidity_chain_log_count: execution.liquidityChainLogCount ?? null,
    liquidity_transfer_count: execution.liquidityTransferCount ?? null,
    liquidity_swap_event_count: execution.liquiditySwapEventCount ?? null,
    liquidity_touched_contract_count: execution.liquidityTouchedContractCount ?? null,
    liquidity_settlement_state: liquiditySettlementState,
    liquidity_settlement_result: liquiditySettlementResult,
    execution_chain_checked_at: execution.executionChainCheckedAt ?? null,
    liquidity_chain_checked_at: execution.liquidityChainCheckedAt ?? null,
    execution_chain_tx_hash_valid: sanitizedHashes.executionChainTxHashValid,
    liquidity_chain_tx_hash_valid: sanitizedHashes.liquidityChainTxHashValid,
    tx_hash_warning: sanitizedHashes.txHashWarning,
    settlement_mode: execution.settlementMode,
    dex_executed: execution.dexExecuted,
    execution_tx_state: executionTxState,
    liquidity_receipt_evidence: liquidityReceiptEvidence,
    dex_router_address: execution.dexRouterAddress ?? null,
    dex_input_token_address: execution.dexInputTokenAddress ?? null,
    dex_output_token_address: execution.dexOutputTokenAddress ?? null,
    dex_amount_in: execution.dexAmountIn ?? null,
    dex_expected_amount_out: execution.dexExpectedAmountOut ?? null,
    dex_minimum_amount_out: execution.dexMinimumAmountOut ?? null,
    external_venue: execution.externalVenue ?? null,
    external_order_id: execution.externalOrderId ?? null,
    external_client_order_id: execution.externalClientOrderId ?? null,
    executed_quantity: execution.executedQuantity ?? null,
    leverage_used: execution.leverageUsed ?? null,
    proof_recorded: execution.proofRecorded ?? false,
    proof_attempted: execution.proofAttempted ?? false,
    proof_retry_count: execution.proofRetryCount ?? 0,
    proof_error_message: execution.proofErrorMessage ?? null,
    proof_state: proofState,
    proof_registry_id: execution.proofRegistryId ?? null,
    proof_contract_address: execution.proofContractAddress ?? null,
    filled_price: execution.filledPrice ?? null,
    filled_at: execution.filledAt ?? null
  };
}

function buildExecutionAuditMetadata(
  execution: Pick<
    Execution,
    | 'settlementMode'
    | 'dexExecuted'
    | 'dexRouterAddress'
    | 'dexInputTokenAddress'
    | 'dexOutputTokenAddress'
    | 'dexAmountIn'
    | 'dexExpectedAmountOut'
    | 'dexMinimumAmountOut'
    | 'externalVenue'
    | 'externalOrderId'
    | 'externalClientOrderId'
    | 'executedQuantity'
    | 'leverageUsed'
  >,
  receipt: {
    executionTxState: ReturnType<typeof deriveExecutionTxState>;
    liquidityReceiptEvidence: ReturnType<typeof deriveLiquidityReceiptEvidence>;
    executionChainTxStatus?: Execution['executionChainTxStatus'];
    liquidityChainTxStatus?: Execution['liquidityChainTxStatus'];
    executionChainBlockNumber?: number | null;
    liquidityChainBlockNumber?: number | null;
    executionChainLogCount?: number | null;
    liquidityChainLogCount?: number | null;
    liquidityChainTxHashVisible: boolean;
    liquidityChainTxHashValid: boolean;
    txHashWarning: string | null;
  },
  proof: {
    proofAttempted: boolean;
    proofRetryCount: number;
    proofErrorMessage: string | null;
    proofRecorded: boolean;
    onchainReady: boolean;
  },
  dex: {
    dexReady: boolean;
  }
) {
  return {
    executionChain: usesExternalVenueSettlement(execution.settlementMode) ? 'hyperliquid-testnet' : 'opbnb',
    liquidityChain: usesExternalVenueSettlement(execution.settlementMode) ? 'hyperliquid-testnet' : 'bsc',
    settlementMode: execution.settlementMode ?? 'mock',
    dexExecuted: execution.dexExecuted ?? false,
    dexReady: dex.dexReady,
    executionTxState: receipt.executionTxState,
    liquidityReceiptEvidence: receipt.liquidityReceiptEvidence,
    liquiditySettlementState: deriveLiquiditySettlementState({
      settlementMode: execution.settlementMode,
      dexExecuted: execution.dexExecuted,
      liquiditySettlementState: undefined,
      liquidityChainTxStatus: receipt.liquidityChainTxStatus,
      liquiditySwapEventCount: undefined,
      liquidityTransferCount: undefined
    }),
    executionChainTxStatus: receipt.executionChainTxStatus ?? 'unavailable',
    liquidityChainTxStatus: receipt.liquidityChainTxStatus ?? 'unavailable',
    liquidityChainTxHashVisible: receipt.liquidityChainTxHashVisible,
    liquidityChainTxHashValid: receipt.liquidityChainTxHashValid,
    invalidTxHashFiltered: Boolean(receipt.txHashWarning),
    proofAttempted: proof.proofAttempted,
    proofRetryCount: proof.proofRetryCount,
    proofErrorPresent: Boolean(proof.proofErrorMessage),
    proofRecorded: proof.proofRecorded,
    onchainReady: proof.onchainReady,
    ...(receipt.executionChainBlockNumber != null ? { executionChainBlockNumber: receipt.executionChainBlockNumber } : {}),
    ...(receipt.liquidityChainBlockNumber != null ? { liquidityChainBlockNumber: receipt.liquidityChainBlockNumber } : {}),
    ...(receipt.executionChainLogCount != null ? { executionChainLogCount: receipt.executionChainLogCount } : {}),
    ...(receipt.liquidityChainLogCount != null ? { liquidityChainLogCount: receipt.liquidityChainLogCount } : {}),
    ...(proof.proofErrorMessage ? { proofErrorMessage: proof.proofErrorMessage } : {}),
    ...(execution.dexRouterAddress ? { dexRouterAddress: execution.dexRouterAddress } : {}),
    ...(execution.dexInputTokenAddress ? { dexInputTokenAddress: execution.dexInputTokenAddress } : {}),
    ...(execution.dexOutputTokenAddress ? { dexOutputTokenAddress: execution.dexOutputTokenAddress } : {}),
    ...(execution.dexAmountIn ? { dexAmountIn: execution.dexAmountIn } : {}),
    ...(execution.dexExpectedAmountOut ? { dexExpectedAmountOut: execution.dexExpectedAmountOut } : {}),
    ...(execution.dexMinimumAmountOut ? { dexMinimumAmountOut: execution.dexMinimumAmountOut } : {}),
    ...(execution.externalVenue ? { externalVenue: execution.externalVenue } : {}),
    ...(execution.externalOrderId ? { externalOrderId: execution.externalOrderId } : {}),
    ...(execution.externalClientOrderId ? { externalClientOrderId: execution.externalClientOrderId } : {}),
    ...(execution.executedQuantity ? { executedQuantity: execution.executedQuantity } : {}),
    ...(execution.leverageUsed != null ? { leverageUsed: execution.leverageUsed } : {})
  };
}

registerCoreRoutes({
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
});

registerAnnotationRoutes({
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
});

registerExecutionRoutes({
  app,
  getState,
  updateState,
  getCandles,
  executionRepository,
  getHyperliquidConfigStatus,
  deriveExecutionTxState,
  deriveLiquidityReceiptEvidence,
  deriveLiquiditySettlementState,
  deriveLiquiditySettlementResult,
  deriveProofState,
  sanitizeExecutionTxHashes,
  buildExecutionAuditMetadata,
  normalizeWalletAddress,
  buildDirectExecutionRecord,
  directExecutionReceiptSchema,
  deriveAnnotationStatusForDirectOpen,
  isFilledExecutionStatus,
  toExecutionResponse,
  resolveAnnotationOwnerKey,
  appendNotification,
  appendAudit
});

registerAdminRoutes({
  app,
  auditRepository,
  automationRepository,
  delegatedPolicyRepository,
  executionRepository,
  notificationRepository,
  getState
});

app.listen(port, () => {
  logInfo('api_server_started', { port, baseUrl: `http://localhost:${port}` });
});
