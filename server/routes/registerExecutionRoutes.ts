import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { defaultUserSettings } from '../../src/data/mockMarket';
import { createExecutionPreview, executeStrategy } from '../../src/services/executionService';
import type { Annotation, EntryType, Execution, NotificationItem, Strategy } from '../../src/types/domain';
import { normalizeTxHash } from '../../src/utils/txHash';
import { executeDexSwap } from '../services/dexExecutionService';
import {
  createHyperliquidExecutionPreview,
  executeHyperliquidOrder,
  getHyperliquidConfigStatus
} from '../services/hyperliquidExecutionService';
import { recordOnchainExecution, retryOnchainProofRecording } from '../services/onchainExecutionService';
import { fetchAndIndexTxReceipt, indexKnownTxReceipt, refreshExecutionReceiptTracking } from '../services/txReceiptTrackingService';
import { createId } from '../utils/ids';
import { logError, logInfo } from '../utils/logger';
import { getRequestContext } from '../utils/requestContext';
import { sendError, sendSuccess } from '../utils/response';

type State = ReturnType<RegisterExecutionRoutesDependencies['getState']>;

interface RegisterExecutionRoutesDependencies {
  app: Express;
  getState: () => State;
  updateState: (updater: (state: State) => State) => State;
  getCandles: (symbol: string, timeframe: string) => Promise<Array<{ close: number }>>;
  executionRepository: {
    list: () => Execution[];
    create: (execution: Execution) => Execution;
    getById: (executionId: string) => Execution | null;
    update: (executionId: string, updater: (execution: Execution) => Execution) => Execution | null;
  };
  getHyperliquidConfigStatus: typeof getHyperliquidConfigStatus;
  deriveExecutionTxState: (execution: Pick<Execution, 'settlementMode' | 'dexExecuted'> & {
    liquidityChainTxHash: string | null;
    externalOrderId?: string | null;
  }) => 'not_submitted' | 'receipt_observed' | 'submitted_receipt_unavailable';
  deriveLiquidityReceiptEvidence: (execution: Pick<Execution, 'settlementMode' | 'dexExecuted'> & {
    liquidityChainTxHash: string | null;
    liquidityChainTxHashValid?: boolean;
    externalOrderId?: string | null;
  }) => 'mock_fallback' | 'receipt_observed' | 'receipt_observed_hash_hidden' | 'receipt_not_observed';
  deriveLiquiditySettlementState: (execution: Pick<
    Execution,
    'settlementMode' | 'dexExecuted' | 'liquiditySettlementState' | 'liquidityChainTxStatus' | 'liquiditySwapEventCount' | 'liquidityTransferCount'
  >) =>
    | 'mock_fallback'
    | 'pending_receipt'
    | 'settled_with_swap_event'
    | 'settled_with_transfer_events'
    | 'settled_without_decoded_events'
    | 'reverted'
    | 'receipt_unavailable';
  deriveLiquiditySettlementResult: typeof depsSettlementResult;
  deriveProofState: (execution: Pick<Execution, 'proofRecorded' | 'proofRegistryId' | 'proofContractAddress' | 'proofAttempted'> & {
    executionChainTxHash: string | null;
  }) => 'recorded' | 'attempted_not_recorded' | 'not_attempted';
  sanitizeExecutionTxHashes: (execution: Pick<Execution, 'executionChainTxHash' | 'liquidityChainTxHash'>) => {
    executionChainTxHash: string | null;
    liquidityChainTxHash: string | null;
    executionChainTxHashValid: boolean;
    liquidityChainTxHashValid: boolean;
    txHashWarning: string | null;
  };
  buildExecutionAuditMetadata: (
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
      executionTxState: 'not_submitted' | 'receipt_observed' | 'submitted_receipt_unavailable';
      liquidityReceiptEvidence: 'mock_fallback' | 'receipt_observed' | 'receipt_observed_hash_hidden' | 'receipt_not_observed';
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
  ) => Record<string, string | number | boolean>;
  normalizeWalletAddress: (value: unknown) => string | null;
  buildDirectExecutionRecord: (input: {
    strategyId: string;
    sessionId?: string | null;
    actionType: Execution['actionType'];
    closeMode: Execution['closeMode'];
    receipt: unknown;
    fallbackPrice: number;
  }) => Execution;
  directExecutionReceiptSchema: z.ZodTypeAny;
  deriveAnnotationStatusForDirectOpen: (status: Execution['status'], entryType: EntryType) => Annotation['status'];
  isFilledExecutionStatus: (status: Execution['status']) => boolean;
  toExecutionResponse: (execution: Execution) => unknown;
  resolveAnnotationOwnerKey: (request: Request, response: Response) => string | null;
  appendNotification: (notification: NotificationItem) => void;
  appendAudit: (
    eventType: 'execute_confirmed',
    entityType: 'execution',
    entityId: string,
    metadata: Record<string, string | number | boolean>,
    sessionId?: string | null
  ) => void;
}

