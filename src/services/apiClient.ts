import type {
  Annotation,
  AuditEvent,
  AutomationRule,
  Candle,
  DelegatedAutomationConfig,
  DelegatedAutomationPolicy,
  Execution,
  ExecutionPlan,
  MarketOption,
  NewsInsight,
  NotificationItem,
  StrategyValidation
} from '../types/domain';
import { normalizeTxHash } from '../utils/txHash';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';
const OPBNB_EXPLORER_BASE_URL = import.meta.env.VITE_OPBNB_EXPLORER_BASE_URL ?? 'https://opbnb-testnet.bscscan.com';
const CLIENT_SESSION_STORAGE_KEY = 'scribble.clientSessionId';
const CLIENT_WALLET_STORAGE_KEY = 'scribble.clientWalletAddress';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

async function request<T>(path: string, init?: RequestInit) {
  const sessionId = getClientSessionId();
  const walletAddress = getClientWalletAddress();
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { 'X-Session-Id': sessionId } : {}),
      ...(walletAddress ? { 'X-Wallet-Address': walletAddress } : {}),
      ...(init?.headers ?? {})
    },
    ...init
  });

  const payload = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !payload.success) {
    throw new Error(payload.error?.message ?? 'API request failed');
  }
  return payload.data;
}

function getClientSessionId() {
  if (typeof window === 'undefined') {
    return null;
  }

  const stored = window.localStorage.getItem(CLIENT_SESSION_STORAGE_KEY);
  if (stored && /^[A-Za-z0-9._:-]{1,64}$/.test(stored)) {
    return stored;
  }

  const nextSessionId =
    typeof window.crypto?.randomUUID === 'function'
      ? `web-${window.crypto.randomUUID()}`
      : `web-${Math.random().toString(36).slice(2, 12)}`;

  if (/^[A-Za-z0-9._:-]{1,64}$/.test(nextSessionId)) {
    window.localStorage.setItem(CLIENT_SESSION_STORAGE_KEY, nextSessionId);
    return nextSessionId;
  }

  return null;
}

function getClientWalletAddress() {
  if (typeof window === 'undefined') {
    return null;
  }

  const stored = window.localStorage.getItem(CLIENT_WALLET_STORAGE_KEY)?.trim().toLowerCase() ?? null;
  if (stored && /^0x[a-f0-9]{40}$/.test(stored)) {
    return stored;
  }

  return null;
}

export function setClientWalletAddress(address: string | null) {
  if (typeof window === 'undefined') {
    return;
  }

  if (address && /^0x[a-fA-F0-9]{40}$/.test(address)) {
    window.localStorage.setItem(CLIENT_WALLET_STORAGE_KEY, address.toLowerCase());
    return;
  }

  window.localStorage.removeItem(CLIENT_WALLET_STORAGE_KEY);
}

function normalizeAnnotation(annotation: Annotation) {
  return annotation;
}

export async function getHealth() {
  return request<{
    ok: boolean;
    llmConfigured: boolean;
    marketDataEnabled?: boolean;
    marketDataProvider?: 'binance' | 'mock';
    onchainConfigured?: boolean;
    dexConfigured?: boolean;
    hyperliquidConfigured?: boolean;
    delegatedAutomationConfigured?: boolean;
    delegatedExecutorAddress?: string | null;
    delegationVaultAddress?: string | null;
  }>('/api/v1/health');
}

function normalizeDelegatedPolicy(policy: DelegatedAutomationPolicy) {
  return {
    ...policy,
    approvalTxHash: normalizeTxHash(policy.approvalTxHash)
  };
}

export async function getDelegationConfig() {
  return request<DelegatedAutomationConfig>('/api/v1/delegations/config');
}

export async function getDelegationPolicies(filters?: { ownerAddress?: string; strategyId?: string }) {
  const query = new URLSearchParams();
  if (filters?.ownerAddress) query.set('owner_address', filters.ownerAddress);
  if (filters?.strategyId) query.set('strategy_id', filters.strategyId);
  const data = await request<{
    policies: DelegatedAutomationPolicy[];
    ready: boolean;
    executorAddress: string | null;
    vaultAddress: string | null;
    missing: string[];
  }>(`/api/v1/delegations${query.toString() ? `?${query.toString()}` : ''}`);

  return {
    policies: data.policies.map(normalizeDelegatedPolicy),
    config: {
      ready: data.ready,
      executorAddress: data.executorAddress,
      vaultAddress: data.vaultAddress,
      missing: data.missing
    } satisfies DelegatedAutomationConfig
  };
}

