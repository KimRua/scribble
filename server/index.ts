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
  const walletAddress = normalizeWalletAddress(request.header('X-Wallet-Address'));
  if (walletAddress) {
    return `wallet:${walletAddress}`;
  }

  const { sessionId } = getRequestContext(response);
  return `guest:${sessionId ?? 'anonymous'}`;
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
  const { sessionId } = getRequestContext(response);
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
  appendAudit('automation_enabled', 'automation', policy.policyId, {
    strategyId: policy.strategyId,
    delegated: true,
    maxOrderSizeUsd: policy.maxOrderSizeUsd,
    maxSlippageBps: policy.maxSlippageBps
  }, sessionId);

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

      response.write(`data: ${JSON.stringify({
        symbol,
        timeframe,
        source,
        current_price: candles.at(-1)?.close ?? 0,
        candles: candles.map((candle) => ({
          open_time: candle.openTime,
          open: String(candle.open),
          high: String(candle.high),
          low: String(candle.low),
          close: String(candle.close),
          volume: String(candle.volume)
        }))
      })}\n\n`);
    } catch (error) {
      if (closed) {
        return;
      }

      response.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : 'stream failed' })}\n\n`);
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

app.get('/api/v1/annotations', async (request, response) => {
  const symbol = String(request.query.symbol ?? 'BTCUSDT');
  const timeframe = String(request.query.timeframe ?? '1h');
  const ownerKey = resolveAnnotationOwnerKey(request, response);
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
  return sendSuccess(response, { annotation_id: annotation.annotationId, status: annotation.status, annotation, parsing_notes: parsed.parsingNotes });
});

app.patch('/api/v1/annotations/:annotationId', async (request, response) => {
  const state = getState();
  const { sessionId } = getRequestContext(response);
  const ownerKey = resolveAnnotationOwnerKey(request, response);
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
          return {
            id: String(object.id),
            type: 'line' as const,
            role: object.role,
            price: Number(object.price)
          };
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

        return {
          id: String(object.id),
          type: 'text' as const,
          role: object.role,
          text: String(object.text ?? '')
        };
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
  const annotation = findScopedAnnotation(state, request.params.annotationId, ownerKey);
  if (!annotation) {
    return sendError(response, 'NOT_FOUND', 'annotation not found');
  }

  const latestCancellableExecution = executionRepository
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

  const nextAnnotation = {
    ...annotation,
    status: nextStatus,
    updatedAt: now
  };

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
  appendAudit('status_changed', 'annotation', annotation.annotationId, {
    action: latestCancellableExecution?.actionType === 'close' ? 'cancel_close_order' : 'cancel_order',
    executionId: latestCancellableExecution?.executionId ?? 'none',
    executionStatus: latestCancellableExecution?.status ?? 'none',
    previousStatus: annotation.status,
    nextStatus: nextAnnotation.status
  }, sessionId);

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
  const annotation = findScopedAnnotation(state, request.params.annotationId, ownerKey);
  if (!annotation) {
    return sendError(response, 'NOT_FOUND', 'annotation not found');
  }

  if (annotation.status !== 'Executed') {
    return sendError(response, 'INVALID_STATE', 'only active positions can be closed');
  }

  const candles = await getCandles(annotation.marketSymbol, annotation.timeframe);
  const marketPrice = candles.at(-1)?.close ?? annotation.strategy.entryPrice;
  const latestExecution = executionRepository
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
          item.annotationId === annotation.annotationId
            ? { ...item, status: 'Closed', updatedAt: now }
            : item
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
      appendAudit('status_changed', 'execution', closeExecution.executionId, {
        action: 'close_position',
        mode: parsedBody.data.mode,
        closePrice: closeExecution.filledPrice ?? marketPrice,
        previousStatus: annotation.status,
        nextStatus: 'Closed',
        settlementMode: 'perp_dex',
        externalOrderId: futuresCloseReceipt.externalOrderId ?? 'unknown'
      }, sessionId);

      return sendSuccess(response, {
        annotation: {
          ...annotation,
          status: 'Closed',
          updatedAt: now
        },
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
      item.annotationId === annotation.annotationId
        ? { ...item, status: 'Closed', updatedAt: now }
        : item
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
  appendAudit('status_changed', 'execution', closeExecution.executionId, {
    action: 'close_position',
    mode: parsedBody.data.mode,
    closePrice,
    previousStatus: annotation.status,
    nextStatus: 'Closed'
  }, sessionId);

  return sendSuccess(response, {
    annotation: {
      ...annotation,
      status: 'Closed',
      updatedAt: now
    },
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
  appendAudit('status_changed', 'execution', closeExecution.executionId, {
    action: 'close_position',
    mode: parsedBody.data.mode,
    closePrice: closeExecution.filledPrice ?? fallbackPrice,
    previousStatus: annotation.status,
    nextStatus: nextAnnotationStatus,
    settlementMode: closeExecution.settlementMode ?? 'perp_dex',
    externalOrderId: closeExecution.externalOrderId ?? 'unknown',
    walletAddress
  }, sessionId);

  return sendSuccess(response, {
    annotation: {
      ...annotation,
      status: nextAnnotationStatus,
      updatedAt: nextUpdatedAt
    },
    execution: toExecutionResponse(closeExecution)
  });
});

app.post('/api/v1/alerts', (request, response) => {
  const annotationId = String(request.body.annotation_id ?? '');
  const value = String(request.body.value ?? '');
  const { sessionId } = getRequestContext(response);
  const state = getState();
  const ownerKey = resolveAnnotationOwnerKey(request, response);
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
  const candles = await getCandles(market_symbol, timeframe);
  const cacheKey = getNewsInsightCacheKey(market_symbol, timeframe, threshold);
  const state = getState();
  const cachedEntry =
    state.newsInsightCache.find((entry) => entry.cacheKey === cacheKey && entry.ownerKey === ownerKey) ?? null;
  const currentLastOpenTime = candles.at(-1)?.openTime ?? null;

  let cachedInsights = reindexNewsInsights(cachedEntry?.insights ?? [], candles);

  if (!currentLastOpenTime) {
    return sendSuccess(response, { insights: cachedInsights, provider: 'fallback' as const, cached: Boolean(cachedEntry) });
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
  appendAudit('ai_analysis_requested', 'annotation', annotationId, { provider: analysis.provider, symbol: market_symbol, timeframe }, sessionId);
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

app.post('/api/v1/strategies/:strategyId/validate', async (request, response) => {
  const state = getState();
  const { sessionId } = getRequestContext(response);
  const annotation = state.annotations.find((item) => item.strategy.strategyId === request.params.strategyId);
  if (!annotation) {
    return sendError(response, 'NOT_FOUND', 'strategy not found');
  }
  const candles = await getCandles(annotation.marketSymbol, annotation.timeframe);
  const currentPrice = candles.at(-1)?.close ?? annotation.strategy.entryPrice;
  const validation = validateStrategy(annotation.strategy, currentPrice, defaultUserSettings);
  appendAudit(validation.isValid ? 'strategy_validated' : 'strategy_invalid', 'strategy', annotation.strategy.strategyId, { currentPrice }, sessionId);
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

app.post('/api/v1/executions/preview', async (request, response) => {
  const strategyId = String(request.body.strategy_id ?? '');
  const state = getState();
  const annotation = state.annotations.find((item) => item.strategy.strategyId === strategyId);
  if (!annotation) {
    return sendError(response, 'NOT_FOUND', 'strategy not found');
  }
  const candles = await getCandles(annotation.marketSymbol, annotation.timeframe);
  const currentPrice = candles.at(-1)?.close ?? annotation.strategy.entryPrice;
  const preview = getHyperliquidConfigStatus().ready
    ? await createHyperliquidExecutionPreview(annotation.strategy, annotation.marketSymbol, currentPrice, defaultUserSettings)
    : createExecutionPreview(annotation.strategy, currentPrice, defaultUserSettings);
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

app.get('/api/v1/executions', async (request, response) => {
  const symbol = request.query.symbol ? String(request.query.symbol) : null;
  const timeframe = request.query.timeframe ? String(request.query.timeframe) : null;
  const state = getState();
  const { sessionId } = getRequestContext(response);

  const executions = executionRepository.list().filter((execution) => {
    if (sessionId && execution.sessionId !== sessionId) {
      return false;
    }

    if (!symbol && !timeframe) {
      return true;
    }

    const annotation = state.annotations.find((item) => item.strategy.strategyId === execution.strategyId);
    if (!annotation) {
      return false;
    }

    if (symbol && annotation.marketSymbol !== symbol) {
      return false;
    }

    if (timeframe && annotation.timeframe !== timeframe) {
      return false;
    }

    return true;
  });

  const refreshedExecutions = await Promise.all(
    executions.map(async (execution) => {
      const nextExecution = await refreshExecutionReceiptTracking(execution);
      if (nextExecution !== execution) {
        executionRepository.update(execution.executionId, () => nextExecution);
      }
      return nextExecution;
    })
  );

  return sendSuccess(response, {
    executions: refreshedExecutions.map((execution) => toExecutionResponse(execution))
  });
});

app.post('/api/v1/executions/:executionId/refresh-receipts', async (request, response) => {
  const { executionId } = request.params;
  const { sessionId } = getRequestContext(response);
  const execution = executionRepository.getById(executionId);

  if (!execution) {
    return sendError(response, 'NOT_FOUND', 'execution not found');
  }

  if (sessionId && execution.sessionId !== sessionId) {
    return sendError(response, 'NOT_FOUND', 'execution not found');
  }

  const refreshedExecution = await refreshExecutionReceiptTracking(execution);
  executionRepository.update(executionId, () => refreshedExecution);
  const executionTxState = deriveExecutionTxState({
    settlementMode: refreshedExecution.settlementMode,
    dexExecuted: refreshedExecution.dexExecuted,
    liquidityChainTxHash: refreshedExecution.liquidityChainTxHash,
    externalOrderId: refreshedExecution.externalOrderId ?? null
  });
  const liquidityReceiptEvidence = deriveLiquidityReceiptEvidence({
    settlementMode: refreshedExecution.settlementMode,
    dexExecuted: refreshedExecution.dexExecuted,
    liquidityChainTxHash: refreshedExecution.liquidityChainTxHash,
    liquidityChainTxHashValid: refreshedExecution.liquidityChainTxHashValid,
    externalOrderId: refreshedExecution.externalOrderId ?? null
  });
  const liquiditySettlementState = deriveLiquiditySettlementState(refreshedExecution);
  const liquiditySettlementResult = deriveLiquiditySettlementResult(refreshedExecution);

  return sendSuccess(response, {
    execution_id: refreshedExecution.executionId,
    execution_tx_state: executionTxState,
    liquidity_receipt_evidence: liquidityReceiptEvidence,
    execution_chain_tx_status: refreshedExecution.executionChainTxStatus ?? null,
    liquidity_chain_tx_status: refreshedExecution.liquidityChainTxStatus ?? null,
    execution_chain_block_number: refreshedExecution.executionChainBlockNumber ?? null,
    liquidity_chain_block_number: refreshedExecution.liquidityChainBlockNumber ?? null,
    execution_chain_log_count: refreshedExecution.executionChainLogCount ?? null,
    liquidity_chain_log_count: refreshedExecution.liquidityChainLogCount ?? null,
    liquidity_transfer_count: refreshedExecution.liquidityTransferCount ?? null,
    liquidity_swap_event_count: refreshedExecution.liquiditySwapEventCount ?? null,
    liquidity_touched_contract_count: refreshedExecution.liquidityTouchedContractCount ?? null,
    liquidity_settlement_state: liquiditySettlementState,
    liquidity_settlement_result: liquiditySettlementResult,
    execution_chain_checked_at: refreshedExecution.executionChainCheckedAt ?? null,
    liquidity_chain_checked_at: refreshedExecution.liquidityChainCheckedAt ?? null
  });
});

app.post('/api/v1/executions/:executionId/retry-proof', async (request, response) => {
  const { executionId } = request.params;
  const { sessionId } = getRequestContext(response);
  const execution = executionRepository.getById(executionId);

  if (!execution) {
    return sendError(response, 'NOT_FOUND', 'execution not found');
  }

  if (sessionId && execution.sessionId !== sessionId) {
    return sendError(response, 'NOT_FOUND', 'execution not found');
  }

  const state = getState();
  const annotation = state.annotations.find((item) => item.strategy.strategyId === execution.strategyId);
  if (!annotation) {
    return sendError(response, 'NOT_FOUND', 'strategy not found');
  }

  const retryReceipt = await retryOnchainProofRecording(annotation.strategy);
  const nextProofRetryCount =
    execution.proofRetryCount == null
      ? retryReceipt.attempted
        ? 1 + (retryReceipt.retryCount ?? 0)
        : 0
      : execution.proofRetryCount + (retryReceipt.attempted ? 1 + (retryReceipt.retryCount ?? 0) : 0);

  const refreshedExecution: Execution = {
    ...execution,
    executionChainTxHash: retryReceipt.resultTxHash ?? execution.executionChainTxHash,
    executionChainTxStatus: retryReceipt.resultTxStatus ?? execution.executionChainTxStatus ?? 'unavailable',
    executionChainBlockNumber: retryReceipt.resultTxBlockNumber ?? execution.executionChainBlockNumber ?? null,
    executionChainLogCount: retryReceipt.resultTxLogCount ?? execution.executionChainLogCount ?? null,
    executionChainCheckedAt: retryReceipt.resultTxCheckedAt ?? execution.executionChainCheckedAt ?? null,
    proofAttempted: retryReceipt.attempted ?? execution.proofAttempted ?? false,
    proofRetryCount: nextProofRetryCount,
    proofErrorMessage: retryReceipt.errorMessage ?? null,
    proofRecorded: Boolean(retryReceipt.resultTxHash ?? execution.executionChainTxHash),
    proofRegistryId: retryReceipt.registryId ?? execution.proofRegistryId ?? null,
    proofContractAddress: retryReceipt.contractAddress ?? execution.proofContractAddress ?? null
  };

  executionRepository.update(executionId, () => refreshedExecution);

  if (refreshedExecution.executionChainTxHash && retryReceipt.resultTxCheckedAt) {
    indexKnownTxReceipt({
      txHash: refreshedExecution.executionChainTxHash,
      chain: 'opbnb',
      status: refreshedExecution.executionChainTxStatus ?? 'pending',
      blockNumber: refreshedExecution.executionChainBlockNumber ?? null,
      logCount: refreshedExecution.executionChainLogCount ?? null,
      contractAddress: refreshedExecution.proofContractAddress ?? null,
      transferCount: null,
      swapEventCount: null,
      touchedContractCount: null,
      touchedContracts: [],
      syncedAt: refreshedExecution.executionChainCheckedAt ?? retryReceipt.resultTxCheckedAt
    });
  }

  const proofState = deriveProofState({
    proofRecorded: refreshedExecution.proofRecorded,
    proofAttempted: refreshedExecution.proofAttempted ?? false,
    proofRegistryId: refreshedExecution.proofRegistryId ?? null,
    proofContractAddress: refreshedExecution.proofContractAddress ?? null,
    executionChainTxHash: refreshedExecution.executionChainTxHash
  });

  return sendSuccess(response, {
    execution_id: refreshedExecution.executionId,
    proof_attempted: refreshedExecution.proofAttempted ?? false,
    proof_retry_count: refreshedExecution.proofRetryCount ?? 0,
    proof_error_message: refreshedExecution.proofErrorMessage ?? null,
    proof_recorded: refreshedExecution.proofRecorded ?? false,
    proof_state: proofState,
    proof_registry_id: refreshedExecution.proofRegistryId ?? null,
    proof_contract_address: refreshedExecution.proofContractAddress ?? null,
    execution_chain_tx_hash: refreshedExecution.executionChainTxHash ?? null,
    execution_chain_tx_status: refreshedExecution.executionChainTxStatus ?? null,
    execution_chain_block_number: refreshedExecution.executionChainBlockNumber ?? null,
    execution_chain_log_count: refreshedExecution.executionChainLogCount ?? null,
    execution_chain_checked_at: refreshedExecution.executionChainCheckedAt ?? null
  });
});

app.get('/api/v1/tx-receipts/:txHash', async (request, response) => {
  const chain = request.query.chain === 'opbnb' ? 'opbnb' : request.query.chain === 'bsc' ? 'bsc' : null;
  const txHash = normalizeTxHash(request.params.txHash);

  if (!chain || !txHash) {
    return sendError(response, 'VALIDATION_ERROR', 'chain and valid tx hash are required');
  }

  const receipt = await fetchAndIndexTxReceipt(chain, txHash);
  if (!receipt) {
    return sendSuccess(response, {
      tx_hash: txHash,
      chain,
      status: 'unavailable',
      block_number: null,
      log_count: null,
      contract_address: null,
      transfer_count: null,
      swap_event_count: null,
      touched_contract_count: null,
      touched_contracts: [],
      synced_at: null
    });
  }

  return sendSuccess(response, {
    tx_hash: receipt.txHash,
    chain: receipt.chain,
    status: receipt.status,
    block_number: receipt.blockNumber,
    log_count: receipt.logCount,
    contract_address: receipt.contractAddress,
    transfer_count: receipt.transferCount,
    swap_event_count: receipt.swapEventCount,
    touched_contract_count: receipt.touchedContractCount,
    touched_contracts: receipt.touchedContracts,
    synced_at: receipt.syncedAt
  });
});

app.post('/api/v1/executions', async (request, response) => {
  try {
    const strategyId = String(request.body.strategy_id ?? '');
    const { requestId, sessionId } = getRequestContext(response);
    const state = getState();
    const annotation = state.annotations.find((item) => item.strategy.strategyId === strategyId);
    if (!annotation) {
      return sendError(response, 'NOT_FOUND', 'strategy not found');
    }

    if (getHyperliquidConfigStatus().ready) {
      const candles = await getCandles(annotation.marketSymbol, annotation.timeframe);
      const marketPrice = candles.at(-1)?.close ?? annotation.strategy.entryPrice;
      const futuresReceipt = await executeHyperliquidOrder(annotation.strategy, annotation.marketSymbol, marketPrice);
      const persistedExecution: Execution = {
        executionId: createId('exe'),
        strategyId: annotation.strategy.strategyId,
        sessionId,
        actionType: 'open',
        closeMode: null,
        status: futuresReceipt.status,
        executionChain: futuresReceipt.executionChain,
        liquidityChain: futuresReceipt.liquidityChain,
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
        executionChainCheckedAt: futuresReceipt.filledAt,
        liquidityChainCheckedAt: futuresReceipt.filledAt,
        executionChainTxHashValid: true,
        liquidityChainTxHashValid: true,
        txHashWarning: null,
        settlementMode: futuresReceipt.settlementMode,
        dexExecuted: false,
        executionTxState: 'receipt_observed',
        liquidityReceiptEvidence: 'receipt_observed',
        dexRouterAddress: null,
        dexInputTokenAddress: null,
        dexOutputTokenAddress: null,
        dexAmountIn: null,
        dexExpectedAmountOut: null,
        dexMinimumAmountOut: null,
        externalVenue: futuresReceipt.externalVenue,
        externalOrderId: futuresReceipt.externalOrderId,
        externalClientOrderId: futuresReceipt.externalClientOrderId,
        executedQuantity: futuresReceipt.executedQuantity,
        leverageUsed: futuresReceipt.leverageUsed,
        proofAttempted: false,
        proofRetryCount: 0,
        proofErrorMessage: null,
        proofRecorded: false,
        proofState: 'not_attempted',
        proofRegistryId: null,
        proofContractAddress: null,
        filledPrice: futuresReceipt.filledPrice ?? marketPrice,
        filledAt: futuresReceipt.filledAt
      };

      updateState((current) => ({
        ...current,
        annotations: current.annotations.map((item) =>
          item.annotationId === annotation.annotationId
            ? { ...item, status: 'Executed', updatedAt: persistedExecution.filledAt ?? new Date().toISOString() }
            : item
        )
      }));
      executionRepository.create(persistedExecution);
      appendNotification({
        notificationId: createId('noti'),
        type: 'execution_filled',
        title: '주문 실행 완료',
        body: `${annotation.marketSymbol} 전략이 Hyperliquid testnet perp 실주문으로 실행되었습니다.`,
        annotationId: annotation.annotationId,
        sessionId,
        createdAt: persistedExecution.filledAt ?? new Date().toISOString(),
        read: false
      });
      appendAudit('execute_confirmed', 'execution', persistedExecution.executionId, {
        settlementMode: 'perp_dex',
        externalVenue: futuresReceipt.externalVenue,
        externalOrderId: futuresReceipt.externalOrderId ?? 'unknown',
        executedQuantity: futuresReceipt.executedQuantity,
        leverageUsed: futuresReceipt.leverageUsed,
        side: futuresReceipt.side,
        reduceOnly: futuresReceipt.reduceOnly,
        sessionId: sessionId ?? 'unknown'
      });

      return sendSuccess(response, toExecutionResponse(persistedExecution));
    }

    const execution = executeStrategy(annotation.strategy);
    const dexReceipt = await executeDexSwap(annotation.strategy, annotation.marketSymbol);
    const onchainReceipt = await recordOnchainExecution(annotation.strategy);
    const executionHashes = sanitizeExecutionTxHashes({
      executionChainTxHash: onchainReceipt.resultTxHash ?? execution.executionChainTxHash,
      liquidityChainTxHash: dexReceipt.txHash ?? execution.liquidityChainTxHash
    });

    const persistedExecution: Execution = {
      ...execution,
      sessionId,
      actionType: 'open',
      closeMode: null,
      ...executionHashes,
      executionChainTxStatus: onchainReceipt.resultTxStatus ?? 'unavailable',
      liquidityChainTxStatus: dexReceipt.txStatus ?? (dexReceipt.executed ? 'pending' : 'unavailable'),
      executionChainBlockNumber: onchainReceipt.resultTxBlockNumber ?? null,
      liquidityChainBlockNumber: dexReceipt.txBlockNumber ?? null,
      executionChainLogCount: onchainReceipt.resultTxLogCount ?? null,
      liquidityChainLogCount: dexReceipt.txLogCount ?? null,
      liquidityTransferCount: null,
      liquiditySwapEventCount: null,
      liquidityTouchedContractCount: null,
      liquiditySettlementState:
        dexReceipt.executed
          ? dexReceipt.txStatus === 'success'
            ? 'settled_without_decoded_events'
            : dexReceipt.txStatus === 'pending'
              ? 'pending_receipt'
              : dexReceipt.txStatus === 'reverted'
                ? 'reverted'
                : 'receipt_unavailable'
          : 'mock_fallback',
      executionChainCheckedAt: onchainReceipt.resultTxCheckedAt ?? null,
      liquidityChainCheckedAt: dexReceipt.txCheckedAt ?? null,
      settlementMode: dexReceipt.executed ? 'dex' : 'mock',
      dexExecuted: dexReceipt.executed,
      dexRouterAddress: dexReceipt.routerAddress ?? null,
      dexInputTokenAddress: dexReceipt.inputTokenAddress ?? null,
      dexOutputTokenAddress: dexReceipt.outputTokenAddress ?? null,
      dexAmountIn: dexReceipt.amountIn ?? null,
      dexExpectedAmountOut: dexReceipt.expectedAmountOut ?? null,
      dexMinimumAmountOut: dexReceipt.minimumAmountOut ?? null,
      proofAttempted: onchainReceipt.attempted ?? false,
      proofRetryCount: onchainReceipt.retryCount ?? 0,
      proofErrorMessage: onchainReceipt.errorMessage ?? null,
      proofRecorded: Boolean(executionHashes.executionChainTxHash),
      proofRegistryId: onchainReceipt.registryId ?? null,
      proofContractAddress: onchainReceipt.contractAddress ?? null
    };
    if (persistedExecution.liquidityChainTxHash && dexReceipt.txCheckedAt) {
      indexKnownTxReceipt({
        txHash: persistedExecution.liquidityChainTxHash,
        chain: 'bsc',
        status: persistedExecution.liquidityChainTxStatus ?? 'pending',
        blockNumber: persistedExecution.liquidityChainBlockNumber ?? null,
        logCount: persistedExecution.liquidityChainLogCount ?? null,
        contractAddress: persistedExecution.dexRouterAddress ?? null,
        transferCount: persistedExecution.liquidityTransferCount ?? null,
        swapEventCount: persistedExecution.liquiditySwapEventCount ?? null,
        touchedContractCount: persistedExecution.liquidityTouchedContractCount ?? null,
        touchedContracts: [],
        syncedAt: persistedExecution.liquidityChainCheckedAt ?? dexReceipt.txCheckedAt
      });
    }
    if (persistedExecution.executionChainTxHash && onchainReceipt.resultTxCheckedAt) {
      indexKnownTxReceipt({
        txHash: persistedExecution.executionChainTxHash,
        chain: 'opbnb',
        status: persistedExecution.executionChainTxStatus ?? 'pending',
        blockNumber: persistedExecution.executionChainBlockNumber ?? null,
        logCount: persistedExecution.executionChainLogCount ?? null,
        contractAddress: persistedExecution.proofContractAddress ?? null,
        transferCount: null,
        swapEventCount: null,
        touchedContractCount: null,
        touchedContracts: [],
        syncedAt: persistedExecution.executionChainCheckedAt ?? onchainReceipt.resultTxCheckedAt
      });
    }
    const proofState = deriveProofState({
      proofRecorded: persistedExecution.proofRecorded,
      proofAttempted: persistedExecution.proofAttempted ?? false,
      proofRegistryId: persistedExecution.proofRegistryId ?? null,
      proofContractAddress: persistedExecution.proofContractAddress ?? null,
      executionChainTxHash: persistedExecution.executionChainTxHash
    });
    const executionTxState = deriveExecutionTxState({
      settlementMode: persistedExecution.settlementMode,
      dexExecuted: persistedExecution.dexExecuted,
      liquidityChainTxHash: persistedExecution.liquidityChainTxHash
    });
    const liquidityReceiptEvidence = deriveLiquidityReceiptEvidence({
      settlementMode: persistedExecution.settlementMode,
      dexExecuted: persistedExecution.dexExecuted,
      liquidityChainTxHash: persistedExecution.liquidityChainTxHash,
      liquidityChainTxHashValid: persistedExecution.liquidityChainTxHashValid
    });

    updateState((current) => ({
      ...current,
      annotations: current.annotations.map((item) =>
        item.annotationId === annotation.annotationId
          ? { ...item, status: 'Executed', updatedAt: new Date().toISOString() }
          : item
      )
    }));
    executionRepository.create(persistedExecution);
    logInfo('execution_request_succeeded', {
      requestId,
      ...(sessionId ? { sessionId } : {}),
      executionId: persistedExecution.executionId,
      strategyId,
      settlementMode: persistedExecution.settlementMode ?? 'mock',
      dexExecuted: persistedExecution.dexExecuted ?? false,
      proofAttempted: persistedExecution.proofAttempted ?? false,
      proofRecorded: persistedExecution.proofRecorded ?? false,
      proofRetryCount: persistedExecution.proofRetryCount ?? 0,
      proofErrorPresent: Boolean(persistedExecution.proofErrorMessage)
    });
    appendNotification({
      notificationId: createId('noti'),
      type: 'execution_filled',
      title: '주문 실행 완료',
      body: `${annotation.marketSymbol} 전략이 ${dexReceipt.executed ? 'DEX 실주문으로' : 'mock 모드로'} 실행되었습니다.`,
      annotationId: annotation.annotationId,
      sessionId,
      createdAt: new Date().toISOString(),
      read: false
    });
    appendAudit('execute_confirmed', 'execution', persistedExecution.executionId, {
      ...buildExecutionAuditMetadata(
        persistedExecution,
        {
          executionTxState,
          liquidityReceiptEvidence,
          executionChainTxStatus: persistedExecution.executionChainTxStatus,
          liquidityChainTxStatus: persistedExecution.liquidityChainTxStatus,
          executionChainBlockNumber: persistedExecution.executionChainBlockNumber,
          liquidityChainBlockNumber: persistedExecution.liquidityChainBlockNumber,
          executionChainLogCount: persistedExecution.executionChainLogCount,
          liquidityChainLogCount: persistedExecution.liquidityChainLogCount,
          liquidityChainTxHashVisible: Boolean(executionHashes.liquidityChainTxHash),
          liquidityChainTxHashValid: executionHashes.liquidityChainTxHashValid,
          txHashWarning: executionHashes.txHashWarning
        },
        {
          proofAttempted: persistedExecution.proofAttempted ?? false,
          proofRetryCount: persistedExecution.proofRetryCount ?? 0,
          proofErrorMessage: persistedExecution.proofErrorMessage ?? null,
          proofRecorded: Boolean(executionHashes.executionChainTxHash),
          onchainReady: onchainReceipt.ready
        },
        {
          dexReady: dexReceipt.ready
        }
      ),
      sessionId: sessionId ?? 'unknown'
    });
    return sendSuccess(response, toExecutionResponse({
      ...persistedExecution,
      proofState
    }));
  } catch (error) {
    const { requestId, sessionId } = getRequestContext(response);
    logError('execution_request_failed', {
      requestId,
      ...(sessionId ? { sessionId } : {}),
      path: request.path,
      strategyId: String(request.body.strategy_id ?? ''),
      message: error instanceof Error ? error.message : 'execution failed'
    });
    return sendError(response, 'EXECUTION_ERROR', error instanceof Error ? error.message : 'execution failed');
  }
});

app.post('/api/v1/executions/direct', (request, response) => {
  const bodySchema = z.object({
    strategy_id: z.string().min(1),
    wallet_address: z.string().min(1),
    entry_type: z.enum(['market', 'limit', 'conditional']).optional(),
    receipt: directExecutionReceiptSchema
  });
  const parsedBody = bodySchema.safeParse(request.body);
  if (!parsedBody.success) {
    return sendError(response, 'VALIDATION_ERROR', 'invalid direct execution payload', parsedBody.error.flatten());
  }

  const walletAddress = normalizeWalletAddress(parsedBody.data.wallet_address);
  if (!walletAddress) {
    return sendError(response, 'VALIDATION_ERROR', 'invalid wallet address');
  }

  const ownerKey = resolveAnnotationOwnerKey(request, response);
  if (ownerKey !== `wallet:${walletAddress}`) {
    return sendError(response, 'AUTH_REQUIRED', 'connected wallet does not match the execution wallet');
  }

  const { sessionId } = getRequestContext(response);
  const state = getState();
  const annotation = state.annotations.find(
    (item) => item.strategy.strategyId === parsedBody.data.strategy_id && item.ownerKey === ownerKey
  );
  if (!annotation) {
    return sendError(response, 'NOT_FOUND', 'strategy not found');
  }

  const fallbackPrice = parsedBody.data.receipt.filled_price ?? annotation.strategy.entryPrice;
  const persistedExecution = buildDirectExecutionRecord({
    strategyId: annotation.strategy.strategyId,
    sessionId,
    actionType: 'open',
    closeMode: null,
    receipt: parsedBody.data.receipt,
    fallbackPrice
  });
  const entryType = parsedBody.data.entry_type ?? annotation.strategy.entryType;
  const nextAnnotationStatus = deriveAnnotationStatusForDirectOpen(persistedExecution.status, entryType);
  const nextUpdatedAt = persistedExecution.filledAt ?? new Date().toISOString();

  updateState((current) => ({
    ...current,
    annotations: current.annotations.map((item) =>
      item.annotationId === annotation.annotationId
        ? { ...item, status: nextAnnotationStatus, updatedAt: nextUpdatedAt }
        : item
    )
  }));
  executionRepository.create(persistedExecution);

  appendNotification({
    notificationId: createId('noti'),
    type: isFilledExecutionStatus(persistedExecution.status) ? 'execution_filled' : 'strategy_triggered',
    title: isFilledExecutionStatus(persistedExecution.status) ? '주문 실행 완료' : '대기 주문 등록 완료',
    body: isFilledExecutionStatus(persistedExecution.status)
      ? `${annotation.marketSymbol} 전략이 연결된 지갑으로 Hyperliquid testnet에 직접 실행되었습니다.`
      : `${annotation.marketSymbol} ${entryType} 주문이 Hyperliquid testnet에 등록되었습니다.`,
    annotationId: annotation.annotationId,
    sessionId,
    createdAt: nextUpdatedAt,
    read: false
  });
  appendAudit('execute_confirmed', 'execution', persistedExecution.executionId, {
    settlementMode: persistedExecution.settlementMode ?? 'perp_dex',
    externalVenue: persistedExecution.externalVenue ?? 'hyperliquid_testnet',
    externalOrderId: persistedExecution.externalOrderId ?? 'unknown',
    executedQuantity: persistedExecution.executedQuantity ?? '0',
    leverageUsed: persistedExecution.leverageUsed ?? 0,
    side: parsedBody.data.receipt.side,
    reduceOnly: parsedBody.data.receipt.reduce_only,
    entryType,
    annotationStatus: nextAnnotationStatus,
    walletAddress,
    sessionId: sessionId ?? 'unknown'
  });

  return sendSuccess(response, {
    annotation: {
      ...annotation,
      status: nextAnnotationStatus,
      updatedAt: nextUpdatedAt
    },
    execution: toExecutionResponse(persistedExecution)
  });
});

app.post('/api/v1/automations', (request, response) => {
  const strategyId = String(request.body.strategy_id ?? '');
  const { sessionId } = getRequestContext(response);
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
  const { sessionId } = getRequestContext(response);
  const notifications = notificationRepository.list();
  return sendSuccess(response, {
    notifications: sessionId ? notifications.filter((notification) => notification.sessionId === sessionId) : notifications
  });
});

app.get('/api/v1/audit-logs', (request, response) => {
  const annotationId = request.query.annotation_id ? String(request.query.annotation_id) : null;
  const strategyId = request.query.strategy_id ? String(request.query.strategy_id) : null;
  const executionId = request.query.execution_id ? String(request.query.execution_id) : null;
  const { sessionId } = getRequestContext(response);
  const events = auditRepository.list().filter((event) => {
    if (sessionId && event.sessionId !== sessionId) {
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

app.listen(port, () => {
  logInfo('api_server_started', { port, baseUrl: `http://localhost:${port}` });
});