type depsSettlementResult = (
  execution: Pick<
    Execution,
    'settlementMode' | 'dexExecuted' | 'liquiditySettlementState' | 'liquidityChainTxStatus' | 'liquiditySwapEventCount' | 'liquidityTransferCount'
  >
) => 'unknown' | 'failed' | 'success';

export function registerExecutionRoutes({
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
}: RegisterExecutionRoutesDependencies) {
  app.post('/api/v1/executions/preview', async (request, response) => {
    const strategyId = String(request.body.strategy_id ?? '');
    const state = getState();
    const ownerKey = resolveAnnotationOwnerKey(request, response);
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to preview executions');
    }
    const annotation = state.annotations.find((item) => item.strategy.strategyId === strategyId && item.ownerKey === ownerKey);
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
    const { sessionId, walletAddress } = getRequestContext(response);
    if (!walletAddress) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to access executions');
    }

    const executions = executionRepository.list().filter((execution) => {
      if (execution.sessionId !== sessionId) {
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
    const { sessionId, walletAddress } = getRequestContext(response);
    if (!walletAddress) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to access executions');
    }
    const execution = executionRepository.getById(executionId);

    if (!execution) {
      return sendError(response, 'NOT_FOUND', 'execution not found');
    }

    if (execution.sessionId !== sessionId) {
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
    const { sessionId, walletAddress } = getRequestContext(response);
    if (!walletAddress) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to access executions');
    }
    const execution = executionRepository.getById(executionId);

    if (!execution) {
      return sendError(response, 'NOT_FOUND', 'execution not found');
    }

    if (execution.sessionId !== sessionId) {
      return sendError(response, 'NOT_FOUND', 'execution not found');
    }

    const state = getState();
    const annotation = state.annotations.find(
      (item) => item.strategy.strategyId === execution.strategyId && item.ownerKey === `wallet:${walletAddress}`
    );
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
      const { requestId, sessionId, walletAddress } = getRequestContext(response);
      if (!walletAddress) {
        return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to execute strategies');
      }
      const state = getState();
      const annotation = state.annotations.find(
        (item) => item.strategy.strategyId === strategyId && item.ownerKey === `wallet:${walletAddress}`
      );
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
          item.annotationId === annotation.annotationId ? { ...item, status: 'Executed', updatedAt: new Date().toISOString() } : item
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
      return sendSuccess(
        response,
        toExecutionResponse({
          ...persistedExecution,
          proofState
        })
      );
    } catch (error) {
      const { requestId, sessionId, walletAddress } = getRequestContext(response);
      logError('execution_request_failed', {
        requestId,
        ...(sessionId ? { sessionId } : {}),
        ...(walletAddress ? { walletAddress } : {}),
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
    if (!ownerKey) {
      return sendError(response, 'AUTH_REQUIRED', 'connect a wallet to execute strategies');
    }
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
        item.annotationId === annotation.annotationId ? { ...item, status: nextAnnotationStatus, updatedAt: nextUpdatedAt } : item
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
      annotation: { ...annotation, status: nextAnnotationStatus, updatedAt: nextUpdatedAt },
      execution: toExecutionResponse(persistedExecution)
    });
  });
}