export async function createDelegationPolicy(input: {
  strategyId: string;
  ownerAddress: string;
  marketSymbol: string;
  maxOrderSizeUsd: number;
  maxSlippageBps: number;
  dailyLossLimitUsd: number;
  validUntil: string;
  approvalTxHash?: string | null;
}) {
  if (input.approvalTxHash && !normalizeTxHash(input.approvalTxHash)) {
    throw new Error('Approval transaction hashes must be 64-character hex strings starting with 0x.');
  }

  const data = await request<{
    policy: DelegatedAutomationPolicy;
    executor_address: string | null;
    vault_address: string | null;
    ready: boolean;
  }>('/api/v1/delegations', {
    method: 'POST',
    body: JSON.stringify({
      strategy_id: input.strategyId,
      owner_address: input.ownerAddress,
      market_symbol: input.marketSymbol,
      max_order_size_usd: input.maxOrderSizeUsd,
      max_slippage_bps: input.maxSlippageBps,
      daily_loss_limit_usd: input.dailyLossLimitUsd,
      valid_until: input.validUntil,
      approval_tx_hash: input.approvalTxHash ?? null
    })
  });

  return {
    policy: normalizeDelegatedPolicy(data.policy),
    config: {
      ready: data.ready,
      executorAddress: data.executor_address,
      vaultAddress: data.vault_address,
      missing: []
    } satisfies DelegatedAutomationConfig
  };
}

export async function getMarkets() {
  const data = await request<{ markets: MarketOption[] }>('/api/v1/markets');
  return data.markets;
}

export async function getCandles(symbol: string, timeframe: string) {
  const data = await request<{ symbol: string; timeframe: string; source?: 'binance' | 'mock'; candles: Array<{ open_time: string; open: string; high: string; low: string; close: string; volume: string; }>; }>(`/api/v1/market-data/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`);
  return data.candles.map<Candle>((candle) => ({
    openTime: candle.open_time,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume)
  }));
}

export async function getAnnotations(symbol: string, timeframe: string) {
  const data = await request<{ annotations: Annotation[] }>(`/api/v1/annotations?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`);
  return data.annotations.map(normalizeAnnotation);
}

function normalizeExecution(execution: {
  execution_id: string;
  strategy_id: string;
  action_type?: Execution['actionType'];
  close_mode?: Execution['closeMode'];
  status: Execution['status'];
  execution_chain: Execution['executionChain'];
  liquidity_chain: Execution['liquidityChain'];
  execution_chain_tx_hash: string | null;
  liquidity_chain_tx_hash: string | null;
  execution_chain_tx_status?: Execution['executionChainTxStatus'];
  liquidity_chain_tx_status?: Execution['liquidityChainTxStatus'];
  execution_chain_block_number?: number | null;
  liquidity_chain_block_number?: number | null;
  execution_chain_log_count?: number | null;
  liquidity_chain_log_count?: number | null;
  liquidity_transfer_count?: number | null;
  liquidity_swap_event_count?: number | null;
  liquidity_touched_contract_count?: number | null;
  liquidity_settlement_state?: Execution['liquiditySettlementState'];
  execution_chain_checked_at?: string | null;
  liquidity_chain_checked_at?: string | null;
  execution_chain_tx_hash_valid?: boolean;
  liquidity_chain_tx_hash_valid?: boolean;
  tx_hash_warning?: string | null;
  settlement_mode?: Execution['settlementMode'];
  dex_executed?: boolean;
  execution_tx_state?: Execution['executionTxState'];
  liquidity_receipt_evidence?: Execution['liquidityReceiptEvidence'];
  dex_router_address?: string | null;
  dex_input_token_address?: string | null;
  dex_output_token_address?: string | null;
  dex_amount_in?: string | null;
  dex_expected_amount_out?: string | null;
  dex_minimum_amount_out?: string | null;
  external_venue?: Execution['externalVenue'];
  external_order_id?: string | null;
  external_client_order_id?: string | null;
  executed_quantity?: string | null;
  leverage_used?: number | null;
  proof_attempted?: boolean;
  proof_retry_count?: number;
  proof_error_message?: string | null;
  proof_recorded?: boolean;
  proof_state?: Execution['proofState'];
  proof_registry_id?: string | null;
  proof_contract_address?: string | null;
  filled_price?: number | null;
  filled_at?: string | null;
}): Execution {
  return {
    executionId: execution.execution_id,
    strategyId: execution.strategy_id,
    actionType: execution.action_type ?? 'open',
    closeMode: execution.close_mode ?? null,
    status: execution.status,
    executionChain: execution.execution_chain,
    liquidityChain: execution.liquidity_chain,
    executionChainTxHash: execution.execution_chain_tx_hash,
    liquidityChainTxHash: execution.liquidity_chain_tx_hash,
    executionChainTxStatus: execution.execution_chain_tx_status,
    liquidityChainTxStatus: execution.liquidity_chain_tx_status,
    executionChainBlockNumber: execution.execution_chain_block_number ?? null,
    liquidityChainBlockNumber: execution.liquidity_chain_block_number ?? null,
    executionChainLogCount: execution.execution_chain_log_count ?? null,
    liquidityChainLogCount: execution.liquidity_chain_log_count ?? null,
    liquidityTransferCount: execution.liquidity_transfer_count ?? null,
    liquiditySwapEventCount: execution.liquidity_swap_event_count ?? null,
    liquidityTouchedContractCount: execution.liquidity_touched_contract_count ?? null,
    liquiditySettlementState: execution.liquidity_settlement_state,
    executionChainCheckedAt: execution.execution_chain_checked_at ?? null,
    liquidityChainCheckedAt: execution.liquidity_chain_checked_at ?? null,
    executionChainTxHashValid: execution.execution_chain_tx_hash_valid ?? true,
    liquidityChainTxHashValid: execution.liquidity_chain_tx_hash_valid ?? true,
    txHashWarning: execution.tx_hash_warning ?? null,
    settlementMode: execution.settlement_mode,
    dexExecuted: execution.dex_executed,
    executionTxState: execution.execution_tx_state,
    liquidityReceiptEvidence: execution.liquidity_receipt_evidence,
    dexRouterAddress: execution.dex_router_address ?? null,
    dexInputTokenAddress: execution.dex_input_token_address ?? null,
    dexOutputTokenAddress: execution.dex_output_token_address ?? null,
    dexAmountIn: execution.dex_amount_in ?? null,
    dexExpectedAmountOut: execution.dex_expected_amount_out ?? null,
    dexMinimumAmountOut: execution.dex_minimum_amount_out ?? null,
    externalVenue: execution.external_venue,
    externalOrderId: execution.external_order_id ?? null,
    externalClientOrderId: execution.external_client_order_id ?? null,
    executedQuantity: execution.executed_quantity ?? null,
    leverageUsed: execution.leverage_used ?? null,
    proofAttempted: execution.proof_attempted,
    proofRetryCount: execution.proof_retry_count,
    proofErrorMessage: execution.proof_error_message ?? null,
    proofRecorded: execution.proof_recorded,
    proofState: execution.proof_state,
    proofRegistryId: execution.proof_registry_id ?? null,
    proofContractAddress: execution.proof_contract_address ?? null,
    filledPrice: execution.filled_price ?? undefined,
    filledAt: execution.filled_at ?? undefined
  };
}

export async function getExecutions(symbol?: string, timeframe?: string) {
  const query = new URLSearchParams();
  if (symbol) query.set('symbol', symbol);
  if (timeframe) query.set('timeframe', timeframe);
  const data = await request<{
    executions: Array<{
      execution_id: string;
      strategy_id: string;
      action_type?: Execution['actionType'];
      close_mode?: Execution['closeMode'];
      status: Execution['status'];
      execution_chain: Execution['executionChain'];
      liquidity_chain: Execution['liquidityChain'];
      execution_chain_tx_hash: string | null;
      liquidity_chain_tx_hash: string | null;
      execution_chain_tx_status?: Execution['executionChainTxStatus'];
      liquidity_chain_tx_status?: Execution['liquidityChainTxStatus'];
      execution_chain_block_number?: number | null;
      liquidity_chain_block_number?: number | null;
      execution_chain_log_count?: number | null;
      liquidity_chain_log_count?: number | null;
      liquidity_transfer_count?: number | null;
      liquidity_swap_event_count?: number | null;
      liquidity_touched_contract_count?: number | null;
      liquidity_settlement_state?: Execution['liquiditySettlementState'];
      execution_chain_checked_at?: string | null;
      liquidity_chain_checked_at?: string | null;
      execution_chain_tx_hash_valid?: boolean;
      liquidity_chain_tx_hash_valid?: boolean;
      tx_hash_warning?: string | null;
      settlement_mode?: Execution['settlementMode'];
      dex_executed?: boolean;
      execution_tx_state?: Execution['executionTxState'];
      liquidity_receipt_evidence?: Execution['liquidityReceiptEvidence'];
      dex_router_address?: string | null;
      dex_input_token_address?: string | null;
      dex_output_token_address?: string | null;
      dex_amount_in?: string | null;
      dex_expected_amount_out?: string | null;
      dex_minimum_amount_out?: string | null;
      external_venue?: Execution['externalVenue'];
      external_order_id?: string | null;
      external_client_order_id?: string | null;
      executed_quantity?: string | null;
      leverage_used?: number | null;
      proof_attempted?: boolean;
      proof_retry_count?: number;
      proof_error_message?: string | null;
      proof_recorded?: boolean;
      proof_state?: Execution['proofState'];
      proof_registry_id?: string | null;
      proof_contract_address?: string | null;
      filled_price?: number | null;
      filled_at?: string | null;
    }>;
  }>(`/api/v1/executions${query.toString() ? `?${query.toString()}` : ''}`);
  return data.executions.map(normalizeExecution);
}

export async function createAnnotation(input: { marketSymbol: string; timeframe: string; text: string; chartAnchor: { time: string; price: number; index: number; }; visibility?: 'private' | 'public' | 'unlisted'; }) {
  const data = await request<{ annotation: Annotation; parsing_notes: string[] }>(`/api/v1/annotations`, {
    method: 'POST',
    body: JSON.stringify({
      market_symbol: input.marketSymbol,
      timeframe: input.timeframe,
      text: input.text,
      chart_anchor: input.chartAnchor,
      visibility: input.visibility ?? 'private'
    })
  });
  return data;
}

export async function updateAnnotation(annotationId: string, input: {
  text?: string;
  bias?: Annotation['strategy']['bias'];
  entryType?: Annotation['strategy']['entryType'];
  entryPrice?: number;
  stopLossPrice?: number;
  takeProfitPrices?: number[];
  invalidationCondition?: string;
  confidence?: number;
  riskLevel?: Annotation['strategy']['riskLevel'];
  positionSizeRatio?: number;
  leverage?: number;
  autoExecuteEnabled?: boolean;
  drawingObjects?: Annotation['drawingObjects'];
}) {
  const data = await request<{ annotation: Annotation; parsing_notes: string[] }>(`/api/v1/annotations/${annotationId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      text: input.text,
      bias: input.bias,
      entry_type: input.entryType,
      entry_price: input.entryPrice,
      stop_loss_price: input.stopLossPrice,
      take_profit_prices: input.takeProfitPrices,
      invalidation_condition: input.invalidationCondition,
      confidence: input.confidence,
      risk_level: input.riskLevel,
      position_size_ratio: input.positionSizeRatio,
      leverage: input.leverage,
      auto_execute_enabled: input.autoExecuteEnabled,
      drawing_objects: input.drawingObjects
    })
  });
  return data;
}

export async function analyzeChart(input: { marketSymbol: string; timeframe: string; riskLevel: 'conservative' | 'balanced' | 'aggressive'; defaultPositionSizeRatio: number; leverage: number; }) {
  const data = await request<{ annotation: Annotation; strategy: Annotation['strategy']; provider: 'openai' | 'fallback' }>(`/api/v1/ai/analyze`, {
    method: 'POST',
    body: JSON.stringify({
      market_symbol: input.marketSymbol,
      timeframe: input.timeframe,
      user_preferences: {
        risk_level: input.riskLevel,
        default_position_size_ratio: input.defaultPositionSizeRatio,
        leverage: input.leverage
      }
    })
  });
  return data;
}

export async function fetchNewsInsights(input: { marketSymbol: string; timeframe: string; threshold?: number }) {
  const data = await request<{ insights: NewsInsight[]; provider: 'openai' | 'fallback' }>('/api/v1/ai/news-insights', {
    method: 'POST',
    body: JSON.stringify({
      market_symbol: input.marketSymbol,
      timeframe: input.timeframe,
      ...(input.threshold !== undefined ? { threshold: input.threshold } : {})
    })
  });
  return data;
}

export async function validateStrategyApi(strategyId: string) {
  const data = await request<{ is_valid: boolean; violations: string[]; risk_summary: { max_loss_ratio: number; max_loss_amount: number; risk_reward_ratio: number; estimated_liquidation_risk: 'low' | 'medium' | 'high'; }; }>(`/api/v1/strategies/${strategyId}/validate`, { method: 'POST' });
  const validation: StrategyValidation = {
    isValid: data.is_valid,
    violations: data.violations,
    riskSummary: {
      maxLossRatio: data.risk_summary.max_loss_ratio,
      maxLossAmount: data.risk_summary.max_loss_amount,
      riskRewardRatio: data.risk_summary.risk_reward_ratio,
      liquidationRisk: data.risk_summary.estimated_liquidation_risk
    }
  };
  return validation;
}

export async function previewExecution(strategyId: string) {
  const data = await request<{ execution_plan: { execution_chain: string; liquidity_chain: string; entry_price: string; position_size: string; estimated_slippage: string; estimated_fee: string; guardrail_check: { passed: boolean; violations: string[]; }; }; }>(`/api/v1/executions/preview`, {
    method: 'POST',
    body: JSON.stringify({ strategy_id: strategyId })
  });
  const plan: ExecutionPlan = {
    executionChain: data.execution_plan.execution_chain,
    liquidityChain: data.execution_plan.liquidity_chain,
    entryPrice: Number(data.execution_plan.entry_price),
    positionSize: Number(data.execution_plan.position_size),
    estimatedSlippage: Number(data.execution_plan.estimated_slippage),
    estimatedFee: Number(data.execution_plan.estimated_fee),
    guardrailCheck: data.execution_plan.guardrail_check
  };
  return plan;
}

export async function createExecution(strategyId: string) {
  const data = await request<{
    execution_id: string;
    action_type?: Execution['actionType'];
    close_mode?: Execution['closeMode'];
    status: Execution['status'];
    execution_chain?: Execution['executionChain'];
    liquidity_chain?: Execution['liquidityChain'];
    execution_chain_tx_hash: string | null;
    liquidity_chain_tx_hash: string | null;
    execution_chain_tx_status?: Execution['executionChainTxStatus'];
    liquidity_chain_tx_status?: Execution['liquidityChainTxStatus'];
    execution_chain_block_number?: number | null;
    liquidity_chain_block_number?: number | null;
    execution_chain_log_count?: number | null;
    liquidity_chain_log_count?: number | null;
    liquidity_transfer_count?: number | null;
    liquidity_swap_event_count?: number | null;
    liquidity_touched_contract_count?: number | null;
    liquidity_settlement_state?: Execution['liquiditySettlementState'];
    execution_chain_checked_at?: string | null;
    liquidity_chain_checked_at?: string | null;
    execution_chain_tx_hash_valid?: boolean;
    liquidity_chain_tx_hash_valid?: boolean;
    tx_hash_warning?: string | null;
    settlement_mode?: Execution['settlementMode'];
    dex_executed?: boolean;
    execution_tx_state?: Execution['executionTxState'];
    liquidity_receipt_evidence?: Execution['liquidityReceiptEvidence'];
    dex_router_address: string | null;
    dex_input_token_address?: string | null;
    dex_output_token_address?: string | null;
    dex_amount_in?: string | null;
    dex_expected_amount_out?: string | null;
    dex_minimum_amount_out?: string | null;
    external_venue?: Execution['externalVenue'];
    external_order_id?: string | null;
    external_client_order_id?: string | null;
    executed_quantity?: string | null;
    leverage_used?: number | null;
    proof_attempted?: boolean;
    proof_retry_count?: number;
    proof_error_message?: string | null;
    proof_recorded: boolean;
    proof_state?: Execution['proofState'];
    proof_registry_id: string | null;
    proof_contract_address: string | null;
  }>(`/api/v1/executions`, {
    method: 'POST',
    body: JSON.stringify({ strategy_id: strategyId, mode: 'manual_confirmed' })
  });
  return normalizeExecution({
    ...data,
    strategy_id: strategyId,
    execution_chain: data.execution_chain ?? 'opbnb',
    liquidity_chain: data.liquidity_chain ?? 'bsc',
    filled_price: null,
    filled_at: null
  });
}

export async function recordDirectExecution(
  strategyId: string,
  input: {
    walletAddress: string;
    entryType: 'market' | 'limit' | 'conditional';
    receipt: {
      executionChain: Execution['executionChain'];
      liquidityChain: Execution['liquidityChain'];
      settlementMode: NonNullable<Execution['settlementMode']>;
      externalVenue: NonNullable<Execution['externalVenue']>;
      externalOrderId: string | null;
      externalClientOrderId: string | null;
      leverageUsed: number;
      executedQuantity: string;
      side: 'BUY' | 'SELL';
      reduceOnly: boolean;
      status: Execution['status'];
      filledPrice: number | null;
      filledAt: string;
    };
  }
) {
  const data = await request<{
    annotation: Annotation;
    execution: {
      execution_id: string;
      action_type?: Execution['actionType'];
      close_mode?: Execution['closeMode'];
      status: Execution['status'];
      execution_chain?: Execution['executionChain'];
      liquidity_chain?: Execution['liquidityChain'];
      execution_chain_tx_hash: string | null;
      liquidity_chain_tx_hash: string | null;
      execution_chain_tx_status?: Execution['executionChainTxStatus'];
      liquidity_chain_tx_status?: Execution['liquidityChainTxStatus'];
      execution_chain_block_number?: number | null;
      liquidity_chain_block_number?: number | null;
      execution_chain_log_count?: number | null;
      liquidity_chain_log_count?: number | null;
      liquidity_transfer_count?: number | null;
      liquidity_swap_event_count?: number | null;
      liquidity_touched_contract_count?: number | null;
      liquidity_settlement_state?: Execution['liquiditySettlementState'];
      execution_chain_checked_at?: string | null;
      liquidity_chain_checked_at?: string | null;
      execution_chain_tx_hash_valid?: boolean;
      liquidity_chain_tx_hash_valid?: boolean;
      tx_hash_warning?: string | null;
      settlement_mode?: Execution['settlementMode'];
      dex_executed?: boolean;
      execution_tx_state?: Execution['executionTxState'];
      liquidity_receipt_evidence?: Execution['liquidityReceiptEvidence'];
      dex_router_address: string | null;
      dex_input_token_address?: string | null;
      dex_output_token_address?: string | null;
      dex_amount_in?: string | null;
      dex_expected_amount_out?: string | null;
      dex_minimum_amount_out?: string | null;
      external_venue?: Execution['externalVenue'];
      external_order_id?: string | null;
      external_client_order_id?: string | null;
      executed_quantity?: string | null;
      leverage_used?: number | null;
      proof_attempted?: boolean;
      proof_retry_count?: number;
      proof_error_message?: string | null;
      proof_recorded: boolean;
      proof_state?: Execution['proofState'];
      proof_registry_id: string | null;
      proof_contract_address: string | null;
      filled_price?: number | null;
      filled_at?: string | null;
    };
  }>(`/api/v1/executions/direct`, {
    method: 'POST',
    body: JSON.stringify({
      strategy_id: strategyId,
      wallet_address: input.walletAddress,
      entry_type: input.entryType,
      receipt: {
        execution_chain: input.receipt.executionChain,
        liquidity_chain: input.receipt.liquidityChain,
        settlement_mode: input.receipt.settlementMode,
        external_venue: input.receipt.externalVenue,
        external_order_id: input.receipt.externalOrderId,
        external_client_order_id: input.receipt.externalClientOrderId,
        leverage_used: input.receipt.leverageUsed,
        executed_quantity: input.receipt.executedQuantity,
        side: input.receipt.side,
        reduce_only: input.receipt.reduceOnly,
        status: input.receipt.status,
        filled_price: input.receipt.filledPrice,
        filled_at: input.receipt.filledAt
      }
    })
  });

  return {
    annotation: data.annotation,
    execution: normalizeExecution({
      ...data.execution,
      strategy_id: strategyId,
      execution_chain: data.execution.execution_chain ?? input.receipt.executionChain,
      liquidity_chain: data.execution.liquidity_chain ?? input.receipt.liquidityChain,
      filled_price: data.execution.filled_price ?? input.receipt.filledPrice,
      filled_at: data.execution.filled_at ?? input.receipt.filledAt
    })
  };
}

export async function cancelOrder(annotationId: string) {
  const data = await request<{ annotation: Annotation }>(`/api/v1/annotations/${annotationId}/cancel-order`, {
    method: 'POST'
  });
  return data.annotation;
}

export async function closePosition(annotationId: string, input: { mode: 'market' | 'price'; closePrice?: number }) {
  const data = await request<{
    annotation: Annotation;
    execution: {
      execution_id: string;
      strategy_id: string;
      action_type?: Execution['actionType'];
      close_mode?: Execution['closeMode'];
      status: Execution['status'];
      execution_chain: Execution['executionChain'];
      liquidity_chain: Execution['liquidityChain'];
      execution_chain_tx_hash: string | null;
      liquidity_chain_tx_hash: string | null;
      execution_chain_tx_status?: Execution['executionChainTxStatus'];
      liquidity_chain_tx_status?: Execution['liquidityChainTxStatus'];
      execution_chain_block_number?: number | null;
      liquidity_chain_block_number?: number | null;
      execution_chain_log_count?: number | null;
      liquidity_chain_log_count?: number | null;
      liquidity_transfer_count?: number | null;
      liquidity_swap_event_count?: number | null;
      liquidity_touched_contract_count?: number | null;
      liquidity_settlement_state?: Execution['liquiditySettlementState'];
      execution_chain_checked_at?: string | null;
      liquidity_chain_checked_at?: string | null;
      execution_chain_tx_hash_valid?: boolean;
      liquidity_chain_tx_hash_valid?: boolean;
      tx_hash_warning?: string | null;
      settlement_mode?: Execution['settlementMode'];
      dex_executed?: boolean;
      execution_tx_state?: Execution['executionTxState'];
      liquidity_receipt_evidence?: Execution['liquidityReceiptEvidence'];
      dex_router_address?: string | null;
      dex_input_token_address?: string | null;
      dex_output_token_address?: string | null;
      dex_amount_in?: string | null;
      dex_expected_amount_out?: string | null;
      dex_minimum_amount_out?: string | null;
      external_venue?: Execution['externalVenue'];
      external_order_id?: string | null;
      external_client_order_id?: string | null;
      executed_quantity?: string | null;
      leverage_used?: number | null;
      proof_attempted?: boolean;
      proof_retry_count?: number;
      proof_error_message?: string | null;
      proof_recorded?: boolean;
      proof_state?: Execution['proofState'];
      proof_registry_id?: string | null;
      proof_contract_address?: string | null;
      filled_price?: number | null;
      filled_at?: string | null;
    };
  }>(`/api/v1/annotations/${annotationId}/close-position`, {
    method: 'POST',
    body: JSON.stringify({
      mode: input.mode,
      close_price: input.mode === 'price' ? input.closePrice : undefined
    })
  });

  return {
    annotation: data.annotation,
    execution: normalizeExecution(data.execution)
  };
}

export async function recordDirectClosePosition(
  annotationId: string,
  input: {
    mode: 'market' | 'price';
    walletAddress: string;
    receipt: {
      executionChain: Execution['executionChain'];
      liquidityChain: Execution['liquidityChain'];
      settlementMode: NonNullable<Execution['settlementMode']>;
      externalVenue: NonNullable<Execution['externalVenue']>;
      externalOrderId: string | null;
      externalClientOrderId: string | null;
      leverageUsed: number;
      executedQuantity: string;
      side: 'BUY' | 'SELL';
      reduceOnly: boolean;
      status: Execution['status'];
      filledPrice: number | null;
      filledAt: string;
    };
  }
) {
  const data = await request<{
    annotation: Annotation;
    execution: {
      execution_id: string;
      strategy_id: string;
      action_type?: Execution['actionType'];
      close_mode?: Execution['closeMode'];
      status: Execution['status'];
      execution_chain: Execution['executionChain'];
      liquidity_chain: Execution['liquidityChain'];
      execution_chain_tx_hash: string | null;
      liquidity_chain_tx_hash: string | null;
      execution_chain_tx_status?: Execution['executionChainTxStatus'];
      liquidity_chain_tx_status?: Execution['liquidityChainTxStatus'];
      execution_chain_block_number?: number | null;
      liquidity_chain_block_number?: number | null;
      execution_chain_log_count?: number | null;
      liquidity_chain_log_count?: number | null;
      liquidity_transfer_count?: number | null;
      liquidity_swap_event_count?: number | null;
      liquidity_touched_contract_count?: number | null;
      liquidity_settlement_state?: Execution['liquiditySettlementState'];
      execution_chain_checked_at?: string | null;
      liquidity_chain_checked_at?: string | null;
      execution_chain_tx_hash_valid?: boolean;
      liquidity_chain_tx_hash_valid?: boolean;
      tx_hash_warning?: string | null;
      settlement_mode?: Execution['settlementMode'];
      dex_executed?: boolean;
      execution_tx_state?: Execution['executionTxState'];
      liquidity_receipt_evidence?: Execution['liquidityReceiptEvidence'];
      dex_router_address?: string | null;
      dex_input_token_address?: string | null;
      dex_output_token_address?: string | null;
      dex_amount_in?: string | null;
      dex_expected_amount_out?: string | null;
      dex_minimum_amount_out?: string | null;
      external_venue?: Execution['externalVenue'];
      external_order_id?: string | null;
      external_client_order_id?: string | null;
      executed_quantity?: string | null;
      leverage_used?: number | null;
      proof_attempted?: boolean;
      proof_retry_count?: number;
      proof_error_message?: string | null;
      proof_recorded?: boolean;
      proof_state?: Execution['proofState'];
      proof_registry_id?: string | null;
      proof_contract_address?: string | null;
      filled_price?: number | null;
      filled_at?: string | null;
    };
  }>(`/api/v1/annotations/${annotationId}/close-position/direct`, {
    method: 'POST',
    body: JSON.stringify({
      mode: input.mode,
      wallet_address: input.walletAddress,
      receipt: {
        execution_chain: input.receipt.executionChain,
        liquidity_chain: input.receipt.liquidityChain,
        settlement_mode: input.receipt.settlementMode,
        external_venue: input.receipt.externalVenue,
        external_order_id: input.receipt.externalOrderId,
        external_client_order_id: input.receipt.externalClientOrderId,
        leverage_used: input.receipt.leverageUsed,
        executed_quantity: input.receipt.executedQuantity,
        side: input.receipt.side,
        reduce_only: input.receipt.reduceOnly,
        status: input.receipt.status,
        filled_price: input.receipt.filledPrice,
        filled_at: input.receipt.filledAt
      }
    })
  });

  return {
    annotation: data.annotation,
    execution: normalizeExecution(data.execution)
  };
}

export function getOpbnbTxUrl(txHash: string | null | undefined) {
  return txHash ? `${OPBNB_EXPLORER_BASE_URL}/tx/${txHash}` : '#';
}

export function getOpbnbAddressUrl(address: string) {
  return `${OPBNB_EXPLORER_BASE_URL}/address/${address}`;
}

export async function createAutomation(strategyId: string, config: { maxPositionSizeRatio: number; maxLeverage: number; maxLossRatio: number; maxDailyExecutions: number; }) {
  const data = await request<{ automation_id: string; status: AutomationRule['status'] }>(`/api/v1/automations`, {
    method: 'POST',
    body: JSON.stringify({
      strategy_id: strategyId,
      enabled: true,
      guardrails: {
        max_position_size_ratio: config.maxPositionSizeRatio,
        max_leverage: config.maxLeverage,
        max_loss_ratio: config.maxLossRatio,
        max_daily_executions: config.maxDailyExecutions
      }
    })
  });
  return data;
}

export async function createAlert(annotationId: string, value: number) {
  return request<{ notification: NotificationItem }>(`/api/v1/alerts`, {
    method: 'POST',
    body: JSON.stringify({
      annotation_id: annotationId,
      type: 'price_touch',
      value: String(value),
      channels: ['in_app']
    })
  });
}

export async function getNotifications() {
  const data = await request<{ notifications: NotificationItem[] }>(`/api/v1/notifications`);
  return data.notifications;
}

export async function getAuditLogs(filters?: { annotationId?: string; strategyId?: string; executionId?: string }) {
  const query = new URLSearchParams();
  if (filters?.annotationId) query.set('annotation_id', filters.annotationId);
  if (filters?.strategyId) query.set('strategy_id', filters.strategyId);
  if (filters?.executionId) query.set('execution_id', filters.executionId);
  const data = await request<{ events: AuditEvent[] }>(`/api/v1/audit-logs${query.toString() ? `?${query.toString()}` : ''}`);
  return data.events;
}

export function subscribeMarketStream(
  symbol: string,
  timeframe: string,
  handlers: {
    onMessage: (payload: {
      symbol: string;
      timeframe: string;
      source: 'binance' | 'mock';
      current_price: number;
      candles: Array<{ open_time: string; open: string; high: string; low: string; close: string; volume: string; }>;
    }) => void;
    onError?: () => void;
  }
) {
  const streamUrl = new URL(`/api/v1/market-data/stream?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`, API_BASE_URL).toString();
  const eventSource = new EventSource(streamUrl);

  eventSource.onmessage = (event) => {
    handlers.onMessage(JSON.parse(event.data) as {
      symbol: string;
      timeframe: string;
      source: 'binance' | 'mock';
      current_price: number;
      candles: Array<{ open_time: string; open: string; high: string; low: string; close: string; volume: string; }>;
    });
  };

  eventSource.onerror = () => {
    handlers.onError?.();
  };

  return () => {
    eventSource.close();
  };
}
